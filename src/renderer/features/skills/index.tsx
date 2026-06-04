import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { SkillsHostView } from '../../views/skills/SkillsHostView';

export function SkillsFeature({
  client,
  state,
  updateLoadedState
}: {
  client: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return <SkillsHostView client={client} state={state} updateLoadedState={updateLoadedState} />;
}
