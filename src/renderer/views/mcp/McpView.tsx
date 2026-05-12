import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import type { LoadedState } from '../../loaded-state';
import { sumMcpTools } from '../../utils/sum-mcp-tools';
import { McpManagementPanel } from './McpManagementPanel';

export function McpView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="控制面" title="MCP" />
      <section className="canvas-stage stage-grid" data-testid="mcp-view">
        <div className="grid-3">
          <Metric label="MCP 服务" note={`${state.mcpServers.filter((server) => server.enabled).length} 个已启用`} value={state.mcpServers.length} />
          <Metric label="MCP 工具" note="来自服务快照" value={sumMcpTools(state.mcpServers)} />
          <Metric label="长期授权" note="均可撤销" tone="warn" value={state.mcpServers.filter((server) => server.riskLevel !== 'low').length} />
        </div>
        <McpManagementPanel state={state} updateLoadedState={updateLoadedState} />
      </section>
    </>
  );
}
