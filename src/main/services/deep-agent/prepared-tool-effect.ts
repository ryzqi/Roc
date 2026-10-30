import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'langchain';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1, RunExecutionSnapshot } from '../../../shared/types';
import { assertCapabilityManifestToolContract, normalizeToolCallArgs } from './tool-protocol';
import { normalizeFilesystemToolCall } from './filesystem-path-policy';
import { hashToolInput } from './tool-effect-store';
import { ToolExecutionGate } from './tool-execution-gate';
import {
  resolveToolAdmissionResources,
  ToolResourceCoordinator,
  type ToolAdmissionObserver
} from './tool-resource-coordinator';

export type PreparedToolEffect = Readonly<{ name: string; id: string | undefined; inputHash: string; signal: AbortSignal | undefined; tool: unknown }>;
const prepared = new AsyncLocalStorage<PreparedToolEffect>();
const gates = new Map<string, { gate: ToolExecutionGate; users: number }>();
const resourceCoordinator = new ToolResourceCoordinator();
async function acquire(key: string, writing: boolean, signal?: AbortSignal, limit?: number): Promise<() => void> {
  let entry = gates.get(key);
  if (entry === undefined) { entry = { gate: new ToolExecutionGate(), users: 0 }; gates.set(key, entry); }
  entry.users++;
  const leave = () => { if (--entry.users === 0) gates.delete(key); };
  try {
    const release = await entry.gate.acquire(writing, signal, limit);
    return () => { release(); leave(); };
  } catch (error) { leave(); throw error; }
}

export function createPreparedToolEffectMiddleware() {
  return createMiddleware({ name: 'RocPreparedToolEffectMiddleware', wrapToolCall: (request, handler) => {
    const effect = Object.freeze({ name: request.toolCall.name, id: request.toolCall.id, tool: request.tool,
      inputHash: hashToolInput(normalizeToolCallArgs(request.toolCall.name, request.toolCall.args)), signal: request.runtime.signal });
    return prepared.run(effect, () => handler(request));
  } });
}

export function createFinalToolGuardMiddleware(options: { manifest: RunCapabilityManifestV1; scope: RunCapabilityExecutionScopeV1; boundToolNames: readonly string[] }) {
  return createMiddleware({ name: 'RocFinalToolGuardMiddleware', wrapToolCall: async (request, handler) => {
    const effect = prepared.getStore();
    if (effect === undefined) throw new Error('prepared_tool_effect_missing');
    effect.signal?.throwIfAborted();
    if (request.runtime.signal !== effect.signal || request.tool !== effect.tool || request.toolCall.id !== effect.id || request.toolCall.name !== effect.name) throw new Error('prepared_tool_effect_identity_changed');
    assertCapabilityManifestToolContract({ capabilityManifest: options.manifest, executionScope: options.scope, boundToolNames: options.boundToolNames }, request);
    const policy = options.manifest.tools.find(tool => tool.modelVisibleName === effect.name)!;
    if (policy.effectClass !== 'none' && policy.effectClass !== 'network_read' && hashToolInput(request.toolCall.args) !== effect.inputHash) throw new Error('prepared_tool_effect_input_changed');
    const path = normalizeFilesystemToolCall(request);
    if (!path.ok) throw new Error(path.error);
    return handler(request);
  } });
}

/** Shared across main/child builders and runs. Complete resource sets are leased until the handler settles. */
export function createToolAdmissionMiddleware(options: {
  runId: string;
  maxConcurrent: number;
  manifest: RunCapabilityManifestV1;
  workspaceHash: string | null;
  workspacePath: string | null;
  workspaceIdentity: RunExecutionSnapshot['workspaceIdentity'];
  researchProjectId: string | null | undefined;
  observeAdmission?: ToolAdmissionObserver;
}) {
  return createMiddleware({ name: 'RocToolAdmissionMiddleware', wrapToolCall: async (request, handler) => {
    // A child coordinates leaf calls; holding a leaf slot here would deadlock at limit one.
    if (request.toolCall.name === 'task') return handler(request);
    const signal = prepared.getStore()?.signal;
    const releaseSlot = await acquire(`run:${options.runId}`, false, signal, options.maxConcurrent);
    let releaseResources: (() => void) | undefined;
    try {
      const policy = options.manifest.tools.find(tool => tool.modelVisibleName === request.toolCall.name);
      if (policy === undefined) throw new Error('tool_admission_manifest_missing');
      const resourceRequest = await resolveToolAdmissionResources({
        policy,
        runId: options.runId,
        workspaceHash: options.workspaceHash,
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
        researchProjectId: options.researchProjectId
      });
      releaseResources = await resourceCoordinator.acquire(
        resourceRequest.claims,
        signal,
        options.observeAdmission
      );
      await resourceRequest.verifyWorkspaceIdentity();
      signal?.throwIfAborted();
      return await handler(request);
    } finally {
      releaseResources?.();
      releaseSlot();
    }
  } });
}
