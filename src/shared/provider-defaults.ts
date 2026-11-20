import type { ProviderConfig } from './types';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 500_000;

export function resolveNvidiaBaseUrl(provider: ProviderConfig): string {
  return provider.options?.endpointOverride?.trim() || provider.endpoint.trim();
}
