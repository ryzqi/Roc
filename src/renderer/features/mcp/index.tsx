import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { McpManagementPanel } from '../../views/mcp/McpManagementPanel';

export function McpFeature({
  client,
  state,
  updateLoadedState
}: {
  client: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return <McpManagementPanel client={client} state={state} updateLoadedState={updateLoadedState} />;
}
