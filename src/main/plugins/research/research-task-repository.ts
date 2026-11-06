import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  researchTaskSchema, researchTaskExecutionSchema, researchTaskEventSchema, researchTaskEventsPageSchema, researchTaskListPageSchema,
  type ResearchTask, type ResearchTaskExecution
} from '../../../shared/schemas/research-tasks';
import type { ResearchStageRun } from '../../../shared/types';
import type { ConsumedResearchDispatchGrant } from '../../services/deep-agent/execution-grant-broker';
import { assertResearchDispatchGrant, assertReviewSearchDispatchGrant,
  type ConsumedReviewSearchDispatchGrant } from '../../services/deep-agent/execution-grant-broker';
import { researchDispatchRequestHash } from '../../services/research-dispatch-context';
import {reviewSearchDispatchRequestHash} from '../../services/research-review-dispatch-context';
import type {ResearchReviewSearchSnapshot, ResearchReviewSearchOwnership} from '../../../shared/schemas/research-review-search';
import { runBudgetSchema, runExecutionSnapshotSchema } from '../../../shared/schemas/agent';
import { createRunBudget } from '../agent/run-execution-snapshot';
import type { RunLimits } from '../../services/deep-agent/run-budget-ledger';
import { ProjectBudgetLedger } from '../../services/deep-agent/project-budget-ledger';
import {ResearchTaskObservabilityStore} from './task-observability-store';
import {ResearchTaskFactsStore} from './task-facts-store';

type ExecutionIdentity = Pick<ResearchTaskExecution, 'kind' | 'executionId'>;
type ExecutionInput = Omit<ResearchTaskExecution, 'schemaVersion' | 'createdAt'>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Task identity and accounting share the agent database. Domain runs keep their own storage. */
export class ResearchTaskRepository {
  readonly projectBudgets: ProjectBudgetLedger;
  readonly facts: ResearchTaskFactsStore;
  readonly observability: ResearchTaskObservabilityStore;
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {
    this.projectBudgets = new ProjectBudgetLedger(db);
    this.facts = new ResearchTaskFactsStore(db);
    this.observability = new ResearchTaskObservabilityStore(db);
  }

  get(id: string, projectId: string): ResearchTask {
    const row = this.db.prepare('SELECT snapshot_json FROM research_tasks WHERE id = ?').get(id) as { snapshot_json: string } | undefined;
    if (row === undefined) throw new Error('research_task_not_found');
    const task = researchTaskSchema.parse(JSON.parse(row.snapshot_json));
    if (task.projectId !== projectId) throw new Error('research_task_project_mismatch');
    return task;
  }

  list(request: { projectId: string; afterTaskId: string | null; limit: number }) {
    let cursor: number | null = null;
    if (request.afterTaskId !== null) {
      this.get(request.afterTaskId, request.projectId);
      cursor = (this.db.prepare('SELECT rowid FROM research_tasks WHERE id = ?')
        .get(request.afterTaskId) as { rowid: number }).rowid;
    }
    const rows = this.db.prepare(`SELECT snapshot_json FROM research_tasks
      WHERE project_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`)
      .all(request.projectId, cursor, cursor, request.limit + 1) as Array<{ snapshot_json: string }>;
    const tasks = rows.slice(0, request.limit).map(row => researchTaskSchema.parse(JSON.parse(row.snapshot_json)));
    return researchTaskListPageSchema.parse({
      tasks, nextTaskId: tasks.at(-1)?.id ?? request.afterTaskId, hasMore: rows.length > request.limit
    });
  }

  findExecution(kind: ResearchTaskExecution['kind'], executionId: string, projectId: string): ResearchTaskExecution | null {
    const row = this.db.prepare('SELECT snapshot_json FROM research_task_executions WHERE kind = ? AND execution_id = ?')
      .get(kind, executionId) as { snapshot_json: string } | undefined;
    if (row === undefined) return null;
    const execution = researchTaskExecutionSchema.parse(JSON.parse(row.snapshot_json));
    if (execution.projectId !== projectId) throw new Error('research_task_project_mismatch');
    return execution;
  }

  requireExecution(kind: ResearchTaskExecution['kind'], executionId: string, projectId: string): ResearchTaskExecution {
    const execution = this.findExecution(kind, executionId, projectId);
    if (execution === null) throw new Error('research_task_execution_unlinked');
    return execution;
  }

  budgetForExecution(kind: 'chat' | 'stage', executionId: string, projectId: string): RunLimits {
    const execution = this.requireExecution(kind, executionId, projectId);
    if (this.get(execution.taskId, projectId).status !== 'active') throw new Error('research_task_not_active');
    const row = this.db.prepare('SELECT limits_json FROM research_task_budgets WHERE task_id = ?')
      .get(execution.taskId) as { limits_json: string } | undefined;
    if (row === undefined) throw new Error('research_task_budget_missing');
    return runBudgetSchema.parse(JSON.parse(row.limits_json));
  }

  executions(taskId: string, projectId: string): ResearchTaskExecution[] {
    this.get(taskId, projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_task_executions WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as Array<{ snapshot_json: string }>).map((row) => researchTaskExecutionSchema.parse(JSON.parse(row.snapshot_json)));
  }

  events(request: { taskId: string; projectId: string; afterSequence: number; limit: number }) {
    this.get(request.taskId, request.projectId);
    const rows = this.db.prepare(`SELECT sequence,task_id taskId,event_type eventType,
      execution_kind executionKind,execution_id executionId,call_id callId,state,reason,created_at createdAt
      FROM research_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(request.taskId, request.afterSequence, request.limit + 1);
    const events = rows.slice(0, request.limit).map(row => researchTaskEventSchema.parse(row));
    return researchTaskEventsPageSchema.parse({
      events, nextSequence: events.at(-1)?.sequence ?? request.afterSequence, hasMore: rows.length > request.limit
    });
  }

  taskForChat(runId: string): ResearchTask | null {
    const row = this.db.prepare(`SELECT t.snapshot_json FROM research_task_executions e
      JOIN research_tasks t ON t.id = e.task_id WHERE e.kind = 'chat' AND e.execution_id = ?`)
      .get(runId) as { snapshot_json: string } | undefined;
    return row === undefined ? null : researchTaskSchema.parse(JSON.parse(row.snapshot_json));
  }

  taskForChatScope(request: { runId: string; threadId: string; projectId: string }): ResearchTask | null {
    const task = this.taskForChat(request.runId);
    if (task === null) return null;
    const run = this.db.prepare('SELECT thread_id FROM agent_runs WHERE id = ?')
      .get(request.runId) as { thread_id: string } | undefined;
    if (run === undefined) throw new Error('task_run_not_found');
    if (run.thread_id !== request.threadId) throw new Error('research_task_thread_mismatch');
    if (task.projectId !== request.projectId) throw new Error('research_task_project_mismatch');
    return task;
  }

  chatDiagnostics(runId: string): {
    status: string; startedAt: string | null; endedAt: string | null; providerId: string | null; modelId: string | null; error: string | null;
  } {
    const row = this.db.prepare(`SELECT r.status,r.started_at startedAt,r.ended_at endedAt,
      r.provider_id providerId,r.model_id modelId,json_extract(t.telemetry_json,'$.terminal.errorCode') error
      FROM agent_runs r LEFT JOIN agent_run_telemetry t ON t.run_id = r.id WHERE r.id = ?`)
      .get(runId) as { status: string; startedAt: string | null; endedAt: string | null;
        providerId: string | null; modelId: string | null; error: string | null } | undefined;
    if (row === undefined) throw new Error('task_run_not_found');
    return row;
  }

  reconcileInterruptedChats(): void {
    const rows = this.db.prepare(`SELECT DISTINCT t.id,t.project_id FROM research_tasks t
      JOIN research_task_executions e ON e.task_id = t.id AND e.kind = 'chat'
      JOIN agent_runs r ON r.id = e.execution_id
      WHERE r.status = 'interrupted' AND t.status = 'active'`)
      .all() as Array<{ id: string; project_id: string }>;
    for (const row of rows) this.setStatus(row.id, row.project_id, 'interrupted',
      'research_task_interrupted_by_restart', ['active']);
  }

  cancel(taskId: string, projectId: string): ResearchTask {
    return this.setStatus(taskId, projectId, 'cancelled', 'research_task_cancelled',
      ['active', 'waiting_approval', 'paused', 'interrupted', 'failed', 'cancelled']);
  }

  setStatus(taskId: string, projectId: string, status: ResearchTask['status'], reason: string | null,
    allowed: ResearchTask['status'][]): ResearchTask {
    return this.db.transaction(() => {
      const task = this.get(taskId, projectId);
      if (!allowed.includes(task.status)) throw new Error('research_task_status_conflict');
      const changed = researchTaskSchema.parse({ ...task, status, statusReason: reason, updatedAt: this.now() });
      this.db.prepare('UPDATE research_tasks SET status = ?, snapshot_json = ? WHERE id = ?')
        .run(status, JSON.stringify(changed), taskId);
      return changed;
    }).immediate();
  }

  continueWith<T>(taskId: string, projectId: string, operation: () => T): T {
    return this.db.transaction(() => {
      if (this.get(taskId, projectId).statusReason === 'research_task_cleanup_failed') {
        throw new Error('research_task_cleanup_unconfirmed');
      }
      this.setStatus(taskId, projectId, 'active', null, ['paused', 'interrupted', 'failed', 'cancelled']);
      return operation();
    }).immediate();
  }

  linkStage(run: ResearchStageRun, dispatch: ConsumedResearchDispatchGrant | null): ResearchTaskExecution {
    return this.db.transaction(() => {
      const manifestHash = digest({ policy: run.policy, skillHash: run.skillHash, toolNames: run.toolNames });
      if (dispatch !== null) {
        assertResearchDispatchGrant(dispatch);
        if (dispatch.projectId !== run.projectId) throw new Error('research_task_project_mismatch');
        if (dispatch.requestHash !== researchDispatchRequestHash({
          projectId: run.projectId, expectedStage: run.stage, instruction: run.instruction, requestId: run.requestId
        })) throw new Error('research_dispatch_request_mismatch');
        const chat = this.findExecution('chat', dispatch.runId, run.projectId);
        const task = chat === null ? this.createTask(run.projectId, run.instruction, dispatch.runId) : this.get(chat.taskId, run.projectId);
        this.link({ taskId: task.id, projectId: run.projectId, kind: 'chat', executionId: dispatch.runId,
          parentKind: null, parentExecutionId: null, associationSource: 'direct', manifestHash: dispatch.manifestHash });
        return this.link({ taskId: task.id, projectId: run.projectId, kind: 'stage', executionId: run.id,
          parentKind: 'chat', parentExecutionId: dispatch.runId, associationSource: 'chat_dispatch', manifestHash });
      }
      const parentId = run.parentRunId ?? run.retryOfRunId;
      if (parentId !== null) {
        const parent = this.findExecution('stage', parentId, run.projectId);
        if (parent !== null) return this.link({ taskId: parent.taskId, projectId: run.projectId, kind: 'stage', executionId: run.id,
          parentKind: 'stage', parentExecutionId: parentId,
          associationSource: run.parentRunId === null ? 'retry' : 'review', manifestHash });
        if (run.parentRunId !== null) throw new Error('research_task_execution_unlinked');
      }
      const previous = this.findExecution('stage', run.id, run.projectId);
      const task = previous === null ? this.createTask(run.projectId, run.instruction, null) : this.get(previous.taskId, run.projectId);
      return this.link({ taskId: task.id, projectId: run.projectId, kind: 'stage', executionId: run.id,
        parentKind: null, parentExecutionId: null, associationSource: 'direct', manifestHash });
    }).immediate();
  }

  linkOwned(input: ExecutionIdentity & { projectId: string; ownerRunId: string | null; goal: string; snapshot: unknown }): ResearchTaskExecution {
    return this.db.transaction(() => {
      const parent = input.ownerRunId === null ? null : this.requireExecution('stage', input.ownerRunId, input.projectId);
      const existing = this.findExecution(input.kind, input.executionId, input.projectId);
      const task = parent !== null ? this.get(parent.taskId, input.projectId)
        : existing !== null ? this.get(existing.taskId, input.projectId) : this.createTask(input.projectId, input.goal, null);
      return this.link({ taskId: task.id, projectId: input.projectId, kind: input.kind, executionId: input.executionId,
        parentKind: parent === null ? null : 'stage', parentExecutionId: input.ownerRunId,
        associationSource: parent === null ? 'direct' : 'owned', manifestHash: digest(input.snapshot) });
    }).immediate();
  }

  linkReviewSearch(snapshot: ResearchReviewSearchSnapshot, dispatch: ConsumedReviewSearchDispatchGrant): ResearchTaskExecution {
    assertReviewSearchDispatchGrant(dispatch);
    const {projectId} = snapshot.request;
    if (dispatch.projectId !== projectId || snapshot.actor.kind !== 'agent' || snapshot.actor.id !== dispatch.runId ||
        dispatch.requestHash !== reviewSearchDispatchRequestHash(snapshot.request)) throw new Error('research_dispatch_request_mismatch');
    return this.db.transaction(() => {
      const chat = this.findExecution('chat', dispatch.runId, projectId);
      const task = chat === null ? this.createTask(projectId, snapshot.parameters.query, dispatch.runId) : this.get(chat.taskId, projectId);
      this.link({taskId: task.id, projectId, kind: 'chat', executionId: dispatch.runId, parentKind: null,
        parentExecutionId: null, associationSource: 'direct', manifestHash: dispatch.manifestHash});
      return this.link({taskId: task.id, projectId, kind: 'review_search', executionId: snapshot.id,
        parentKind: 'chat', parentExecutionId: dispatch.runId, associationSource: 'chat_dispatch',
        manifestHash: digest({snapshot, parentManifestHash: dispatch.manifestHash})});
    }).immediate();
  }

  assertReviewSearchActive(owner: ResearchReviewSearchOwnership, executionId: string, expectedExecutionHash: string): void {
    const execution = this.requireExecution('review_search', executionId, owner.projectId);
    const parent = this.requireExecution('chat', owner.runId, owner.projectId);
    if (execution.taskId !== parent.taskId || execution.parentKind !== 'chat' || execution.parentExecutionId !== owner.runId ||
        parent.manifestHash !== owner.manifestHash || execution.manifestHash !== expectedExecutionHash) throw new Error('research_review_owner_mismatch');
    if (this.get(execution.taskId, owner.projectId).status !== 'active') throw new Error('research_task_not_active');
    const run = this.requireReviewSearchParent(owner);
    const budget = this.db.prepare(`SELECT b.limits_json,COALESCE(b.stop_reason,p.stop_reason) stop_reason
      FROM research_task_budgets b LEFT JOIN research_project_budget_states p ON p.project_id=? WHERE b.task_id=?`)
      .get(owner.projectId, execution.taskId) as {limits_json: string; stop_reason: string | null} | undefined;
    if (budget === undefined) throw new Error('research_task_budget_missing');
    const reason = budget.stop_reason ?? run.budget_stop_reason;
    if (reason !== null) throw new Error(reason);
    if (Date.parse(runBudgetSchema.parse(JSON.parse(budget.limits_json)).deadlineAt) <= Date.parse(this.now())) {
      throw new Error('run_deadline_exhausted');
    }
  }

  assertReviewSearchParent(owner: Pick<ResearchReviewSearchOwnership, 'runId' | 'threadId' | 'projectId' | 'manifestHash'>): void {
    this.requireReviewSearchParent(owner);
  }

  private requireReviewSearchParent(owner: Pick<ResearchReviewSearchOwnership, 'runId' | 'threadId' | 'projectId' | 'manifestHash'>) {
    const run = this.db.prepare(`SELECT r.status,r.thread_id,r.snapshot_json,r.snapshot_version,r.budget_stop_reason,t.research_project_id
      FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE r.id=?`)
      .get(owner.runId) as {status: string; thread_id: string; snapshot_json: string; snapshot_version: number;
        budget_stop_reason: string | null; research_project_id: string | null} | undefined;
    if (run === undefined || run.status !== 'running' || run.thread_id !== owner.threadId) throw new Error('research_dispatch_parent_not_active');
    if (this.db.prepare('SELECT 1 FROM agent_execution_run_fences WHERE run_id=?').get(owner.runId) !== undefined) {
      throw new Error('research_dispatch_parent_revoked');
    }
    const snapshot = runExecutionSnapshotSchema.parse(JSON.parse(run.snapshot_json));
    const {manifestHash, ...manifest} = snapshot.capabilityManifest;
    if (run.snapshot_version !== 9 || run.research_project_id !== owner.projectId ||
        snapshot.runId !== owner.runId || snapshot.threadId !== owner.threadId || snapshot.researchProjectId !== owner.projectId ||
        manifestHash !== owner.manifestHash || digest(manifest) !== owner.manifestHash) throw new Error('research_dispatch_parent_binding_invalid');
    return run;
  }

  private createTask(projectId: string, goal: string, rootAgentRunId: string | null): ResearchTask {
    const task = researchTaskSchema.parse({
      schemaVersion: 2, id: `research_task_${randomUUID()}`, projectId, goal, rootAgentRunId,
      status: 'active', statusReason: null, deadlineClock: 'continuous',
      budgetPolicyVersion: 1, createdAt: this.now(), updatedAt: this.now()
    });
    this.db.prepare('INSERT INTO research_tasks (id, project_id, status, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(task.id, task.projectId, task.status, JSON.stringify(task), task.createdAt);
    const limits = rootAgentRunId === null
      ? createRunBudget({ contextBudgetTokens: null, startedAt: task.createdAt })
      : this.rootChatBudget(rootAgentRunId);
    this.db.prepare('INSERT INTO research_task_budgets (task_id, limits_json, stop_reason, created_at) VALUES (?, ?, NULL, ?)')
      .run(task.id, JSON.stringify(limits), task.createdAt);
    return task;
  }

  private rootChatBudget(runId: string): RunLimits {
    const row = this.db.prepare('SELECT snapshot_json FROM agent_runs WHERE id = ?')
      .get(runId) as { snapshot_json: string | null } | undefined;
    if (row === undefined || row.snapshot_json === null) throw new Error('research_task_parent_snapshot_missing');
    return runExecutionSnapshotSchema.parse(JSON.parse(row.snapshot_json)).budget;
  }

  private link(input: ExecutionInput): ResearchTaskExecution {
    const task = this.get(input.taskId, input.projectId);
    if (input.parentKind !== null && input.parentExecutionId !== null) {
      const parent = this.requireExecution(input.parentKind, input.parentExecutionId, input.projectId);
      if (parent.taskId !== input.taskId) throw new Error('research_task_parent_mismatch');
    }
    const existing = this.findExecution(input.kind, input.executionId, input.projectId);
    if (existing !== null) {
      const { schemaVersion: _schemaVersion, createdAt: _createdAt, ...identity } = existing;
      if (JSON.stringify(identity) !== JSON.stringify(input)) throw new Error('research_task_execution_conflict');
      return existing;
    }
    if (task.status !== 'active') throw new Error('research_task_not_active');
    const execution = researchTaskExecutionSchema.parse({ schemaVersion: 1, ...input, createdAt: this.now() });
    this.db.prepare('INSERT INTO research_task_executions (kind, execution_id, task_id, project_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(execution.kind, execution.executionId, execution.taskId, execution.projectId, JSON.stringify(execution), execution.createdAt);
    if (execution.kind === 'chat' || execution.kind === 'stage') {
      const drift = this.db.prepare('SELECT 1 FROM agent_budget_calls WHERE run_id = ? AND task_id IS NOT NULL AND task_id != ?')
        .get(execution.executionId, execution.taskId);
      if (drift !== undefined) throw new Error('research_task_budget_association_conflict');
      this.db.prepare('UPDATE agent_budget_calls SET task_id = ?, project_id = ? WHERE run_id = ? AND execution_kind = ?')
        .run(execution.taskId, execution.projectId, execution.executionId, execution.kind);
    }
    return execution;
  }
}
