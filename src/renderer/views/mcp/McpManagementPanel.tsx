import { CheckCircle2, ChevronDown, ChevronRight, FlaskConical, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode, McpServerSnapshot, McpServerTestResult } from '../../../shared/types';
import { StatusPill } from '../../components/StatusPill';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

async function refreshMcpState(client: RocClient, updateLoadedState: (partial: Partial<LoadedState>) => void): Promise<void> {
  const [configResult, serversResult] = await Promise.all([client.api.mcp.getConfig(), client.api.mcp.listServers()]);
  const mcpConfig = unwrap('mcp config', configResult);
  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', serversResult);
  updateLoadedState({
    mcpApprovalMode: mcpConfig.approvalMode,
    mcpServers,
    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
  });
}

const approvalModes: Array<{
  value: ApprovalMode;
  title: string;
  description: string;
  testId: string;
}> = [
  {
    value: 'fully_automatic',
    title: '全自动',
    description: '直接执行 MCP 工具调用，不弹出审批卡。',
    testId: 'mcp-approval-mode-fully-automatic'
  },
  {
    value: 'default',
    title: '默认',
    description: 'MCP 工具调用前弹出审批卡。',
    testId: 'mcp-approval-mode-default'
  }
];

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

function formatAllowedTools(server: McpServerSnapshot): string {
  if (server.allowedTools === undefined || server.allowedTools.length === 0) {
    return '未限制工具';
  }
  return server.allowedTools.join(', ');
}

function formatLastError(server: McpServerSnapshot): string {
  if (server.lastError === null || server.lastError === undefined) {
    return '无';
  }
  return server.lastError;
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
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);

  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  function setApprovalMode(approvalMode: ApprovalMode): void {
    const mcpClient = resolveClient();
    void mcpClient.api.mcp.setApprovalMode({ approvalMode }).then(async (result) => {
      const mcpConfig = unwrap('mcp config', result);
      updateLoadedState({ mcpApprovalMode: mcpConfig.approvalMode });
      await refreshMcpState(mcpClient, updateLoadedState);
    });
  }

  function toggleServerDetails(serverId: string): void {
    setExpandedServerId((current) => {
      if (current === serverId) {
        return null;
      }
      return serverId;
    });
  }

  useEffect(() => {
    let cancelled = false;
    const mcpClient = resolveClient();
    void Promise.all([mcpClient.api.mcp.getConfig(), mcpClient.api.mcp.listServers()])
      .then(([configResult, serversResult]) => {
        if (cancelled) {
          return;
        }
        const mcpConfig = unwrap('mcp config', configResult);
        const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', serversResult);
        updateLoadedStateRef.current({
          mcpApprovalMode: mcpConfig.approvalMode,
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

  useEffect(() => {
    if (expandedServerId === null) {
      return;
    }
    if (state.mcpServers.some((server) => server.id === expandedServerId)) {
      return;
    }
    setExpandedServerId(null);
  }, [expandedServerId, state.mcpServers]);

  return (
    <section className="mcp-management-panel" data-testid="mcp-management">
      <div className="mcp-management-toolbar">
        <div className="mcp-management-title">
          <h2 className="section-title">MCP 服务与工具</h2>
        </div>
        <div className="mcp-toolbar-status">
          <div className="mcp-approval-mode-group" aria-label="MCP 工具审批模式">
            {approvalModes.map((option) => (
              <label className={state.mcpApprovalMode === option.value ? 'mcp-approval-mode-option is-selected' : 'mcp-approval-mode-option'} key={option.value}>
                <input
                  checked={state.mcpApprovalMode === option.value}
                  data-testid={option.testId}
                  name="mcp-approval-mode"
                  onChange={() => setApprovalMode(option.value)}
                  type="radio"
                  value={option.value}
                />
                <span className="mcp-approval-mode-title">
                  {option.title}
                  {state.mcpApprovalMode === option.value ? <strong>当前</strong> : null}
                </span>
                <small>{option.description}</small>
              </label>
            ))}
          </div>
          {state.mcpTestStatus === null ? null : <StatusPill label="本地测试" tone={state.mcpTestStatus.status === 'ready' ? 'ok' : 'warn'} value={`${state.mcpTestStatus.serverId}:${state.mcpTestStatus.status}`} />}
        </div>
      </div>
      {state.mcpServers.length === 0 ? (
        <div className="mcp-empty-panel">
          <strong>尚未配置 MCP server</strong>
          <span>添加服务后，可在这里查看连接方式、工具数量和启用状态。</span>
        </div>
      ) : (
        <div className="mcp-server-table">
          {state.mcpServers.map((server) => {
            const isExpanded = expandedServerId === server.id;
            return (
              <article
                className={isExpanded ? 'mcp-server-row is-expanded' : 'mcp-server-row'}
                data-testid={`mcp-server-row-${server.id}`}
                key={server.id}
                onClick={() => toggleServerDetails(server.id)}
              >
                <button
                  aria-expanded={isExpanded}
                  className="mcp-server-summary"
                  type="button"
                >
                  <span className="mcp-server-main">
                    <span className="mcp-server-title-row">
                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                      <span className="mcp-server-name">{server.name}</span>
                      <span className={server.enabled ? 'mcp-enabled-pill is-enabled' : 'mcp-enabled-pill is-disabled'}>{server.enabled ? 'enabled' : 'disabled'}</span>
                    </span>
                    <span className="mcp-server-id">{server.id}</span>
                    <span className="mcp-server-endpoint">{formatEndpoint(server)}</span>
                  </span>
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
                      <dt>Tools</dt>
                      <dd>{server.tools} 个工具</dd>
                    </div>
                  </dl>
                  <span className="mcp-server-expand-state">{isExpanded ? '收起' : '展开'}</span>
                </button>
                <div
                  className="mcp-server-actions"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
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
                {isExpanded ? (
                  <div className="mcp-server-details" data-testid={`mcp-server-details-${server.id}`}>
                    <dl>
                      <div>
                        <dt>ID</dt>
                        <dd>{server.id}</dd>
                      </div>
                      <div>
                        <dt>Endpoint</dt>
                        <dd>{formatEndpoint(server)}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{server.status}</dd>
                      </div>
                      <div>
                        <dt>Transport</dt>
                        <dd>{server.transport}</dd>
                      </div>
                      <div>
                        <dt>Tools</dt>
                        <dd>{server.tools} 个工具</dd>
                      </div>
                      <div>
                        <dt>Allowed tools</dt>
                        <dd>{formatAllowedTools(server)}</dd>
                      </div>
                      <div>
                        <dt>Last error</dt>
                        <dd>{formatLastError(server)}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
