import type { RocClient } from '../../shared/roc-client';
import { SettingsView, type SettingsViewState, type SettingsViewUpdate } from '../../settings';

export function SettingsFeature({
  client,
  state,
  updateLoadedState
}: {
  client: RocClient;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  return <SettingsView client={client} state={state} updateLoadedState={updateLoadedState} />;
}
