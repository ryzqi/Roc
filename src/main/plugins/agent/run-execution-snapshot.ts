import { realpathSync, statSync } from 'node:fs';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../../../shared/provider-defaults';
import {
  DEFAULT_RUN_DEADLINE_MS,
  DEFAULT_RUN_MAX_CHILD_TASKS,
  DEFAULT_RUN_MAX_CONCURRENT_CHILD_TASKS,
  DEFAULT_RUN_MAX_CONCURRENT_MODEL_CALLS,
  DEFAULT_RUN_MAX_CONCURRENT_TOOL_CALLS,
  DEFAULT_RUN_MAX_MODEL_CALLS,
  DEFAULT_RUN_MAX_TOOL_CALLS,
  DEFAULT_RUN_MODEL_OUTPUT_TOKENS,
  RUN_BUDGET_POLICY_VERSION,
  RUN_BUDGET_PRICING_CATALOG_VERSION,
  deriveModelCallTokenReservation,
  resolveRunModelOutputTokens
} from '../../../shared/run-budget-policy';
import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshot, TaskRun, WorkflowHint } from '../../../shared/types';
import { taskSourceFromRunSnapshot } from '../../../shared/agent-task-source';
import { legacyRunExecutionSnapshotSchema, runExecutionSnapshotSchema } from '../../../shared/schemas/agent';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

export { runExecutionSnapshotSchema };

export type RunExecutionSnapshotSeed = Omit<Extract<RunExecutionSnapshot, { schemaVersion: 9 }>, 'runId' | 'threadId' | 'inputMessageId' | 'workspaceIdentity'>;

export function toRunExecutionMode(mode: ChatRunMode): RunExecutionSnapshot['mode'] {
  return mode === 'chat' ? 'run' : mode;
}

export function toChatRunMode(mode: RunExecutionSnapshot['mode']): ChatRunMode {
  return mode === 'run' ? 'chat' : mode;
}

export function createRunExecutionSnapshot(input: {
  runId: string;
  threadId: string;
  inputMessageId: string;
  snapshot: RunExecutionSnapshotSeed;
}): RunExecutionSnapshot {
  const workspaceIdentity = input.snapshot.workspace === null
    ? null
    : captureWorkspaceIdentity(input.snapshot.workspace.path);
  return parseRunExecutionSnapshot({
    ...input.snapshot,
    workspaceIdentity,
    runId: input.runId,
    threadId: input.threadId,
    inputMessageId: input.inputMessageId
  });
}

export function parseRunExecutionSnapshot(value: unknown): RunExecutionSnapshot {
  const snapshot = runExecutionSnapshotSchema.parse(value);
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  return snapshot;
}

export function migrateLegacyRunExecutionSnapshot(value: unknown, startedAt: string): RunExecutionSnapshot {
  const legacy = legacyRunExecutionSnapshotSchema.parse(value);
  if (legacy.schemaVersion === 7 && legacy.workspace !== null) {
    throw new Error('run_execution_snapshot_legacy_workspace_identity_missing');
  }
  if (legacy.schemaVersion === 8 && legacy.workspace !== null && legacy.workspaceIdentity === null) {
    throw new Error('run_execution_snapshot_legacy_workspace_identity_missing');
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error('run_execution_snapshot_started_at_invalid');
  const oldBudget = legacy.budget;
  if (oldBudget.contextWindowTokens === null) {
    throw new Error('run_execution_snapshot_legacy_context_budget_missing');
  }
  const budget = createRunBudget({
    contextBudgetTokens: oldBudget.contextWindowTokens,
    maxOutputTokens: DEFAULT_RUN_MODEL_OUTPUT_TOKENS,
    startedAt
  });
  const maxTotalTokens = oldBudget.maxTotalTokens === null
    ? budget.maxTotalTokens
    : Math.min(oldBudget.maxTotalTokens, budget.maxTotalTokens);
  const maxCostMicrousd = oldBudget.maxCostUsd === null
    ? null
    : Math.floor(oldBudget.maxCostUsd * 1_000_000);
  const migrated = {
    ...legacy,
    schemaVersion: 9 as const,
    workspaceIdentity: legacy.schemaVersion === 8 ? legacy.workspaceIdentity : null,
    budget: {
      ...budget,
      maxTotalTokens,
      maxCostMicrousd,
      maxModelCalls: Math.min(oldBudget.maxModelCalls, budget.maxModelCalls),
      maxToolCalls: Math.min(oldBudget.maxToolCalls, budget.maxToolCalls),
      maxChildTasks: Math.min(oldBudget.maxChildTasks, budget.maxChildTasks),
      maxConcurrentChildTasks: Math.min(oldBudget.maxConcurrentChildTasks, budget.maxConcurrentChildTasks),
      maxConcurrentModelCalls: Math.min(oldBudget.maxConcurrentModelCalls, budget.maxConcurrentModelCalls),
      maxConcurrentToolCalls: Math.min(oldBudget.maxConcurrentToolCalls, budget.maxConcurrentToolCalls),
      deadlineAt: oldBudget.deadlineAt === null
        ? new Date(startedAtMs + DEFAULT_RUN_DEADLINE_MS).toISOString()
        : new Date(Math.min(Date.parse(oldBudget.deadlineAt), startedAtMs + DEFAULT_RUN_DEADLINE_MS)).toISOString()
    }
  };
  return parseRunExecutionSnapshot(migrated);
}

function captureWorkspaceIdentity(path: string): { path: string; dev: string; ino: string } {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath);
  if (!stat.isDirectory()) throw new Error('run_execution_workspace_not_directory');
  return { path: canonicalPath, dev: String(stat.dev), ino: String(stat.ino) };
}

export function createRunBudget(input: {
  contextBudgetTokens: number | null;
  maxOutputTokens?: number;
  maxCostMicrousd?: number | null;
  startedAt?: string;
}): RunExecutionSnapshot['budget'] {
  const contextWindowTokens = input.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const maxOutputTokens = resolveRunModelOutputTokens(contextWindowTokens, input.maxOutputTokens);
  const maxCallTokens = deriveModelCallTokenReservation(contextWindowTokens, maxOutputTokens);
  const now = input.startedAt === undefined ? Date.now() : Date.parse(input.startedAt);
  if (!Number.isFinite(now)) throw new Error('run_budget_started_at_invalid');
  const maxConcurrentModelCalls = DEFAULT_RUN_MAX_CONCURRENT_MODEL_CALLS;
  const maxTotalTokens = maxCallTokens * maxConcurrentModelCalls;
  if (!Number.isSafeInteger(maxTotalTokens)) throw new Error('run_budget_total_token_limit_invalid');
  return {
    policyVersion: RUN_BUDGET_POLICY_VERSION,
    contextWindowTokens,
    maxOutputTokens,
    maxCallTokens,
    maxTotalTokens,
    maxCostMicrousd: input.maxCostMicrousd ?? null,
    pricingCatalogVersion: RUN_BUDGET_PRICING_CATALOG_VERSION,
    maxModelCalls: DEFAULT_RUN_MAX_MODEL_CALLS,
    maxToolCalls: DEFAULT_RUN_MAX_TOOL_CALLS,
    maxChildTasks: DEFAULT_RUN_MAX_CHILD_TASKS,
    maxConcurrentChildTasks: DEFAULT_RUN_MAX_CONCURRENT_CHILD_TASKS,
    maxConcurrentModelCalls,
    maxConcurrentToolCalls: DEFAULT_RUN_MAX_CONCURRENT_TOOL_CALLS,
    deadlineAt: new Date(now + DEFAULT_RUN_DEADLINE_MS).toISOString()
  };
}

export function createChatStartRunRequestFromSnapshot(
  snapshot: RunExecutionSnapshot,
  run: TaskRun
): ChatStartRunRequest {
  const request: ChatStartRunRequest = {
    input: run.userInput,
    mode: toChatRunMode(snapshot.mode),
    threadId: snapshot.threadId,
    enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
    acceptanceCriteria: snapshot.taskContract.criteria
  };
  const workflowHint = readWorkflowHintFromSnapshot(snapshot.workflowHint);
  if (workflowHint !== null) {
    request.workflowHint = workflowHint;
  }
  if (snapshot.workspace !== null) {
    request.workspacePath = snapshot.workspace.path;
  }
  if (snapshot.researchProjectId !== undefined && snapshot.researchProjectId !== null) {
    request.researchProjectId = snapshot.researchProjectId;
  }
  const taskSource = taskSourceFromRunSnapshot(snapshot);
  if (taskSource !== null) {
    request.taskSource = taskSource;
  }
  if (snapshot.explicitSkillIds.length > 0) {
    request.explicitSkillIds = snapshot.explicitSkillIds;
  }
  if (snapshot.dispatchKey !== null) {
    request.dispatchKey = snapshot.dispatchKey;
  }
  const shellAllowedCommands = readShellAllowedCommands(snapshot);
  if (shellAllowedCommands.length > 0) {
    request.shellAllowedCommands = [...shellAllowedCommands];
  }
  return request;
}

export function readShellAllowedCommands(snapshot: RunExecutionSnapshot): string[] {
  return snapshot.shellAllowedCommands === undefined ? [] : [...snapshot.shellAllowedCommands];
}

export function readWorkflowHintFromSnapshot(value: string | null): WorkflowHint | null {
  if (value === null) {
    return null;
  }
  if (value === 'propose_background_task' || value === 'background_task_change') {
    return value;
  }
  throw new Error('run_execution_snapshot_workflow_hint_invalid');
}
