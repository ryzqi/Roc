import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { McpManagementPanel } from '../../src/renderer/views/mcp/McpManagementPanel';
import { createLoadedState } from './view-test-helpers';

describe('McpManagementPanel', () => {
  it('renders the global approval hint and current status for each MCP server', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpManagementPanel, {
        state: createLoadedState({
          mcpServers: [
            {
              id: 'docs-http',
              name: 'Docs HTTP',
              enabled: true,
              transport: 'http',
              status: 'not_connected',
              tools: 1,
              preset: false,
              riskLevel: 'medium',
              url: 'https://docs.example.test/mcp',
              allowedTools: ['search_docs'],
              lastError: null
            },
            {
              id: 'exa-hosted',
              name: 'Exa Hosted MCP',
              enabled: true,
              transport: 'http',
              status: 'ready',
              tools: 2,
              preset: true,
              riskLevel: 'medium',
              url: 'https://mcp.exa.ai/mcp',
              allowedTools: ['web_search_exa', 'web_search_advanced_exa'],
              lastError: null
            }
          ]
        }),
        updateLoadedState: () => {}
      })
    );

    expect(html).toContain('data-testid="mcp-management"');
    expect(html).toContain('data-testid="mcp-global-approval-hint"');
    expect(html).toContain('class="mcp-management-panel"');
    expect(html).toContain('class="mcp-management-toolbar"');
    expect(html).toContain('class="mcp-security-note"');
    expect(html).toContain('class="mcp-server-table"');
    expect(html).toContain('class="mcp-server-row"');
    expect(html).toContain('MCP 调用是否需要审批由全局策略统一控制');
    expect(html).toContain('设置 → 授权与安全');
    expect(html).toContain('不影响 execute / web_read');
    expect(html).toContain('Docs HTTP');
    expect(html).toContain('docs-http');
    expect(html).toContain('not_connected');
    expect(html).toContain('http');
    expect(html).toContain('medium');
    expect(html).toContain('1 个工具');
    expect(html).toContain('Exa Hosted MCP');
    expect(html).toContain('ready');
    expect(html).toContain('2 个工具');
    expect(html).not.toContain('class="card"');
    expect(html).not.toContain('card-title');
    expect(html).not.toContain('class="row action-row"');
    expect(html).not.toContain('mcp-security-banner');
    expect(html).not.toContain('mcp-server-card');
    expect(html).not.toContain('mcp-approval-mode-');
    expect(html).not.toContain('mcp-approval-always-');
    expect(html).not.toContain('mcp-approval-auto-');
  });
});
