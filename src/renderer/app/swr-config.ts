import type { SWRConfiguration } from 'swr';
import { isRetryableIpcResourceError } from './ipc-resource';

/** Per-renderer cache: no browser-style refresh and no retries for non-retryable IPC errors. */
export const APP_SWR_CONFIG: SWRConfiguration<unknown, Error> = {
  provider: () => new Map(),
  dedupingInterval: 2_000,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshInterval: 0,
  shouldRetryOnError: isRetryableIpcResourceError,
  errorRetryCount: 3
};
