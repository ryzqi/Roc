import { PageHeading } from '../../components/PageHeading';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
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
  return (
    <>
      <PageHeading title="MCP" />
      <section className="canvas-stage stage-grid mcp-dashboard" data-testid="mcp-view">
        <McpManagementPanel
          client={client}
          state={state}
          updateLoadedState={updateLoadedState}
        />
      </section>
    </>
  );
}
