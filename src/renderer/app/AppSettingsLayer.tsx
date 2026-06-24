import type { Dispatch, SetStateAction } from 'react';

import { SettingsFeature } from '../features/settings';
import { SettingsModal } from '../settings/settings-modal';
import type { RocClient } from '../shared/roc-client';
import type { AppBootstrap } from './use-app-bootstrap';

interface AppSettingsLayerProps {
  client: RocClient;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setState: AppBootstrap['setState'];
  state: NonNullable<AppBootstrap['state']>;
}

export function AppSettingsLayer({
  client,
  open,
  setOpen,
  setState,
  state
}: AppSettingsLayerProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <SettingsModal onClose={() => setOpen(false)}>
      <SettingsFeature
        client={client}
        state={state}
        updateLoadedState={(partial) =>
          setState((current) => (current === null ? current : { ...current, ...partial }))
        }
      />
    </SettingsModal>
  );
}
