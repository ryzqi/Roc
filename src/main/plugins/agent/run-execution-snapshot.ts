import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshot, TaskRun, WorkflowHint } from '../../../shared/types';
import { runExecutionSnapshotSchema } from '../../../shared/schemas/agent';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

export { runExecutionSnapshotSchema };

export type RunExecutionSnapshotSeed = Omit<RunExecutionSnapshot, 'runId' | 'threadId' | 'inputMessageId'>;

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
  return parseRunExecutionSnapshot({
    ...input.snapshot,
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

export function createRunBudget(input: {
  contextBudgetTokens: number | null;
}): RunExecutionSnapshot['budget'] {
  return {
    contextWindowTokens: input.contextBudgetTokens,
    maxTotalTokens: null,
    maxCostUsd: null,
    maxModelCalls: 100,
    maxToolCalls: 500,
    maxConcurrentModelCalls: 4,
    maxConcurrentToolCalls: 4,
    deadlineAt: null
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
    enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities
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
  if (snapshot.runOrigin === 'background_schedule') {
    request.taskSource = 'background_schedule';
  } else if (snapshot.runOrigin === 'workbench_creation' || snapshot.mode === 'task') {
    request.taskSource = 'workbench';
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
