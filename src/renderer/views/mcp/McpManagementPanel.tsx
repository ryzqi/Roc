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

export function McpManagementPanel({
  client,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  return (
    <section className="single-panel" data-testid="mcp-management">
      <div className="section-head">
        <h2 className="section-title">MCP 服务与工具</h2>
        {state.mcpTestStatus === null ? null : <StatusPill label="本地测试" tone={state.mcpTestStatus.status === 'ready' ? 'ok' : 'warn'} value={`${state.mcpTestStatus.serverId}:${state.mcpTestStatus.status}`} />}
      </div>
      <p className="muted" data-testid="mcp-global-approval-hint">
        MCP 调用是否需要审批由全局策略统一控制，请前往“设置 → 授权与安全”切换；该处不影响 execute / web_read。
      </p>
      {state.mcpServers.length === 0 ? (
        <p className="muted">尚未配置 MCP server。</p>
      ) : (
        <div className="list-rows">
          {state.mcpServers.map((server) => (
            <div className="row action-row" key={server.id}>
              <div>
                <div className="row-title">{server.name}</div>
                <div className="row-sub">
                  {server.id}:{server.status} · {server.transport} · {server.riskLevel === undefined ? 'low' : server.riskLevel}
                </div>
              </div>
              <span className={server.enabled ? 'pill ok' : 'pill warn'}>{server.enabled ? 'enabled' : 'disabled'}</span>
              <button
                data-testid={`mcp-test-${server.id}`}
                type="button"
                onClick={() => {
                  void resolveClient().api.mcp.testServer(server.id).then((result) => {
                    updateLoadedState({ mcpTestStatus: unwrap<McpServerTestResult>('mcp test', result) });
                  });
                }}
              >
                测试
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
                {server.enabled ? '禁用' : '启用'}
              </button>
              <button
                data-testid={`mcp-delete-${server.id}`}
                type="button"
                onClick={() => {
                  const mcpClient = resolveClient();
                  void mcpClient.api.mcp.deleteServer(server.id).then(async () => {
                    await refreshMcpState(mcpClient, updateLoadedState);
                  });
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
