import { describe, expect, it } from 'vitest';
import { buildAgentCapabilityPreview } from '../../../../src/main/plugins/agent/capability-preview';
import type { AgentRuntimeStatus } from '../../../../src/shared/types';

describe('agent capability preview', () => {
  it('does not show background task tools in ordinary agent capability preview', () => {
    const preview = buildAgentCapabilityPreview({
      deleteFileApprovalMode: 'default',
      mcpApprovalMode: 'default',
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
    expect(preview.subagents.map((subagent) => subagent.id)).toEqual(['research']);
  });

  it('uses delete_file and MCP approval modes independently', () => {
    const mcpDefaultPreview = buildAgentCapabilityPreview({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'default',
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          status: 'ready',
          tools: 1,
          preset: false,
          riskLevel: 'medium',
          url: 'https://docs.example.test/mcp',
          allowedTools: ['search_docs'],
          lastError: null
        }
      ],
      requestedCapabilities: {
        mcpServers: ['docs'],
        skills: []
      },
      runtimeStatus: readyRuntimeStatus(),
      skills: []
    });

    expect(mcpDefaultPreview.toolCards.find((card) => card.name === 'delete_file')?.requiresApproval).toBe(false);
    expect(mcpDefaultPreview.toolCards.find((card) => card.name === 'search_docs')?.requiresApproval).toBe(true);
    expect(mcpDefaultPreview.interruptOn.delete_file).toBeUndefined();
    expect(mcpDefaultPreview.interruptOn.search_docs).toEqual({
      allowedDecisions: ['approve', 'reject']
    });

    const deleteFileDefaultPreview = buildAgentCapabilityPreview({
      deleteFileApprovalMode: 'default',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          status: 'ready',
          tools: 1,
          preset: false,
          riskLevel: 'medium',
          url: 'https://docs.example.test/mcp',
          allowedTools: ['search_docs'],
          lastError: null
        }
      ],
      requestedCapabilities: {
        mcpServers: ['docs'],
        skills: []
      },
      runtimeStatus: readyRuntimeStatus(),
      skills: []
    });

    expect(deleteFileDefaultPreview.toolCards.find((card) => card.name === 'delete_file')?.requiresApproval).toBe(true);
    expect(deleteFileDefaultPreview.toolCards.find((card) => card.name === 'search_docs')?.requiresApproval).toBe(false);
    expect(deleteFileDefaultPreview.interruptOn.delete_file).toEqual({
      allowedDecisions: ['approve', 'edit', 'reject']
    });
    expect(deleteFileDefaultPreview.interruptOn.search_docs).toBeUndefined();
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
