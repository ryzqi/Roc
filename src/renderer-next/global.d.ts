import type { RocPreloadApi } from '../shared/ipc';

/**
 * Global declarations for the new renderer shell.
 *
 * This file exists so the shell does not depend on `src/renderer/global.d.ts`,
 * which P10 deletes. Without a local declaration, `pnpm typecheck` would fail on
 * cutover day for the new shell — the one moment the migration cannot afford a
 * surprise.
 */

declare global {
  interface Window {
    roc: RocPreloadApi;
  }
}

export {};
