import type { RocPreloadApi } from '../../shared/ipc';

export interface RocClient {
  readonly api: RocPreloadApi;
}

export function createRocClient(api: RocPreloadApi = window.roc): RocClient {
  return { api };
}
