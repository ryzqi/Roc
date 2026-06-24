import {
  createFixedProviderConfig,
  createFixedProviderConfigForId,
  fixedProviderTypes,
  isFixedProvider,
  normalizeFixedProvider,
  resolveFixedProviderType
} from '../../../shared/provider-defaults';
import { buildProviderModelKey, parseProviderModelKey } from '../../../shared/provider-model-key';
import type { DefaultModelState, ProviderConfig, ProvidersConfig } from '../../../shared/types';

function sanitizeDefaultModelIdForDisabledProviders(
  providers: readonly ProviderConfig[],
  defaultModelId: string | null
): string | null {
  if (defaultModelId === null) {
    return null;
  }
  const defaultModelKey = parseProviderModelKey(defaultModelId);
  if (defaultModelKey === null) {
    return defaultModelId;
  }
  if (
    providers.some(
      (provider) =>
        !provider.enabled &&
        provider.id === defaultModelKey.providerId &&
        provider.models.some((model) => model.id === defaultModelKey.modelId)
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
  const defaultModelKey = parseProviderModelKey(providersConfig.defaultModelId);
  if (defaultModelKey === null) {
    return {
      status: 'invalid',
      modelId: providersConfig.defaultModelId,
      providerId: null,
      reason: '默认模型不存在。'
    };
  }

  for (const provider of providersConfig.providers) {
    if (provider.id !== defaultModelKey.providerId) {
      continue;
    }
    const model = provider.models.find((candidate) => candidate.id === defaultModelKey.modelId);
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
    const defaultModelKey = config.defaultModelId === null ? null : parseProviderModelKey(config.defaultModelId);
    return {
      schemaVersion: 1,
      defaultModelId:
        config.defaultModelId !== null &&
        defaultModelKey !== null &&
        defaultModelKey.providerId === providerId &&
        provider.models.some((model) => buildProviderModelKey(providerId, model.id) === config.defaultModelId)
          ? null
          : config.defaultModelId,
      providers: config.providers.map((item) =>
        item.id === providerId ? createFixedProviderConfigForId(providerId) : item
      )
    };
  }

  const defaultModelKey = config.defaultModelId === null ? null : parseProviderModelKey(config.defaultModelId);
  const clearsDefaultModel =
    config.defaultModelId !== null &&
    defaultModelKey !== null &&
    defaultModelKey.providerId === providerId &&
    provider.models.some((model) => buildProviderModelKey(providerId, model.id) === config.defaultModelId);
  return {
    schemaVersion: 1,
    defaultModelId: clearsDefaultModel ? null : config.defaultModelId,
    providers: config.providers.filter((item) => item.id !== providerId)
  };
}
