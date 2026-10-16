import type { RocPreloadApi } from '../shared/ipc';

/**
 * Global declarations for the renderer shell.
 *
 * Written during the migration so the new shell would not depend on the legacy
 * `src/renderer/global.d.ts`; that file is gone now and this one is the only `Window` augmentation
 * left. The `*.css` declaration that the legacy tree used to provide globally lives in
 * `vite-env.d.ts` next to this file.
 */

declare global {
  interface Window {
    roc: RocPreloadApi;
  }
}

export {};
