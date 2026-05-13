import type { McpServerSnapshot, McpServerTestResult } from '../../../shared/types';
import { StatusPill } from '../../components/StatusPill';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';

async function refreshMcpState(updateLoadedState: (partial: Partial<LoadedState>) => void): Promise<void> {
  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await window.roc.mcp.listServers());
  updateLoadedState({
    mcpServers,
    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
  });
}

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
      <p className="muted">仅控制该 MCP server 的工具调用是否进入审批，不影响 execute / web_read。</p>
      {state.mcpServers.length === 0 ? (
        <p className="muted">尚未配置 MCP server。</p>
      ) : (
        state.mcpServers.map((server) => (
          <div className="row action-row" key={server.id}>
            <div>
              <div className="row-title">{server.name}</div>
              <div className="row-sub">
                {server.id}:{server.status} · {server.transport} · {server.riskLevel === undefined ? 'low' : server.riskLevel} · 审批策略：
                {' '}
                {server.approvalMode === 'auto_approve' ? '全自动执行' : '每次审批'}
              </div>
              <div className="row-sub" data-testid={`mcp-approval-mode-${server.id}`}>
                <label>
                  <input
                    data-testid={`mcp-approval-always-${server.id}`}
                    type="radio"
                    name={`mcp-approval-${server.id}`}
                    checked={server.approvalMode === 'always_confirm'}
                    onChange={() => {
                      void window.roc.mcp.setServerApprovalMode({ id: server.id, approvalMode: 'always_confirm' }).then(async () => {
                        await refreshMcpState(updateLoadedState);
                      });
                    }}
                  />
                  每次审批
                </label>
                {' '}
                <label>
                  <input
                    data-testid={`mcp-approval-auto-${server.id}`}
                    type="radio"
                    name={`mcp-approval-${server.id}`}
                    checked={server.approvalMode === 'auto_approve'}
                    onChange={() => {
                      void window.roc.mcp.setServerApprovalMode({ id: server.id, approvalMode: 'auto_approve' }).then(async () => {
                        await refreshMcpState(updateLoadedState);
                      });
                    }}
                  />
                  全自动执行
                </label>
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
                  await refreshMcpState(updateLoadedState);
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
                  await refreshMcpState(updateLoadedState);
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
