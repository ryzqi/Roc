import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../../shared/provider-defaults';
import { resolveRunModelOutputTokens } from '../../../shared/model-context';
import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshot, TaskRun, WorkflowHint } from '../../../shared/types';
import { taskSourceFromRunSnapshot } from '../../../shared/agent-task-source';
import { runExecutionSnapshotSchema } from '../../../shared/schemas/agent';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

export { runExecutionSnapshotSchema };

export type RunExecutionSnapshotSeed = Omit<RunExecutionSnapshot, 'runId' | 'threadId' | 'inputMessageId' | 'workspaceIdentity' | 'nodeBinding' | 'origin' | 'frozenInputs'>;

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
    nodeBinding: { kind: 'none' },
    origin: { kind: 'main', action: 'start', requestId: input.inputMessageId },
    frozenInputs: freezeRunInputs(input.snapshot),
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
  if (snapshot.nodeBinding.kind !== 'none') throw new Error('run_execution_node_not_supported');
  if (snapshot.origin.kind !== 'main' || snapshot.origin.action !== 'start' || snapshot.origin.requestId !== snapshot.inputMessageId) {
    throw new Error('run_execution_origin_invalid');
  }
  if (JSON.stringify(snapshot.frozenInputs) !== JSON.stringify(freezeRunInputs(snapshot))) {
    throw new Error('run_execution_snapshot_inputs_invalid');
  }
  return snapshot;
}

function freezeRunInputs(snapshot: RunExecutionSnapshotSeed): RunExecutionSnapshot['frozenInputs'] {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    schemaVersion: 1,
    requestHash: snapshot.submissionHash,
    manifestHash: snapshot.capabilityManifest.manifestHash,
    policyHash: hash({ modelConfig: snapshot.modelConfig, model: snapshot.model, taskContract: snapshot.taskContract }),
    versions: snapshot.capabilityManifest.skills.map(skill => ({ kind: 'skill', id: skill.canonicalIdentity, hash: skill.contentHash }))
  };
}

function captureWorkspaceIdentity(path: string): { path: string; dev: string; ino: string } {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath);
  if (!stat.isDirectory()) throw new Error('run_execution_workspace_not_directory');
  return { path: canonicalPath, dev: String(stat.dev), ino: String(stat.ino) };
}

export function createRunModelConfig(input: {
  contextWindowTokens: number | null;
  maxOutputTokens?: number;
}): RunExecutionSnapshot['modelConfig'] {
  const contextWindowTokens = input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = resolveRunModelOutputTokens(contextWindowTokens, input.maxOutputTokens);
  return {
    policyVersion: 1,
    contextWindowTokens,
    maxOutputTokens
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
