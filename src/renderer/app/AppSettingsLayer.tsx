import { lazy, Suspense, useState } from 'react';
import { AnimatePresence } from 'motion/react';

import { SettingsModal } from '../settings/settings-modal';
import type { RocClient } from '../shared/roc-client';
import type { AppBootstrap } from './use-app-bootstrap';
import { ConfirmDialog } from '../components/ui';

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
  const [providerDirty, setProviderDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  function requestClose(): void {
    if (providerDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }

  return (
    <>
      <AnimatePresence onExitComplete={onExitComplete}>
      {open ? (
        <SettingsModal key="settings-modal" onClose={requestClose}>
          <Suspense fallback={<div className="boot">Roc 正在加载设置</div>}>
            <SettingsFeature
              client={client}
              onProviderDirtyChange={setProviderDirty}
              state={state}
              updateLoadedState={(partial) =>
                setState((current) => (current === null ? current : { ...current, ...partial }))
              }
            />
          </Suspense>
        </SettingsModal>
      ) : null}
      </AnimatePresence>
      <ConfirmDialog
        confirmLabel="放弃修改"
        description="当前 Provider 有未保存修改。关闭设置后这些修改会丢失。"
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        open={confirmClose}
        title="关闭设置并放弃修改？"
      />
    </>
  );
}
