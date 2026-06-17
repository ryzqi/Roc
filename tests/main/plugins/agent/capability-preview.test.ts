import { describe, expect, it } from 'vitest';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import type { AgentRuntimeStatus } from '../../../../src/shared/types';

describe('agent capability preview', () => {
  it('does not show background task tools in ordinary agent capability preview', () => {
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

    expect(preview.toolCards.map((card) => card.name)).not.toEqual(
      expect.arrayContaining([
        'resolve_background_task_time',
        'propose_background_task',
        'schedule_background_task',
        'read_background_task',
        'update_background_task',
        'cancel_background_task'
      ])
    );
    expect(preview.interruptOn.update_background_task).toBeUndefined();
    expect(preview.interruptOn.cancel_background_task).toBeUndefined();
    const card = preview.toolCards.find((item) => item.name === 'run_shell_command');
    expect(card).toMatchObject({
      id: 'builtin:run_shell_command',
      name: 'run_shell_command',
      capabilityType: 'terminal_tool',
      requiredInput: 'PowerShell command',
      dependencies: ['ShellExecutionService', 'RtkService'],
      auditCategory: 'agent_execute'
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
