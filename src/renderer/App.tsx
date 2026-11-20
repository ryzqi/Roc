import { useMemo } from 'react';
import { SWRConfig } from 'swr';
import { APP_SWR_CONFIG } from './app/swr-config';
import { AppShell } from './app/AppShell';
import { errorMessage } from './app/loaded-state';
import { createRocClient, type RocClient } from './shared/roc-client';
import { StartupFailure } from './shell/StartupSurface';

/**
 * Boundary between the DOM entry point and the shell.
 *
 * Mirrors the legacy `src/renderer/App.tsx` so that P10's directory rename is
 * mechanical: same file name, same responsibilities.
 *
 * `createRocClient` throws when the preload bridge is missing. That is caught
 * here, before any hook runs, so a broken preload renders the designed
 * startup-failure surface instead of an unhandled render-time throw.
 */

type ClientResult = { ok: true; client: RocClient } | { ok: false; message: string };

export function App(): React.JSX.Element {
  const result = useMemo<ClientResult>(() => {
    try {
      return { ok: true, client: createRocClient() };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }, []);

  if (!result.ok) {
    return <StartupFailure title="Roc 无法连接本地后端" message={result.message} />;
  }

  return (
    <SWRConfig value={APP_SWR_CONFIG}>
      <AppShell client={result.client} />
    </SWRConfig>
  );
}
