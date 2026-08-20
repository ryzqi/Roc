import { z } from 'zod';

import {
  createFixedOpenRouterModelConfigs,
  fixedLlamaCppBaseUrl,
  fixedLlamaCppProviderId,
  fixedLlamaCppProviderName,
  fixedNvidiaBaseUrl,
  fixedNvidiaProviderId,
  fixedNvidiaProviderName,
  fixedOpenRouterBaseUrl,
  fixedOpenRouterProviderId,
  fixedOpenRouterProviderName,
  normalizeFixedLlamaCppProvider,
  normalizeFixedNvidiaProvider,
  normalizeFixedOpenRouterProvider
} from '../../shared/provider-defaults';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import { providerModelSchema } from '../../shared/schemas/ipc-memory-settings';
import type { ProviderConfig, ProviderModel, ProviderType } from '../../shared/types';

export type EditableProviderType = Extract<
  ProviderType,
  'openai_compatible' | 'anthropic_compatible' | 'nvidia' | 'openrouter' | 'llama_cpp'
>;
export type CreatableProviderType = Extract<EditableProviderType, 'openai_compatible' | 'anthropic_compatible'>;

export type ProviderDraft = {
  mode: 'create' | 'edit';
  id: string;
  name: string;
  type: EditableProviderType;
  endpoint: string;
  apiKey: string;
  enabled: boolean;
  models: ProviderModel[];
  timeoutMs: string;
  defaultHeaders: string;
  organization: string;
  endpointOverride: string;
};

export type EnabledModelOption = { modelKey: string; modelId: string; providerId: string; label: string };
export type ProviderTypeMeta = { defaultBaseUrl: string };

const editableProviderTypes: readonly EditableProviderType[] = [
  'openai_compatible', 'anthropic_compatible', 'nvidia', 'openrouter', 'llama_cpp'
];
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROVIDER_NAME_MEANINGFUL_PATTERN = /[\p{L}\p{N}]/u;
const stringRecordSchema = z.record(z.string(), z.string());

function connectionFields(provider?: ProviderConfig): Pick<
  ProviderDraft,
  'timeoutMs' | 'defaultHeaders' | 'organization' | 'endpointOverride'
> {
  return {
    timeoutMs: provider?.options?.timeoutMs === undefined ? '' : String(provider.options.timeoutMs),
    defaultHeaders: provider?.options?.defaultHeaders === undefined
      ? ''
      : JSON.stringify(provider.options.defaultHeaders, null, 2),
    organization: provider?.options?.organization ?? '',
    endpointOverride: provider?.options?.endpointOverride ?? ''
  };
}

export function createProviderDraft(type: EditableProviderType, provider?: ProviderConfig): ProviderDraft {
  if (!editableProviderTypes.includes(type)) throw new Error(`Unsupported provider draft type: ${type}`);
  if (type === 'nvidia') {
    const normalized = normalizeFixedNvidiaProvider(provider);
    return { mode: 'edit', id: fixedNvidiaProviderId, name: fixedNvidiaProviderName, type,
      endpoint: fixedNvidiaBaseUrl, apiKey: '', enabled: normalized.enabled, models: normalized.models,
      ...connectionFields(normalized) };
  }
  if (type === 'openrouter') {
    const normalized = normalizeFixedOpenRouterProvider(provider);
    return { mode: 'edit', id: fixedOpenRouterProviderId, name: fixedOpenRouterProviderName, type,
      endpoint: fixedOpenRouterBaseUrl, apiKey: '', enabled: normalized.enabled, models: normalized.models,
      ...connectionFields(normalized) };
  }
  if (type === 'llama_cpp') {
    const normalized = normalizeFixedLlamaCppProvider(provider);
    return { mode: 'edit', id: fixedLlamaCppProviderId, name: fixedLlamaCppProviderName, type,
      endpoint: normalized.endpoint, apiKey: '', enabled: normalized.enabled, models: normalized.models,
      ...connectionFields(normalized) };
  }
  if (provider === undefined) {
    return { mode: 'create', id: '', name: '', type, endpoint: '', apiKey: '', enabled: true, models: [emptyProviderModel()],
      ...connectionFields() };
  }
  return { mode: 'edit', id: provider.id, name: provider.name, type, endpoint: provider.endpoint,
    apiKey: '', enabled: provider.enabled, models: provider.models, ...connectionFields(provider) };
}

function emptyProviderModel(): ProviderModel {
  return {
    id: '',
    displayName: '',
    enabled: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false
  };
}

export function updateProviderModelCard(
  cards: readonly ProviderModel[], index: number, patch: Partial<ProviderModel>
): ProviderModel[] {
  return cards.map((model, cardIndex) => (cardIndex === index ? { ...model, ...patch } : model));
}

export function buildProviderIdFromName(name: string): string {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) throw new Error('Provider 名称不能为空。');
  const id = normalizedName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (id.length > 0) return id;
  if (!PROVIDER_NAME_MEANINGFUL_PATTERN.test(normalizedName)) {
    throw new Error('Provider 名称无法生成合法 ID，请使用字母或数字。');
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalizedName.length; index += 1) {
    hash ^= normalizedName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `provider-${hash.toString(16).padStart(8, '0')}`;
}

function resolveProviderDraftId(draft: ProviderDraft): string {
  const id = draft.mode === 'create' ? buildProviderIdFromName(draft.name) : draft.id.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error('Provider ID 只允许字母、数字、下划线和短横线。');
  return id;
}

export function assertProviderCreateIdAvailable(providers: readonly ProviderConfig[], providerId: string): void {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (providers.some((provider) => provider.id.trim().toLowerCase() === normalizedProviderId)) {
    throw new Error('Provider 名称生成的 ID 已存在，请调整名称后重试。');
  }
}

function buildConnectionOptions(draft: ProviderDraft): ProviderConfig['options'] {
  const options: NonNullable<ProviderConfig['options']> = {};
  if (draft.timeoutMs.trim().length > 0) {
    const timeoutMs = Number(draft.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须是正整数。');
    options.timeoutMs = timeoutMs;
  }
  if (draft.defaultHeaders.trim().length > 0) {
    try {
      options.defaultHeaders = stringRecordSchema.parse(JSON.parse(draft.defaultHeaders) as unknown);
    } catch {
      throw new Error('defaultHeaders 必须是 string -> string 的 JSON 对象。');
    }
  }
  if (draft.organization.trim().length > 0) options.organization = draft.organization.trim();
  if (draft.endpointOverride.trim().length > 0) options.endpointOverride = draft.endpointOverride.trim();
  return Object.keys(options).length === 0 ? undefined : options;
}

export function buildProviderConfigFromDraft(draft: ProviderDraft): ProviderConfig {
  const models = z.array(providerModelSchema).parse(draft.models);
  const options = buildConnectionOptions(draft);
  if (draft.type === 'nvidia') {
    if (models.length === 0) throw new Error('NVIDIA 至少需要一个模型。');
    return normalizeFixedNvidiaProvider({ id: fixedNvidiaProviderId, name: fixedNvidiaProviderName,
      type: draft.type, endpoint: fixedNvidiaBaseUrl, credentialRef: `secret:${fixedNvidiaProviderId}`,
      enabled: draft.enabled, models, ...(options === undefined ? {} : { options }) });
  }
  if (draft.type === 'openrouter') {
    return normalizeFixedOpenRouterProvider({ id: fixedOpenRouterProviderId, name: fixedOpenRouterProviderName,
      type: draft.type, endpoint: fixedOpenRouterBaseUrl, credentialRef: `secret:${fixedOpenRouterProviderId}`,
      enabled: draft.enabled, models: models.length === 0 ? createFixedOpenRouterModelConfigs() : models,
      ...(options === undefined ? {} : { options }) });
  }
  if (draft.type === 'llama_cpp') {
    if (models.length === 0) throw new Error('llama.cpp 至少需要一个模型。');
    return normalizeFixedLlamaCppProvider({ id: fixedLlamaCppProviderId, name: fixedLlamaCppProviderName,
      type: draft.type, endpoint: draft.endpoint.trim(),
      credentialRef: draft.apiKey.trim().length === 0 ? null : `secret:${fixedLlamaCppProviderId}`,
      enabled: draft.enabled, models, ...(options === undefined ? {} : { options }) });
  }
  const id = resolveProviderDraftId(draft);
  const name = draft.name.trim();
  const endpoint = draft.endpoint.trim();
  if (name.length === 0) throw new Error('Provider 名称不能为空。');
  if (endpoint.length === 0) throw new Error('Provider endpoint 不能为空。');
  if (models.length === 0) throw new Error('Provider 至少需要一个模型。');
  return { id, name, type: draft.type, endpoint, credentialRef: `secret:${id}`,
    enabled: draft.enabled, models, ...(options === undefined ? {} : { options }) };
}

export function buildEnabledModelOptions(providers: ProviderConfig[]): EnabledModelOption[] {
  return providers.filter((provider) => provider.enabled).flatMap((provider) =>
    provider.models.filter((model) => model.enabled).map((model) => ({
      modelKey: buildProviderModelKey(provider.id, model.id), modelId: model.id,
      providerId: provider.id, label: `${provider.name} / ${model.displayName}`
    }))
  );
}

export function providerTypeMeta(type: EditableProviderType): ProviderTypeMeta {
  if (type === 'nvidia') return { defaultBaseUrl: fixedNvidiaBaseUrl };
  if (type === 'openrouter') return { defaultBaseUrl: fixedOpenRouterBaseUrl };
  if (type === 'llama_cpp') return { defaultBaseUrl: fixedLlamaCppBaseUrl };
  if (type === 'anthropic_compatible') return { defaultBaseUrl: 'https://api.anthropic.com' };
  return { defaultBaseUrl: 'https://api.openai.com/v1' };
}
