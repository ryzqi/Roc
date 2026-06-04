import type { RocClient } from '../../shared/roc-client';
import { SettingsView, type SettingsViewState, type SettingsViewUpdate } from '../../settings';

export function SettingsFeature({
  client,
  onNavigate,
  state,
  updateLoadedState
}: {
  client: RocClient;
  onNavigate: (target: 'mcp' | 'skills') => void;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  return <SettingsView client={client} onNavigate={onNavigate} state={state} updateLoadedState={updateLoadedState} />;
}
