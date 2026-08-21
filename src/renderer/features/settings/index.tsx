import type { RocClient } from '../../shared/roc-client';
import { SettingsView, type SettingsViewState, type SettingsViewUpdate } from '../../settings';

export function SettingsFeature({
  client,
  onProviderDirtyChange,
  state,
  updateLoadedState
}: {
  client: RocClient;
  onProviderDirtyChange?: (dirty: boolean) => void;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  return <SettingsView client={client} onProviderDirtyChange={onProviderDirtyChange} state={state} updateLoadedState={updateLoadedState} />;
}
