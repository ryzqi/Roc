import { z } from 'zod';

import type { ChatStartRunRequest, RunExecutionSnapshotV1, TaskRun, WorkflowHint } from '../../../shared/types';
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
    budget: z
      .object({
        contextBudgetTokens: z.number().int().positive().nullable()
      })
      .strict(),
    workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable(),
    explicitSkillIds: z.array(z.string()),
    inputMessageId: z.string().min(1),
    dispatchKey: z.string().min(1).nullable()
  })
  .strict() satisfies z.ZodType<RunExecutionSnapshotV1>;

export type RunExecutionSnapshotSeed = Omit<RunExecutionSnapshotV1, 'runId' | 'threadId' | 'inputMessageId'>;

export function createRunExecutionSnapshot(input: {
  runId: string;
  threadId: string;
  inputMessageId: string;
  snapshot: RunExecutionSnapshotSeed;
}): RunExecutionSnapshotV1 {
  return parseRunExecutionSnapshot({
    ...input.snapshot,
    runId: input.runId,
    threadId: input.threadId,
    inputMessageId: input.inputMessageId
  });
}

export function parseRunExecutionSnapshot(value: unknown): RunExecutionSnapshotV1 {
  const snapshot = runExecutionSnapshotV1Schema.parse(value);
  if (!isRunCapabilityManifestIntegrityValid(snapshot.capabilityManifest)) {
    throw new Error('run_execution_snapshot_manifest_hash_invalid');
  }
  return snapshot;
}

export function createChatStartRunRequestFromSnapshot(
  snapshot: RunExecutionSnapshotV1,
  run: TaskRun
): ChatStartRunRequest {
  const request: ChatStartRunRequest = {
    input: run.userInput,
    mode: snapshot.mode === 'run' ? 'chat' : snapshot.mode,
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
  return request;
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
