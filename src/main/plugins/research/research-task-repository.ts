import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  researchTaskSchema, researchTaskExecutionSchema,
  type ResearchTask, type ResearchTaskExecution
} from '../../../shared/schemas/research-tasks';
import type { ResearchStageRun } from '../../../shared/types';
import type { ConsumedResearchDispatchGrant } from '../../services/deep-agent/execution-grant-broker';
import { assertResearchDispatchGrant } from '../../services/deep-agent/execution-grant-broker';
import { researchDispatchRequestHash } from '../../services/research-dispatch-context';

type ExecutionIdentity = Pick<ResearchTaskExecution, 'kind' | 'executionId'>;
type ExecutionInput = Omit<ResearchTaskExecution, 'schemaVersion' | 'createdAt'>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Task identity and accounting share the agent database. Domain runs keep their own storage. */
export class ResearchTaskRepository {
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {}

  get(id: string, projectId: string): ResearchTask {
    const row = this.db.prepare('SELECT snapshot_json FROM research_tasks WHERE id = ?').get(id) as { snapshot_json: string } | undefined;
    if (row === undefined) throw new Error('research_task_not_found');
    const task = researchTaskSchema.parse(JSON.parse(row.snapshot_json));
    if (task.projectId !== projectId) throw new Error('research_task_project_mismatch');
    return task;
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

  executions(taskId: string, projectId: string): ResearchTaskExecution[] {
    this.get(taskId, projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_task_executions WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as Array<{ snapshot_json: string }>).map((row) => researchTaskExecutionSchema.parse(JSON.parse(row.snapshot_json)));
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

  private createTask(projectId: string, goal: string, rootAgentRunId: string | null): ResearchTask {
    const task = researchTaskSchema.parse({
      schemaVersion: 1, id: `research_task_${randomUUID()}`, projectId, goal, rootAgentRunId,
      status: 'active', budgetPolicyVersion: 1, createdAt: this.now(), updatedAt: this.now()
    });
    this.db.prepare('INSERT INTO research_tasks (id, project_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)')
      .run(task.id, task.projectId, JSON.stringify(task), task.createdAt);
    return task;
  }

  private link(input: ExecutionInput): ResearchTaskExecution {
    const task = this.get(input.taskId, input.projectId);
    if (task.status !== 'active') throw new Error('research_task_not_active');
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
    const execution = researchTaskExecutionSchema.parse({ schemaVersion: 1, ...input, createdAt: this.now() });
    this.db.prepare('INSERT INTO research_task_executions (kind, execution_id, task_id, project_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(execution.kind, execution.executionId, execution.taskId, execution.projectId, JSON.stringify(execution), execution.createdAt);
    return execution;
  }
}
