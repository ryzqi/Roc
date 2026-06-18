import { CheckCircle2, FlaskConical, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { McpServerSnapshot, McpServerTestResult } from '../../../shared/types';
import { StatusPill } from '../../components/StatusPill';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

async function refreshMcpState(client: RocClient, updateLoadedState: (partial: Partial<LoadedState>) => void): Promise<void> {
  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await client.api.mcp.listServers());
  updateLoadedState({
    mcpServers,
    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
  });
}

function formatRiskLevel(server: McpServerSnapshot): NonNullable<McpServerSnapshot['riskLevel']> {
  if (server.riskLevel === undefined) {
    return 'low';
  }
  return server.riskLevel;
}

function formatEndpoint(server: McpServerSnapshot): string {
  if (server.transport === 'stdio') {
    if (server.command === undefined) {
      return 'stdio command 未配置';
    }
    return server.command;
  }
  if (server.url === undefined) {
    return `${server.transport.toUpperCase()} URL 未配置`;
  }
  return server.url;
}

export function McpManagementPanel({
  client,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const updateLoadedStateRef = useRef(updateLoadedState);
  updateLoadedStateRef.current = updateLoadedState;

  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  useEffect(() => {
    let cancelled = false;
    const mcpClient = resolveClient();
    void mcpClient.api.mcp
      .listServers()
      .then((result) => {
        if (cancelled) {
          return;
        }
        const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', result);
        updateLoadedStateRef.current({
          mcpServers,
          selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
        });
      })
      .catch((error: unknown) => {
        console.error('MCP state refresh failed.', error);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <section className="mcp-management-panel" data-testid="mcp-management">
      <div className="mcp-management-toolbar">
        <div className="mcp-management-title">
          <h2 className="section-title">MCP 服务与工具</h2>
          <p className="mcp-security-note" data-testid="mcp-global-approval-hint">
            <ShieldAlert aria-hidden="true" />
            <span>MCP 调用是否需要审批由全局策略统一控制，请前往“设置 → 授权与安全”切换；该处不影响 execute / web_read。</span>
          </p>
        </div>
        {state.mcpTestStatus === null ? null : <StatusPill label="本地测试" tone={state.mcpTestStatus.status === 'ready' ? 'ok' : 'warn'} value={`${state.mcpTestStatus.serverId}:${state.mcpTestStatus.status}`} />}
      </div>
      {state.mcpServers.length === 0 ? (
        <div className="mcp-empty-panel">
          <strong>尚未配置 MCP server</strong>
          <span>添加服务后，可在这里查看连接方式、风险等级、工具数量和启用状态。</span>
        </div>
      ) : (
        <div className="mcp-server-table">
          {state.mcpServers.map((server) => {
            const riskLevel = formatRiskLevel(server);
            return (
              <article className="mcp-server-row" key={server.id}>
                <div className="mcp-server-main">
                  <div className="mcp-server-title-row">
                    <h3 className="mcp-server-name">{server.name}</h3>
                    <span className={server.enabled ? 'mcp-enabled-pill is-enabled' : 'mcp-enabled-pill is-disabled'}>{server.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div className="mcp-server-id">{server.id}</div>
                  <div className="mcp-server-endpoint">{formatEndpoint(server)}</div>
                </div>
                <dl className="mcp-server-facts">
                  <div>
                    <dt>Status</dt>
                    <dd>{server.status}</dd>
                  </div>
                  <div>
                    <dt>Transport</dt>
                    <dd>{server.transport}</dd>
                  </div>
                  <div>
                    <dt>Risk</dt>
                    <dd className={`mcp-risk-value mcp-risk-value--${riskLevel}`}>{riskLevel}</dd>
                  </div>
                  <div>
                    <dt>Tools</dt>
                    <dd>{server.tools} 个工具</dd>
                  </div>
                </dl>
                <div className="mcp-server-actions">
                  <button
                    data-testid={`mcp-test-${server.id}`}
                    type="button"
                    onClick={() => {
                      void resolveClient().api.mcp.testServer(server.id).then((result) => {
                        updateLoadedState({ mcpTestStatus: unwrap<McpServerTestResult>('mcp test', result) });
                      });
                    }}
                  >
                    <FlaskConical aria-hidden="true" />
                    <span>测试</span>
                  </button>
                  <button
                    data-testid={`mcp-toggle-${server.id}`}
                    type="button"
                    onClick={() => {
                      const mcpClient = resolveClient();
                      void mcpClient.api.mcp.setServerEnabled({ id: server.id, enabled: !server.enabled }).then(async () => {
                        await refreshMcpState(mcpClient, updateLoadedState);
                      });
                    }}
                  >
                    {server.enabled ? <XCircle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                    <span>{server.enabled ? '禁用' : '启用'}</span>
                  </button>
                  <button
                    className="mcp-danger-button"
                    data-testid={`mcp-delete-${server.id}`}
                    type="button"
                    onClick={() => {
                      const mcpClient = resolveClient();
                      void mcpClient.api.mcp.deleteServer(server.id).then(async () => {
                        await refreshMcpState(mcpClient, updateLoadedState);
                      });
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    <span>删除</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
