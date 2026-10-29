import { realpathSync, statSync } from 'node:fs';
import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshot, TaskRun, WorkflowHint } from '../../../shared/types';
import { taskSourceFromRunSnapshot } from '../../../shared/agent-task-source';
import { runExecutionSnapshotSchema } from '../../../shared/schemas/agent';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

export { runExecutionSnapshotSchema };

export type RunExecutionSnapshotSeed = Omit<Extract<RunExecutionSnapshot, { schemaVersion: 8 }>, 'runId' | 'threadId' | 'inputMessageId' | 'workspaceIdentity'>;

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

function captureWorkspaceIdentity(path: string): { path: string; dev: string; ino: string } {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath);
  if (!stat.isDirectory()) throw new Error('run_execution_workspace_not_directory');
  return { path: canonicalPath, dev: String(stat.dev), ino: String(stat.ino) };
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
    maxChildTasks: 8,
    maxConcurrentChildTasks: 2,
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
