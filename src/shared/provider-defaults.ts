import type { ProviderConfig, ProviderType } from './types';

export const fixedNvidiaProviderId = 'nvidia';
export const fixedNvidiaProviderName = 'NVIDIA';
export const fixedNvidiaBaseUrl = 'https://integrate.api.nvidia.com/v1';
export const fixedLlamaCppProviderId = 'llama_cpp';
export const fixedLlamaCppProviderName = 'llama.cpp';
export const fixedLlamaCppBaseUrl = 'http://127.0.0.1:8081/v1';

export type FixedProviderType = Extract<ProviderType, 'nvidia' | 'llama_cpp'>;

const fixedProviderOrder: readonly FixedProviderType[] = ['nvidia', 'llama_cpp'];

function resolveFixedProviderTypeById(providerId: string): FixedProviderType | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (normalizedProviderId === fixedNvidiaProviderId) {
    return 'nvidia';
  }
  if (normalizedProviderId === fixedLlamaCppProviderId) {
    return 'llama_cpp';
  }
  return null;
}

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

export function resolveNvidiaBaseUrl(provider: ProviderConfig): string {
  const override = provider.options?.endpointOverride?.trim();
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return fixedNvidiaBaseUrl;
}

export function createFixedLlamaCppProviderConfig(): ProviderConfig {
  return {
    id: fixedLlamaCppProviderId,
    name: fixedLlamaCppProviderName,
    type: 'llama_cpp',
    endpoint: fixedLlamaCppBaseUrl,
    credentialRef: null,
    enabled: true,
    models: []
  };
}

export function normalizeFixedLlamaCppProvider(provider?: ProviderConfig): ProviderConfig {
  const base = createFixedLlamaCppProviderConfig();
  if (provider === undefined) {
    return base;
  }
  const endpoint = provider.endpoint.trim();
  return {
    ...base,
    endpoint: endpoint.length === 0 ? base.endpoint : endpoint,
    credentialRef: provider.credentialRef,
    enabled: provider.enabled,
    models: provider.models,
    options: provider.options
  };
}

export function fixedProviderTypes(): readonly FixedProviderType[] {
  return fixedProviderOrder;
}

export function isFixedProviderType(providerType: ProviderType): providerType is FixedProviderType {
  return providerType === 'nvidia' || providerType === 'llama_cpp';
}

export function isFixedProvider(providerId: string): boolean {
  return resolveFixedProviderTypeById(providerId) !== null;
}

export function resolveFixedProviderType(provider: Pick<ProviderConfig, 'id' | 'type'>): FixedProviderType | null {
  if (isFixedProviderType(provider.type)) {
    return provider.type;
  }
  return resolveFixedProviderTypeById(provider.id);
}

export function createFixedProviderConfig(type: FixedProviderType): ProviderConfig {
  if (type === 'nvidia') {
    return createFixedNvidiaProviderConfig();
  }
  return createFixedLlamaCppProviderConfig();
}

export function createFixedProviderConfigForId(providerId: string): ProviderConfig {
  const fixedProviderType = resolveFixedProviderTypeById(providerId);
  if (fixedProviderType === null) {
    throw new Error(`Unsupported fixed provider id: ${providerId}`);
  }
  return createFixedProviderConfig(fixedProviderType);
}

export function normalizeFixedProvider(provider: ProviderConfig): ProviderConfig {
  const fixedProviderType = resolveFixedProviderType(provider);
  if (fixedProviderType === 'nvidia') {
    return normalizeFixedNvidiaProvider(provider);
  }
  if (fixedProviderType === 'llama_cpp') {
    return normalizeFixedLlamaCppProvider(provider);
  }
  throw new Error(`Provider ${provider.id} is not a fixed provider.`);
}
