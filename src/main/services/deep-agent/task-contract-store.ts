import { createHash } from 'node:crypto';
import { realpath, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  taskAcceptanceSchema,
  taskContractSchema,
  taskHandoffSchema,
  type TaskAcceptance,
  type TaskContract,
  type TaskCriterion,
  type TaskHandoff
} from '../../../shared/schemas/task-acceptance';
import type { ResearchStage } from '../../../shared/types';
import { hashToolInput } from './tool-effect-store';

export type ResearchProof = { passed: boolean; detail: string; refs: { path: string; sha256: string }[] };
export type TaskVerificationContext = {
  workspacePath: string | null;
  response: string | null;
  researchProof?: (stage: ResearchStage) => Promise<ResearchProof>;
};

/** Durable task facts; model prose never marks an acceptance item satisfied. */
export class TaskContractStore {
  constructor(private readonly db: Database) {}

  initialize(runId: string, contract: TaskContract): void {
    taskContractSchema.parse(contract);
    this.db.prepare('INSERT OR IGNORE INTO agent_task_contracts (run_id, contract_json) VALUES (?, ?)')
      .run(runId, JSON.stringify(contract));
    const stored = this.readContract(runId);
    if (hashToolInput(stored) !== hashToolInput(contract)) throw new Error('task_contract_changed');
  }

  assertMatchesSnapshot(runId: string, snapshotContract: TaskContract): void {
    if (hashToolInput(this.readContract(runId)) !== hashToolInput(taskContractSchema.parse(snapshotContract))) {
      throw new Error('task_contract_snapshot_mismatch');
    }
  }

  readContract(runId: string): TaskContract {
    const row = this.db.prepare('SELECT contract_json FROM agent_task_contracts WHERE run_id = ?')
      .get(runId) as { contract_json: string } | undefined;
    if (row === undefined) throw new Error('task_contract_missing');
    return taskContractSchema.parse(JSON.parse(row.contract_json));
  }

  readReport(runId: string): TaskAcceptance | null {
    const row = this.db.prepare('SELECT report_json FROM agent_task_contracts WHERE run_id = ?')
      .get(runId) as { report_json: string | null } | undefined;
    if (row === undefined) throw new Error('task_contract_missing');
    return row.report_json === null ? null : taskAcceptanceSchema.parse(JSON.parse(row.report_json));
  }

  async verify(runId: string, context: TaskVerificationContext, blockedBy: string[] = []): Promise<TaskAcceptance> {
    const report = await this.evaluate(runId, context, blockedBy);
    this.saveReport(runId, report);
    return report;
  }

  async evaluate(runId: string, context: TaskVerificationContext, blockedBy: string[] = []): Promise<TaskAcceptance> {
    const contract = this.readContract(runId);
    const criteria = await Promise.all(contract.criteria.map((criterion) => this.verifyCriterion(criterion, context)));
    return buildAcceptanceReport({ runId, criteria, blockedBy, stale: false });
  }

  createUnverifiedReport(runId: string, reason: string): TaskAcceptance {
    const criteria = this.readContract(runId).criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verdict: 'unverified' as const,
      verifier: criterion.check.kind,
      artifactRefs: [],
      checkedAt: new Date().toISOString(),
      detail: 'Execution stopped before this criterion could be checked.'
    }));
    const report = buildAcceptanceReport({ runId, criteria, blockedBy: [reason], stale: false });
    this.saveReport(runId, report);
    return report;
  }

  /** Re-check artifact-backed proofs when a run timeline is replayed. */
  async refreshReport(runId: string, context: TaskVerificationContext): Promise<TaskAcceptance | null> {
    const previous = this.readReport(runId);
    if (previous === null) return null;
    const contract = this.readContract(runId);
    const previousById = new Map(previous.criteria.map((criterion) => [criterion.id, criterion]));
    let stale = false;
    const criteria = await Promise.all(contract.criteria.map(async (criterion) => {
      const prior = previousById.get(criterion.id);
      if (criterion.check.kind === 'response' && prior?.verdict === 'passed') return prior;
      const current = await this.verifyCriterion(criterion, context);
      if (prior !== undefined && prior.verdict === current.verdict && prior.detail === current.detail &&
          sameRefs(prior.artifactRefs, current.artifactRefs)) {
        current.checkedAt = prior.checkedAt;
      }
      if (prior?.verdict === 'passed' && prior.artifactRefs.length > 0 &&
          (current.verdict !== 'passed' || !sameRefs(prior.artifactRefs, current.artifactRefs))) {
        stale = true;
      }
      return current;
    }));
    const report = buildAcceptanceReport({ runId, criteria, blockedBy: previous.blockedBy, stale,
      checkpointResumeAvailable: previous.checkpointResumeAvailable });
    if (hashToolInput(report) !== hashToolInput(previous)) this.saveReport(runId, report);
    return report;
  }

  saveReport(runId: string, report: TaskAcceptance): void {
    const parsed = taskAcceptanceSchema.parse(report);
    if (parsed.runId !== runId || parsed.taskId !== runId) throw new Error('task_acceptance_run_mismatch');
    const result = this.db.prepare('UPDATE agent_task_contracts SET report_json = ? WHERE run_id = ?')
      .run(JSON.stringify(parsed), runId);
    if (result.changes !== 1) throw new Error('task_contract_missing');
  }

  saveHandoff(runId: string, input: {
    reason: TaskHandoff['reason'];
    checkpointPresent: boolean;
  }): TaskHandoff {
    const contract = this.readContract(runId);
    const report = this.readReport(runId);
    const run = this.db.prepare('SELECT thread_id FROM agent_runs WHERE id = ?').get(runId) as { thread_id: string } | undefined;
    if (run === undefined) throw new Error('task_run_not_found');
    const pendingEffects = this.db.prepare(`SELECT tool_call_id, status FROM agent_tool_effects
      WHERE run_id = ? AND status IN ('reserved', 'in_progress', 'unknown') ORDER BY tool_call_id`)
      .all(runId) as Array<{ tool_call_id: string; status: 'reserved' | 'in_progress' | 'unknown' }>;
    const childRows = this.db.prepare(`SELECT call_id, state, envelope_json FROM agent_budget_calls
      WHERE run_id = ? AND kind = 'child' ORDER BY created_at, call_id`)
      .all(runId) as Array<{ call_id: string; state: 'reserved' | 'settled' | 'unknown'; envelope_json: string }>;
    const childTasks = childRows.map((row) => {
      const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>;
      return {
        childTaskId: typeof envelope.childTaskId === 'string' ? envelope.childTaskId : row.call_id,
        state: row.state,
        outcomeStatus: envelope.outcomeStatus === 'completed' || envelope.outcomeStatus === 'failed' ? envelope.outcomeStatus : null,
        outcomeHash: typeof envelope.outcomeHash === 'string' && /^[a-f0-9]{64}$/.test(envelope.outcomeHash) ? envelope.outcomeHash : null,
        failureCode: typeof envelope.failureCode === 'string' ? envelope.failureCode.slice(0, 120) : null
      } as const;
    });
    const pendingApprovals = this.db.prepare('SELECT interrupt_id FROM agent_pending_interrupts WHERE run_id = ? ORDER BY position')
      .all(runId) as Array<{ interrupt_id: string }>;
    const checkpointResumeAvailable = input.reason === 'restart' && input.checkpointPresent && pendingApprovals.length === 0 &&
      pendingEffects.every((effect) => effect.status === 'reserved');
    const nextSafeAction = checkpointResumeAvailable
      ? 'Review the refreshed task evidence, then continue from the saved checkpoint.'
      : pendingApprovals.length > 0
      ? 'Resolve the pending approval or question, then resume this run.'
      : pendingEffects.length > 0
        ? 'Reconcile pending tool effects before any retry.'
        : childTasks.some((child) => child.outcomeStatus === 'failed' || child.state === 'unknown')
          ? 'Review the persisted child task outcomes before retrying unfinished work.'
          : 'Check the persisted run checkpoint and task contract before resuming.';
    const handoffReport = report === null ? null : taskAcceptanceSchema.parse({
      ...report,
      checkpointResumeAvailable
    });
    if (handoffReport !== null) this.saveReport(runId, handoffReport);
    const handoff = taskHandoffSchema.parse({
      schemaVersion: 1,
      runId,
      threadId: run.thread_id,
      taskContractHash: hashToolInput(contract),
      reason: input.reason,
      createdAt: new Date().toISOString(),
      acceptanceReport: handoffReport,
      pendingEffects: pendingEffects.map((effect) => ({ toolCallId: effect.tool_call_id, status: effect.status })),
      childTasks,
      pendingApprovals: pendingApprovals.map((approval) => approval.interrupt_id),
      checkpointPresent: input.checkpointPresent,
      nextSafeAction
    });
    this.db.prepare('UPDATE agent_task_contracts SET handoff_json = ? WHERE run_id = ?')
      .run(JSON.stringify(handoff), runId);
    return handoff;
  }

  readHandoff(runId: string): TaskHandoff | null {
    const row = this.db.prepare('SELECT handoff_json FROM agent_task_contracts WHERE run_id = ?')
      .get(runId) as { handoff_json: string | null } | undefined;
    if (row === undefined) throw new Error('task_contract_missing');
    return row.handoff_json === null ? null : taskHandoffSchema.parse(JSON.parse(row.handoff_json));
  }

  assertHandoffCanResume(runId: string, threadId: string, interruptId: string): void {
    const handoff = this.readHandoff(runId);
    if (handoff === null) return;
    if (handoff.threadId !== threadId || handoff.taskContractHash !== hashToolInput(this.readContract(runId))) {
      throw new Error('task_handoff_snapshot_mismatch');
    }
    if (!handoff.checkpointPresent) throw new Error('task_handoff_checkpoint_missing');
    if (handoff.pendingEffects.some((effect) => effect.status === 'in_progress' || effect.status === 'unknown')) {
      throw new Error('task_handoff_effect_reconciliation_required');
    }
    if (!handoff.pendingApprovals.includes(interruptId)) throw new Error('task_handoff_interrupt_mismatch');
  }

  assertCheckpointHandoffCanResume(runId: string, threadId: string): void {
    const handoff = this.readHandoff(runId);
    if (handoff === null || handoff.reason !== 'restart' || !handoff.checkpointPresent || !handoff.acceptanceReport?.checkpointResumeAvailable) {
      throw new Error('task_handoff_checkpoint_resume_unavailable');
    }
    if (handoff.threadId !== threadId || handoff.taskContractHash !== hashToolInput(this.readContract(runId))) {
      throw new Error('task_handoff_snapshot_mismatch');
    }
    const liveApprovals = this.db.prepare('SELECT 1 FROM agent_pending_interrupts WHERE run_id = ? LIMIT 1').get(runId);
    const liveUnsafeEffects = this.db.prepare(`SELECT 1 FROM agent_tool_effects
      WHERE run_id = ? AND status IN ('in_progress','unknown') LIMIT 1`).get(runId);
    if (liveApprovals !== undefined || liveUnsafeEffects !== undefined || handoff.pendingApprovals.length > 0 ||
        handoff.pendingEffects.some((effect) => effect.status !== 'reserved')) {
      throw new Error('task_handoff_effect_reconciliation_required');
    }
  }

  createCheckpointContinuationContext(runId: string): string {
    const contract = this.readContract(runId);
    const report = this.readReport(runId);
    const handoff = this.readHandoff(runId);
    if (handoff === null) throw new Error('task_handoff_missing');
    const content = [
      '[Persisted task handoff from the previous process]',
      'Continue the same task from the restored checkpoint. Use this record as evidence; do not repeat completed effects.',
      JSON.stringify({
        objective: contract.objective,
        constraints: contract.constraints,
        acceptance: report,
        pendingEffects: handoff.pendingEffects,
        pendingApprovals: handoff.pendingApprovals,
        childTasks: handoff.childTasks,
        nextSafeAction: handoff.nextSafeAction
      }),
      '[/Persisted task handoff]'
    ].join('\n');
    if (Buffer.byteLength(content, 'utf8') > 32_000) throw new Error('task_handoff_context_limit');
    return content;
  }

  enqueueCheckpointContinuation(runId: string, content: string): number {
    const submissionId = `task-handoff:${runId}`;
    if (content.trim().length === 0 || Buffer.byteLength(content, 'utf8') > 32_000) throw new Error('task_handoff_context_invalid');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: string } | undefined;
      if (row?.status !== 'interrupted') throw new Error('task_handoff_run_not_interrupted');
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO agent_run_inbox (run_id, submission_id, content, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, submission_id) DO UPDATE SET
          content = excluded.content, created_at = excluded.created_at, consumed_at = NULL`)
        .run(runId, submissionId, content, now);
      const stored = this.db.prepare('SELECT sequence FROM agent_run_inbox WHERE run_id = ? AND submission_id = ?')
        .get(runId, submissionId) as { sequence: number };
      return stored.sequence;
    }).immediate();
  }

  clearHandoff(runId: string): void {
    this.db.prepare('UPDATE agent_task_contracts SET handoff_json = NULL WHERE run_id = ?').run(runId);
  }

  disableCheckpointResume(runId: string): TaskAcceptance | null {
    const report = this.readReport(runId);
    if (report === null || !report.checkpointResumeAvailable) return null;
    const updated = taskAcceptanceSchema.parse({ ...report, checkpointResumeAvailable: false });
    this.saveReport(runId, updated);
    return updated;
  }

  private async verifyCriterion(criterion: TaskCriterion, context: TaskVerificationContext): Promise<TaskAcceptance['criteria'][number]> {
    const checkedAt = new Date().toISOString();
    let verdict: 'passed' | 'failed' | 'unverified' = 'unverified';
    let detail = 'No automatic verifier was declared for this objective.';
    let artifactRefs: ResearchProof['refs'] = [];
    try {
      if (criterion.check.kind === 'response') {
        verdict = context.response !== null && context.response.trim().length > 0 ? 'passed' : 'unverified';
        detail = verdict === 'passed' ? 'A visible response was produced.' : 'Response pending.';
        if (verdict === 'passed') {
          const sha256 = createHash('sha256').update(context.response!.trim(), 'utf8').digest('hex');
          artifactRefs = [{ path: `assistant-response:${sha256}`, sha256 }];
        }
      } else if (criterion.check.kind === 'artifact_sha256') {
        const artifact = await readTaskArtifact(context.workspacePath, criterion.check.path);
        artifactRefs = [artifact];
        verdict = artifact.sha256 === criterion.check.sha256 ? 'passed' : 'failed';
        detail = verdict === 'passed' ? 'Current bytes match the requested hash.' : 'Current bytes differ from the requested hash.';
      } else if (criterion.check.kind === 'research_stage') {
        if (context.researchProof === undefined) throw new Error('task_research_verifier_unavailable');
        const proof = await context.researchProof(criterion.check.stage);
        verdict = proof.passed ? 'passed' : 'failed';
        detail = proof.detail;
        artifactRefs = proof.refs;
        if (verdict === 'passed' && artifactRefs.length === 0) {
          verdict = 'unverified';
          detail = 'The research stage returned no artifact evidence.';
        }
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      verdict = 'unverified';
    }
    return { id: criterion.id, description: criterion.description, verdict, verifier: criterion.check.kind, artifactRefs, checkedAt, detail };
  }
}

function buildAcceptanceReport(input: {
  runId: string;
  criteria: TaskAcceptance['criteria'];
  blockedBy: string[];
  stale: boolean;
  checkpointResumeAvailable?: boolean;
}): TaskAcceptance {
  const remainingItems = input.criteria.filter((item) => item.verdict !== 'passed')
    .map((item) => `${item.id}: ${item.description}`);
  const status = input.blockedBy.length > 0
    ? 'blocked'
    : input.stale
      ? 'stale'
      : remainingItems.length === 0
        ? 'satisfied'
        : input.criteria.some((item) => item.verdict === 'passed')
          ? 'partial'
          : 'unverified';
  return taskAcceptanceSchema.parse({
    taskId: input.runId,
    runId: input.runId,
    contractVersion: 1,
    status,
    checkpointResumeAvailable: input.checkpointResumeAvailable ?? false,
    criteria: input.criteria,
    remainingItems,
    blockedBy: input.blockedBy,
    nextSafeAction: status === 'satisfied'
      ? 'Review the verified artifacts.'
      : status === 'stale'
        ? 'Re-run the listed checks against the changed artifacts.'
        : input.blockedBy.length > 0
          ? 'Resolve the stated blocker before continuing.'
          : 'Complete or verify the remaining acceptance items.'
  });
}

function sameRefs(left: readonly { path: string; sha256: string }[], right: readonly { path: string; sha256: string }[]): boolean {
  if (left.length !== right.length) return false;
  const key = (refs: readonly { path: string; sha256: string }[]) => refs.map((ref) => `${ref.path}\0${ref.sha256}`).sort().join('\n');
  return key(left) === key(right);
}

export async function readTaskArtifact(workspacePath: string | null, path: string): Promise<{ path: string; sha256: string }> {
  if (workspacePath === null) throw new Error('task_artifact_workspace_missing');
  const root = await realpath(workspacePath);
  const lexicalTarget = resolve(root, path);
  const lexicalChild = relative(root, lexicalTarget);
  assertTaskArtifactContained(lexicalChild);
  const segments = lexicalChild.split(sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error('task_artifact_path_changed');
    }
  }
  const target = await realpath(lexicalTarget);
  const child = relative(root, target);
  assertTaskArtifactContained(child);
  const file = await open(lexicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('task_artifact_size_or_type');
    const pathStat = await lstat(lexicalTarget);
    const resolvedAfterOpen = await realpath(lexicalTarget);
    const openedPath = relative(root, resolvedAfterOpen);
    assertTaskArtifactContained(openedPath);
    if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || resolvedAfterOpen !== target) {
      throw new Error('task_artifact_path_changed');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > 8 * 1024 * 1024) throw new Error('task_artifact_size_or_type');
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { path: child, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

function assertTaskArtifactContained(child: string): void {
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('task_artifact_outside_workspace');
  }
}
