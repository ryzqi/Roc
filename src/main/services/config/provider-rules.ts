import { buildProviderModelKey, parseProviderModelKey } from '../../../shared/provider-model-key';
import type { DefaultModelState, ProviderConfig, ProvidersConfig } from '../../../shared/types';

function sanitizeDefaultModelId(
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
  const provider = providers.find((candidate) => candidate.id === defaultModelKey.providerId);
  if (provider === undefined || !provider.enabled) {
    return null;
  }
  const model = provider.models.find((candidate) => candidate.id === defaultModelKey.modelId);
  return model === undefined || !model.enabled ? null : defaultModelId;
}

export function normalizeProvidersConfig(config: ProvidersConfig): ProvidersConfig {
  return {
    schemaVersion: 2,
    defaultModelId: sanitizeDefaultModelId(config.providers, config.defaultModelId),
    providers: config.providers
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

  const defaultModelKey = config.defaultModelId === null ? null : parseProviderModelKey(config.defaultModelId);
  const clearsDefaultModel =
    config.defaultModelId !== null &&
    defaultModelKey !== null &&
    defaultModelKey.providerId === providerId &&
    provider.models.some((model) => buildProviderModelKey(providerId, model.id) === config.defaultModelId);
  return {
    schemaVersion: 2,
    defaultModelId: clearsDefaultModel ? null : config.defaultModelId,
    providers: config.providers.filter((item) => item.id !== providerId)
  };
}
