// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpFeature } from '../../../src/renderer/features/mcp';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import { createLoadedState } from '../view-test-helpers';

describe('McpFeature', () => {
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

  it('keeps the MCP view wrapper around the management panel', () => {
    const html = renderToStaticMarkup(
      <McpFeature
        client={{ api: {} as unknown as RocPreloadApi } satisfies RocClient}
        state={createLoadedState({
          mcpServers: [
            {
              id: 'smoke-mcp',
              name: 'Smoke MCP',
              enabled: true,
              status: 'ready',
              transport: 'http',
              tools: 1,
              riskLevel: 'low',
              preset: false,
              url: 'http://127.0.0.1:65534/mcp'
            }
          ],
          mcpTestStatus: null
        })}
        updateLoadedState={() => {}}
      />
    );

    expect(html).toContain('data-testid="mcp-view"');
    expect(html).toContain('data-testid="mcp-management"');
    expect(html).toContain('data-testid="mcp-test-smoke-mcp"');
  });

  it('refreshes plugin MCP servers when the feature mounts', async () => {
    const server = {
      id: 'smoke-mcp',
      name: 'Smoke MCP',
      enabled: true,
      status: 'ready' as const,
      transport: 'http' as const,
      tools: 1,
      riskLevel: 'low' as const,
      preset: false,
      url: 'http://127.0.0.1:65534/mcp'
    };
    const listServers = vi.fn(async () => ({ ok: true as const, data: [server] }));
    const updateLoadedState = vi.fn();

    await act(async () => {
      root.render(
        <McpFeature
          client={{ api: { mcp: { listServers } } as unknown as RocPreloadApi }}
          state={createLoadedState({ mcpServers: [], selectedMcpServers: [], mcpTestStatus: null })}
          updateLoadedState={updateLoadedState}
        />
      );
    });

    expect(listServers).toHaveBeenCalledTimes(1);
    expect(updateLoadedState).toHaveBeenCalledWith({
      mcpServers: [server],
      selectedMcpServers: ['smoke-mcp']
    });
  });
});
