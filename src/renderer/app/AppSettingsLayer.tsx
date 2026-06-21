import type { Dispatch, SetStateAction } from 'react';

import { SettingsFeature } from '../features/settings';
import { SettingsModal } from '../settings/settings-modal';
import type { RocClient } from '../shared/roc-client';
import type { ViewId } from './types';
import type { AppBootstrap } from './use-app-bootstrap';

interface AppSettingsLayerProps {
  client: RocClient;
  open: boolean;
  setActiveView: Dispatch<SetStateAction<ViewId>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setState: AppBootstrap['setState'];
  setWorkbenchVisible: Dispatch<SetStateAction<boolean>>;
  state: NonNullable<AppBootstrap['state']>;
}

export function AppSettingsLayer({
  client,
  open,
  setActiveView,
  setOpen,
  setState,
  setWorkbenchVisible,
  state
}: AppSettingsLayerProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <SettingsModal onClose={() => setOpen(false)}>
      <SettingsFeature
        client={client}
        onNavigate={(target) => {
          setOpen(false);
          setActiveView(target);
          setWorkbenchVisible(false);
        }}
        state={state}
        updateLoadedState={(partial) =>
          setState((current) => (current === null ? current : { ...current, ...partial }))
        }
      />
    </SettingsModal>
  );
}
