import { lazy, Suspense } from 'react';
import { AnimatePresence } from 'motion/react';

import { SettingsModal } from '../settings/settings-modal';
import type { RocClient } from '../shared/roc-client';
import type { AppBootstrap } from './use-app-bootstrap';

const SettingsFeature = lazy(() => import('../features/settings').then((module) => ({ default: module.SettingsFeature })));

interface AppSettingsLayerProps {
  client: RocClient;
  onClose(): void;
  onExitComplete(): void;
  open: boolean;
  setState: AppBootstrap['setState'];
  state: NonNullable<AppBootstrap['state']>;
}

export function AppSettingsLayer({
  client,
  onClose,
  onExitComplete,
  open,
  setState,
  state
}: AppSettingsLayerProps): React.JSX.Element {
  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {open ? (
        <SettingsModal key="settings-modal" onClose={onClose}>
          <Suspense fallback={<div className="boot">Roc 正在加载设置</div>}>
            <SettingsFeature
              client={client}
              state={state}
              updateLoadedState={(partial) =>
                setState((current) => (current === null ? current : { ...current, ...partial }))
              }
            />
          </Suspense>
        </SettingsModal>
      ) : null}
    </AnimatePresence>
  );
}
