import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { MemoryView } from '../../views/memory/MemoryView';

export function MemoryFeature({
  client,
  loadState,
  state
}: {
  client: RocClient;
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  return <MemoryView client={client} loadState={loadState} state={state} />;
}
