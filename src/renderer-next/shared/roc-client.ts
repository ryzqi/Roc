import type { RocPreloadApi } from '../../shared/ipc';

/**
 * The single handle the renderer holds onto `window.roc`.
 *
 * Deliberately the same shape as the legacy shell's client so that migrated
 * call sites keep working unchanged (P0/T0.3).
 */
export interface RocClient {
  readonly api: RocPreloadApi;
}

/** True when the preload script actually injected the bridge. */
export function preloadApiAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.roc !== 'undefined' && window.roc !== null;
}

export class PreloadUnavailableError extends Error {
  constructor() {
    super('预加载脚本未注入：window.roc 不存在，渲染进程无法访问本地能力。');
    this.name = 'PreloadUnavailableError';
  }
}

/**
 * Throws `PreloadUnavailableError` when the bridge is missing, so the shell can
 * surface the designed startup-failure surface instead of hanging on the
 * loading screen with an unhandled rejection.
 */
export function createRocClient(api?: RocPreloadApi): RocClient {
  const resolved = api ?? (typeof window === 'undefined' ? undefined : window.roc);
  if (resolved === undefined || resolved === null) {
    throw new PreloadUnavailableError();
  }
  return { api: resolved };
}
