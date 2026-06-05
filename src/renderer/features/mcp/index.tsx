import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { McpView } from '../../views/mcp/McpView';

export function McpFeature({
  client,
  state,
  updateLoadedState
}: {
  client: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return <McpView client={client} state={state} updateLoadedState={updateLoadedState} />;
}
