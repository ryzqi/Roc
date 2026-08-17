import { z } from 'zod';

import type { ChatRunMode, ChatStartRunRequest, RunExecutionSnapshotV1, RunExecutionSnapshotV2, TaskRun, WorkflowHint } from '../../../shared/types';
import { isRunCapabilityManifestIntegrityValid } from './run-capability-manifest';

const enabledCapabilitiesSchema = z
  .object({
    mcpServers: z.array(z.string()),
    skills: z.array(z.string())
  })
  .strict();

const skippedCapabilitySchema = z
  .object({
    id: z.string(),
    type: z.enum(['mcp_server', 'skill']),
    reason: z.enum(['not_found', 'disabled', 'invalid'])
  })
  .strict();

const runCapabilityManifestToolSchema = z
  .object({
    canonicalIdentity: z.string(),
    modelVisibleName: z.string(),
    provenance: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin'), source: z.literal('roc') }).strict(),
      z.object({ kind: z.literal('mcp'), serverId: z.string() }).strict()
    ]),
    executionScopes: z.array(z.enum(['main', 'subagent'])),
    riskLevel: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    effectClass: z.enum(['external_call', 'host_execution', 'network_read', 'none', 'workspace_mutation']),
    approvalPolicy: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('required'), allowedDecisions: z.array(z.enum(['approve', 'edit', 'reject'])) }).strict()
    ]),
    idempotencyStrategy: z.enum(['none', 'tool_call']),
    reconcileStrategy: z.enum(['none', 'retry_safe', 'manual_confirmation']).optional(),
    resourceScope: z.enum(['app', 'workspace', 'memory', 'network', 'external'])
  })
  .strict();

const runCapabilityManifestSkillSchema = z
  .object({
    canonicalIdentity: z.string(),
    name: z.string(),
    sourcePath: z.string(),
    description: z.string()
  })
  .strict();

const runCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedCapabilities: enabledCapabilitiesSchema,
    resolvedCapabilities: enabledCapabilitiesSchema,
    skippedCapabilities: z.array(skippedCapabilitySchema),
    tools: z.array(runCapabilityManifestToolSchema),
    skills: z.array(runCapabilityManifestSkillSchema),
    untrustedContextPolicy: z.literal('external_content_reference_only')
  })
  .strict();

export const runExecutionSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    threadId: z.string().min(1),
    runOrigin: z.enum(['background_schedule', 'chat', 'manual_task_run', 'workbench_creation']),
    model: z
      .object({
        providerId: z.string().min(1),
        modelId: z.string().min(1)
      })
      .strict(),
    mode: z.enum(['plan', 'run', 'task']),
    workspace: z
      .object({
        path: z.string().min(1),
        hash: z.string().min(1)
      })
      .strict()
      .nullable(),
    capabilityManifest: runCapabilityManifestSchema,
    budget: z.object({
      contextBudgetTokens: z.number().int().positive().nullable()
    })
      .strict(),
    workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable(),
    explicitSkillIds: z.array(z.string()),
    inputMessageId: z.string().min(1),
    dispatchKey: z.string().min(1).nullable()
  })
  .strict() satisfies z.ZodType<RunExecutionSnapshotV1>;

export const runExecutionSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: z.string().min(1),
    threadId: z.string().min(1),
    runOrigin: z.enum(['background_schedule', 'chat', 'manual_task_run', 'workbench_creation']),
    model: z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1)
    }).strict(),
    mode: z.enum(['plan', 'run', 'task']),
    workspace: z.object({
      path: z.string().min(1),
      hash: z.string().min(1)
    }).strict().nullable(),
    capabilityManifest: runCapabilityManifestSchema,
    budget: z.object({
      contextBudgetTokens: z.number().int().positive().nullable(),
      modelCallLimit: z.number().int().positive(),
      modelThreadCallLimit: z.number().int().positive(),
      toolCallLimit: z.number().int().positive(),
      toolThreadCallLimit: z.number().int().positive()
    }).strict(),
    workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable(),
    explicitSkillIds: z.array(z.string()),
    inputMessageId: z.string().min(1),
    dispatchKey: z.string().min(1).nullable(),
    shellAllowedCommands: z.array(z.string().trim().min(1)).optional()
  })
  .strict() satisfies z.ZodType<RunExecutionSnapshotV2>;

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
  const version = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) }).parse(value).schemaVersion;
  if (version === 1) {
    return migrateRunExecutionSnapshotV1(runExecutionSnapshotV1Schema.parse(value));
  }
  const snapshot = runExecutionSnapshotV2Schema.parse(value);
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  return snapshot;
}

function migrateRunExecutionSnapshotV1(snapshot: RunExecutionSnapshotV1): RunExecutionSnapshotV2 {
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  const limits = resolveRunCallLimits(snapshot.runOrigin, snapshot.mode);
  return {
    ...snapshot,
    schemaVersion: 2,
    budget: {
      contextBudgetTokens: snapshot.budget.contextBudgetTokens,
      modelCallLimit: limits.model,
      modelThreadCallLimit: limits.modelThread,
      toolCallLimit: limits.tool,
      toolThreadCallLimit: limits.toolThread
    },
    shellAllowedCommands: snapshot.runOrigin === 'background_schedule' ? [] : undefined
  };
}

export function createRunBudget(input: {
  contextBudgetTokens: number | null;
  mode: RunExecutionSnapshotV2['mode'];
  runOrigin: RunExecutionSnapshotV2['runOrigin'];
}): RunExecutionSnapshotV2['budget'] {
  const limits = resolveRunCallLimits(input.runOrigin, input.mode);
  return {
    contextBudgetTokens: input.contextBudgetTokens,
    modelCallLimit: limits.model,
    modelThreadCallLimit: limits.modelThread,
    toolCallLimit: limits.tool,
    toolThreadCallLimit: limits.toolThread
  };
}

function resolveRunCallLimits(
  runOrigin: RunExecutionSnapshotV1['runOrigin'],
  mode: RunExecutionSnapshotV1['mode']
): { model: number; modelThread: number; tool: number; toolThread: number } {
  if (runOrigin === 'background_schedule') {
    return { model: 8, modelThread: 40, tool: 16, toolThread: 80 };
  }
  if (mode === 'plan') {
    return { model: 12, modelThread: 60, tool: 24, toolThread: 120 };
  }
  return { model: 20, modelThread: 100, tool: 40, toolThread: 200 };
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
