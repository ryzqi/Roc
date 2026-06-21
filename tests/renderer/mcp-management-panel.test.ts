// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpManagementPanel } from '../../src/renderer/views/mcp/McpManagementPanel';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { createLoadedState } from './view-test-helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('McpManagementPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders MCP approval controls and current status for each MCP server', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpManagementPanel, {
        client: {
          api: {
            mcp: {
              getConfig: async () => ({ ok: true as const, data: { schemaVersion: 1 as const, approvalMode: 'default' as const, servers: [] } }),
              listServers: async () => ({ ok: true as const, data: [] }),
              setApprovalMode: async () => ({ ok: true as const, data: { schemaVersion: 1 as const, approvalMode: 'default' as const, servers: [] } })
            }
          } as unknown as RocPreloadApi
        },
        state: createLoadedState({
          mcpApprovalMode: 'default',
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
    expect(html).toContain('data-testid="mcp-approval-mode-default"');
    expect(html).toContain('data-testid="mcp-approval-mode-fully-automatic"');
    expect(html).toContain('class="mcp-approval-mode-option is-selected"');
    expect(html).toContain('class="mcp-management-panel"');
    expect(html).toContain('class="mcp-management-toolbar"');
    expect(html).not.toContain('class="mcp-toolbar-metrics"');
    expect(html).not.toContain('2 个服务');
    expect(html).not.toContain('2 个已启用');
    expect(html).not.toContain('3 个工具');
    expect(html).not.toContain('2 个风险服务');
    expect(html).not.toContain('data-testid="mcp-global-approval-hint"');
    expect(html).not.toContain('class="mcp-security-note"');
    expect(html).toContain('class="mcp-server-table"');
    expect(html).toContain('class="mcp-server-row"');
    expect(html).not.toContain('MCP 工具审批只在这里配置');
    expect(html).toContain('MCP 工具调用前弹出审批卡');
    expect(html).not.toContain('execute / web_read');
    expect(html).toContain('Docs HTTP');
    expect(html).toContain('docs-http');
    expect(html).toContain('not_connected');
    expect(html).toContain('http');
    expect(html).not.toContain('<dt>Risk</dt>');
    expect(html).not.toContain('mcp-risk-value');
    expect(html).toContain('1 个工具');
    expect(html).toContain('Exa Hosted MCP');
    expect(html).toContain('ready');
    expect(html).toContain('2 个工具');
    expect(html).not.toContain('class="card"');
    expect(html).not.toContain('card-title');
    expect(html).not.toContain('class="row action-row"');
    expect(html).not.toContain('mcp-security-banner');
    expect(html).not.toContain('mcp-server-card');
    expect(html).not.toContain('mcp-approval-always-');
    expect(html).not.toContain('mcp-approval-auto-');
  });

  it('shows one server detail panel after clicking a server row', async () => {
    await act(async () => {
      root.render(
        React.createElement(McpManagementPanel, {
          client: {
            api: {
              mcp: {
                getConfig: async () => ({ ok: true as const, data: { schemaVersion: 1 as const, approvalMode: 'default' as const, servers: [] } }),
                listServers: async () => ({ ok: true as const, data: [] }),
                setApprovalMode: async () => ({ ok: true as const, data: { schemaVersion: 1 as const, approvalMode: 'default' as const, servers: [] } })
              }
            } as unknown as RocPreloadApi
          },
          state: createLoadedState({
            mcpApprovalMode: 'default',
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
                id: 'local-stdio',
                name: 'Local STDIO',
                enabled: false,
                transport: 'stdio',
                status: 'error',
                tools: 2,
                preset: false,
                riskLevel: 'low',
                command: 'node local-mcp.js',
                allowedTools: ['read_local', 'write_local'],
                lastError: '启动失败'
              }
            ]
          }),
          updateLoadedState: () => {}
        })
      );
    });

    expect(container.querySelector('[data-testid="mcp-server-details-docs-http"]')).toBeNull();

    const docsRow = container.querySelector<HTMLElement>('[data-testid="mcp-server-row-docs-http"]');
    if (docsRow === null) {
      throw new Error('docs-http row missing');
    }
    await act(async () => {
      docsRow.click();
    });

    expect(container.querySelector('[data-testid="mcp-server-details-docs-http"]')?.textContent).toContain('https://docs.example.test/mcp');
    expect(container.querySelector('[data-testid="mcp-server-details-docs-http"]')?.textContent).toContain('search_docs');
    expect(container.querySelector('[data-testid="mcp-server-details-local-stdio"]')).toBeNull();

    const localRow = container.querySelector<HTMLElement>('[data-testid="mcp-server-row-local-stdio"]');
    if (localRow === null) {
      throw new Error('local-stdio row missing');
    }
    await act(async () => {
      localRow.click();
    });

    expect(container.querySelector('[data-testid="mcp-server-details-docs-http"]')).toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-details-local-stdio"]')?.textContent).toContain('node local-mcp.js');
    expect(container.querySelector('[data-testid="mcp-server-details-local-stdio"]')?.textContent).toContain('启动失败');
  });
});
