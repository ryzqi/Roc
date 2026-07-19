import type { AgentCapabilityPreview, ChatStartRunRequest } from '../../../../src/shared/types';
import type { AgentCapabilityPreviewProvider } from '../../../../src/main/plugins/agent/runtime';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';

export function createTestCapabilityPreviewProvider(): AgentCapabilityPreviewProvider {
  return async ({ mode, requestedCapabilities, workflowHint }) =>
    createTestCapabilityPreview(mode, requestedCapabilities, workflowHint);
}

export function createTestCapabilityPreview(
  mode: ChatStartRunRequest['mode'],
  requestedCapabilities: ChatStartRunRequest['enabledCapabilities'],
  workflowHint: ChatStartRunRequest['workflowHint'] = null
): AgentCapabilityPreview {
  const compiled = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: requestedCapabilities.mcpServers.map((id) => ({
      id,
      name: id,
      enabled: true,
      transport: 'http' as const,
      status: 'ready' as const,
      tools: 0,
      allowedTools: []
    })),
    mode,
    requestedCapabilities,
    workflowHint,
    skills: requestedCapabilities.skills.map((id) => ({
      id,
      name: id,
      enabled: true,
      path: `F:\\skills\\${id}`,
      description: `${id} skill`,
      status: 'ready' as const
    }))
  });
  return {
    runnable: false,
    modelId: 'test-model',
    builtInTools: [],
    selectedCapabilities: compiled.manifest.resolvedCapabilities,
    requestedCapabilities: compiled.manifest.requestedCapabilities,
    skippedCapabilities: compiled.manifest.skippedCapabilities,
    toolCards: compiled.toolCards,
    skillCards: compiled.skillCards,
    subagents: compiled.subagents,
    interruptOn: compiled.interruptOn,
    manifest: compiled.manifest,
    untrustedContextPolicy: compiled.manifest.untrustedContextPolicy,
    reason: 'test'
  };
}
