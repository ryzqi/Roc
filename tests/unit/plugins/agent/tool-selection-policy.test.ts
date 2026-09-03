import { describe, it, expect } from 'vitest';
import type { McpServerSnapshot } from '../../../../src/shared/types';
import { DefaultToolSelectionPolicy } from '../../../../src/main/plugins/agent/tool-selection-policy';

describe('DefaultToolSelectionPolicy', () => {
  const policy = new DefaultToolSelectionPolicy();

  it('总是包含 web_read', () => {
    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'web_read')).toBe(true);
  });

  it('总是包含 delete_file', () => {
    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'delete_file')).toBe(true);
  });

  it('当 shellAllowedCommands 未定义时包含 run_shell_command', () => {
    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'run_shell_command')).toBe(true);
  });

  it('当 shellAllowedCommands 为空数组时排除 run_shell_command', () => {
    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: false,
      shellAllowedCommands: []
    });

    expect(cards.some((c) => c.name === 'run_shell_command')).toBe(false);
  });

  it('仅在 chat mode 且 selfConfigAvailable 时包含 roc_self_config', () => {
    const chatCards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: true,
      shellAllowedCommands: undefined
    });

    expect(chatCards.some((c) => c.name === 'roc_self_config')).toBe(true);

    const planCards = policy.selectToolCards({
      mode: 'plan',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: true,
      shellAllowedCommands: undefined
    });

    expect(planCards.some((c) => c.name === 'roc_self_config')).toBe(false);
  });

  it('plan mode 过滤只保留允许的工具', () => {
    const cards = policy.selectToolCards({
      mode: 'plan',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    // plan mode 允许的工具
    expect(cards.some((c) => c.name === 'web_read')).toBe(true);

    // plan mode 不允许 run_shell_command（即使 shellAllowedCommands 未定义）
    // 注意：这里的逻辑是先构造所有卡片，再过滤
    // run_shell_command 不在 plan mode 白名单中
    expect(cards.some((c) => c.name === 'run_shell_command')).toBe(false);
  });

  it('包含 enabled MCP 服务器的工具', () => {
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'test-server',
        name: 'Test Server',
        enabled: true,
        transport: 'stdio',
        status: 'ready',
        tools: 2,
        allowedTools: ['test_tool_1', 'test_tool_2'],
        riskLevel: 'medium'
      }
    ];

    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers,
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'test_tool_1')).toBe(true);
    expect(cards.some((c) => c.name === 'test_tool_2')).toBe(true);
  });

  it('排除 disabled MCP 服务器的工具', () => {
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'disabled-server',
        name: 'Disabled Server',
        enabled: false,
        transport: 'stdio',
        status: 'not_connected',
        tools: 1,
        allowedTools: ['disabled_tool'],
        riskLevel: 'medium'
      }
    ];

    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers,
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'disabled_tool')).toBe(false);
  });

  it('exa-hosted 服务器生成 web_search 工具', () => {
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'exa-hosted',
        name: 'Exa Hosted',
        enabled: true,
        transport: 'http',
        status: 'ready',
        tools: 1,
        riskLevel: 'medium'
      }
    ];

    const cards = policy.selectToolCards({
      mode: 'chat',
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers,
      selfConfigAvailable: false,
      shellAllowedCommands: undefined
    });

    expect(cards.some((c) => c.name === 'web_search' && c.id === 'mcp:exa-hosted:web_search')).toBe(true);
  });

  it('抛出错误当 MCP 工具名冲突保留名称', () => {
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'bad-server',
        name: 'Bad Server',
        enabled: true,
        transport: 'stdio',
        status: 'ready',
        tools: 1,
        allowedTools: ['read_file'], // 保留名称
        riskLevel: 'medium'
      }
    ];

    expect(() => {
      policy.selectToolCards({
        mode: 'chat',
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers,
        selfConfigAvailable: false,
        shellAllowedCommands: undefined
      });
    }).toThrow('run_capability_model_visible_name_reserved:read_file');
  });
});
