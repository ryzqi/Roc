import type { ProviderConfig } from './types';

export const fixedNvidiaProviderId = 'nvidia';
export const fixedNvidiaProviderName = 'NVIDIA';
export const fixedNvidiaBaseUrl = 'https://integrate.api.nvidia.com/v1';

export function createFixedNvidiaProviderConfig(): ProviderConfig {
  return {
    id: fixedNvidiaProviderId,
    name: fixedNvidiaProviderName,
    type: 'nvidia',
    endpoint: fixedNvidiaBaseUrl,
    credentialRef: `secret:${fixedNvidiaProviderId}`,
    enabled: true,
    models: []
  };
}

export function normalizeFixedNvidiaProvider(provider?: ProviderConfig): ProviderConfig {
  const base = createFixedNvidiaProviderConfig();
  if (provider === undefined) {
    return base;
  }
  return {
    ...base,
    enabled: provider.enabled,
    models: provider.models,
    options: provider.options
  };
}

export function isFixedProvider(providerId: string): boolean {
  return providerId.trim().toLowerCase() === fixedNvidiaProviderId;
}
