import type { McpServerSnapshot, McpServerTestResult } from '../../../shared/types';
import { StatusPill } from '../../components/StatusPill';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';

export function McpManagementPanel({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <section className="card" data-testid="mcp-management">
      <div className="card-title">
        MCP 服务与工具
        {state.mcpTestStatus === null ? null : <StatusPill label="本地测试" tone={state.mcpTestStatus.status === 'ready' ? 'ok' : 'warn'} value={`${state.mcpTestStatus.serverId}:${state.mcpTestStatus.status}`} />}
      </div>
      {state.mcpServers.length === 0 ? (
        <p className="muted">尚未配置 MCP server。</p>
      ) : (
        state.mcpServers.map((server) => (
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
                void window.roc.mcp.testServer(server.id).then((result) => {
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
                void window.roc.mcp.setServerEnabled({ id: server.id, enabled: !server.enabled }).then(async () => {
                  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await window.roc.mcp.listServers());
                  updateLoadedState({
                    mcpServers,
                    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
                  });
                });
              }}
            >
              {server.enabled ? '禁用' : '启用'}
            </button>
            <button
              data-testid={`mcp-delete-${server.id}`}
              type="button"
              onClick={() => {
                void window.roc.mcp.deleteServer(server.id).then(async () => {
                  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await window.roc.mcp.listServers());
                  updateLoadedState({
                    mcpServers,
                    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
                  });
                });
              }}
            >
              删除
            </button>
          </div>
        ))
      )}
    </section>
  );
}
