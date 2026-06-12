import { describe, expect, it } from 'vitest';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import type { AgentRuntimeStatus } from '../../../../src/shared/types';

describe('agent capability preview', () => {
  it('allows editing cancel_background_task approvals', () => {
    const preview = buildAgentCapabilityPreview({
      approvalMode: 'default',
      mcpServers: [],
      requestedCapabilities: {
        mcpServers: [],
        skills: []
      },
      runtimeStatus: readyRuntimeStatus(),
      skills: []
    });

    expect(preview.interruptOn.cancel_background_task).toEqual({
      allowedDecisions: ['approve', 'edit', 'reject']
    });
  });
});

function readyRuntimeStatus(): AgentRuntimeStatus {
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: true
    },
    defaultModelConfigured: true,
    defaultModelState: {
      status: 'ready',
      modelId: 'test-model',
      providerId: 'test-provider',
      reason: 'ready'
    },
    memoryAccess: 'store_backend',
    execution: 'ready'
  };
}
