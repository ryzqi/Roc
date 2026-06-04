import type { LazyLoadState } from '../../app/types';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { DiagnosticsView } from '../../views/diagnostics/DiagnosticsView';

export function DiagnosticsFeature({
  loadState,
  state
}: {
  client: RocClient;
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  return <DiagnosticsView loadState={loadState} state={state} />;
}
