import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshotV1, RunExecutionSnapshotV2, TaskRun, WorkflowHint } from '../../../shared/types';
import {
  runExecutionSnapshotSchema,
  runExecutionSnapshotV1Schema,
  runExecutionSnapshotV2Schema
} from '../../../shared/schemas/agent';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

export { runExecutionSnapshotV1Schema, runExecutionSnapshotV2Schema };

export type RunExecutionSnapshotSeed = Omit<RunExecutionSnapshotV2, 'runId' | 'threadId' | 'inputMessageId'>;

export function toRunExecutionMode(mode: ChatRunMode): RunExecutionSnapshotV2['mode'] {
  return mode === 'chat' ? 'run' : mode;
}

export function toChatRunMode(mode: RunExecutionSnapshotV2['mode']): ChatRunMode {
  return mode === 'run' ? 'chat' : mode;
}

export function createRunExecutionSnapshot(input: {
  runId: string;
  threadId: string;
  inputMessageId: string;
  snapshot: RunExecutionSnapshotSeed;
}): RunExecutionSnapshotV2 {
  return parseRunExecutionSnapshot({
    ...input.snapshot,
    runId: input.runId,
    threadId: input.threadId,
    inputMessageId: input.inputMessageId
  });
}

export function parseRunExecutionSnapshot(value: unknown): RunExecutionSnapshotV2 {
  const snapshot = runExecutionSnapshotSchema.parse(value);
  if (snapshot.schemaVersion === 1) {
    return migrateRunExecutionSnapshotV1(snapshot);
  }
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  return snapshot;
}

function migrateRunExecutionSnapshotV1(snapshot: RunExecutionSnapshotV1): RunExecutionSnapshotV2 {
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  return {
    ...snapshot,
    schemaVersion: 2,
    budget: {
      contextBudgetTokens: snapshot.budget.contextBudgetTokens
    },
    shellAllowedCommands: snapshot.runOrigin === 'background_schedule' ? [] : undefined
  };
}

export function createRunBudget(input: {
  contextBudgetTokens: number | null;
}): RunExecutionSnapshotV2['budget'] {
  return {
    contextBudgetTokens: input.contextBudgetTokens
  };
}

export function createChatStartRunRequestFromSnapshot(
  snapshot: RunExecutionSnapshotV2,
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

export function readShellAllowedCommands(snapshot: RunExecutionSnapshotV2): string[] {
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
