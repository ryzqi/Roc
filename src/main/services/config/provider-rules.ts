import {
  createFixedProviderConfig,
  createFixedProviderConfigForId,
  fixedProviderTypes,
  isFixedProvider,
  normalizeFixedProvider,
  resolveFixedProviderType
} from '../../../shared/provider-defaults';
import type { DefaultModelState, ProviderConfig, ProvidersConfig } from '../../../shared/types';

export function sanitizeDefaultModelIdForDisabledProviders(
  providers: readonly ProviderConfig[],
  defaultModelId: string | null
): string | null {
  if (defaultModelId === null) {
    return null;
  }
  if (
    providers.some(
      (provider) => !provider.enabled && provider.models.some((model) => model.id === defaultModelId)
    )
  ) {
    return null;
  }
  return defaultModelId;
}

export function normalizeProvidersConfig(config: ProvidersConfig): ProvidersConfig {
  const fixedProviders = new Map<string, ProviderConfig>();
  const normalizedProviders: ProviderConfig[] = [];

  for (const provider of config.providers) {
    const fixedProviderType = resolveFixedProviderType(provider);
    if (fixedProviderType !== null) {
      if (!fixedProviders.has(fixedProviderType)) {
        fixedProviders.set(fixedProviderType, normalizeFixedProvider(provider));
      }
      continue;
    }
    normalizedProviders.push(provider);
  }

  const orderedProviders = [
    ...fixedProviderTypes().map((type) => fixedProviders.get(type) ?? createFixedProviderConfig(type)),
    ...normalizedProviders
  ];

  return {
    schemaVersion: 1,
    defaultModelId: sanitizeDefaultModelIdForDisabledProviders(orderedProviders, config.defaultModelId),
    providers: orderedProviders
  };
}

export function defaultModelStateForProviders(providersConfig: ProvidersConfig): DefaultModelState {
  if (providersConfig.defaultModelId === null) {
    return {
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    };
  }

  for (const provider of providersConfig.providers) {
    const model = provider.models.find((candidate) => candidate.id === providersConfig.defaultModelId);
    if (model === undefined) {
      continue;
    }
    if (!provider.enabled) {
      return {
        status: 'invalid',
        modelId: model.id,
        providerId: provider.id,
        reason: '默认模型所属 provider 未启用。'
      };
    }
    if (!model.enabled) {
      return {
        status: 'invalid',
        modelId: model.id,
        providerId: provider.id,
        reason: '默认模型未启用。'
      };
    }
    return {
      status: 'ready',
      modelId: model.id,
      providerId: provider.id,
      reason: '默认模型可用。'
    };
  }

  return {
    status: 'invalid',
    modelId: providersConfig.defaultModelId,
    providerId: null,
    reason: '默认模型不存在。'
  };
}

export function deleteProviderFromConfig(config: ProvidersConfig, providerId: string): ProvidersConfig {
  const provider = config.providers.find((item) => item.id === providerId);
  if (provider === undefined) {
    return config;
  }

  if (isFixedProvider(providerId)) {
    return {
      schemaVersion: 1,
      defaultModelId:
        config.defaultModelId !== null && provider.models.some((model) => model.id === config.defaultModelId)
          ? null
          : config.defaultModelId,
      providers: config.providers.map((item) =>
        item.id === providerId ? createFixedProviderConfigForId(providerId) : item
      )
    };
  }

  const deletedModelIds = new Set(provider.models.map((model) => model.id));
  return {
    schemaVersion: 1,
    defaultModelId:
      config.defaultModelId !== null && deletedModelIds.has(config.defaultModelId) ? null : config.defaultModelId,
    providers: config.providers.filter((item) => item.id !== providerId)
  };
}
