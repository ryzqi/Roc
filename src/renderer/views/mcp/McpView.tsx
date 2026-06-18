import { PageHeading } from '../../components/PageHeading';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { sumMcpTools } from '../../utils/sum-mcp-tools';
import { McpManagementPanel } from './McpManagementPanel';

export function McpView({
  client,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const enabledServers = state.mcpServers.filter((server) => server.enabled).length;
  const totalTools = sumMcpTools(state.mcpServers);
  const riskyServers = state.mcpServers.filter((server) => server.riskLevel === 'medium' || server.riskLevel === 'high').length;

  return (
    <>
      <PageHeading title="MCP" meta={`本机 ${state.mcpServers.length} 个服务 · ${totalTools} 个工具`} />
      <section className="canvas-stage stage-grid mcp-dashboard" data-testid="mcp-view">
        <div className="mcp-compact-summary">
          <span>{state.mcpServers.length} 个服务</span>
          <span>{enabledServers} 个已启用</span>
          <span>{totalTools} 个工具</span>
          <span>{riskyServers} 个风险服务</span>
        </div>
        <McpManagementPanel client={client} state={state} updateLoadedState={updateLoadedState} />
      </section>
    </>
  );
}
