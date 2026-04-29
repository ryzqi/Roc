import type { RocPreloadApi } from '../shared/ipc';

declare global {
  interface Window {
    roc: RocPreloadApi;
  }
}

export {};
