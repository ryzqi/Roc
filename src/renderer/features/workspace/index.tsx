import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { WorkspaceView } from '../../views/workspace/WorkspaceView';

export function WorkspaceFeature({
  loadState,
  onSelectWorkspace,
  state
}: {
  client: RocClient;
  loadState: LazyLoadState;
  onSelectWorkspace: () => Promise<void>;
  state: LoadedState;
}): React.JSX.Element {
  return <WorkspaceView loadState={loadState} onSelectWorkspace={onSelectWorkspace} state={state} />;
}
