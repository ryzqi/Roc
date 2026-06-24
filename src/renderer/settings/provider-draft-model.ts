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
import {
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
  type OpenAiServiceTier,
  type OpenAiVerbosity,
  type ProviderConfig,
  type ProviderModel,
  type ProviderType
} from '../../shared/types';
import {
  booleanDraftValue,
  createAnthropicCompatibleAdvancedFields,
  createNvidiaAdvancedFields,
  createOpenAiCompatibleAdvancedFields,
  defaultProviderAdvancedFields
} from './provider-draft-advanced-fields';
import { buildProviderOptionsFromDraft } from './provider-draft-options';

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
  modelsText: string;
  temperature: string;
  maxTokens: string;
  thinking: 'unset' | 'true' | 'false';
  topP: string;
  topK: string;
  minP: string;
  frequencyPenalty: string;
  presencePenalty: string;
  repetitionPenalty: string;
  seed: string;
  stop: string;
  organization: string;
  useResponsesApi: 'unset' | 'true' | 'false';
  openAiReasoningEffort: 'unset' | OpenAiReasoningEffort;
  openAiReasoningSummary: 'unset' | OpenAiReasoningSummary;
  includeReasoning: 'unset' | 'true' | 'false';
  parallelToolCalls: 'unset' | 'true' | 'false';
  streamUsage: 'unset' | 'true' | 'false';
  serviceTier: 'unset' | OpenAiServiceTier;
  timeoutMs: string;
  verbosity: 'unset' | OpenAiVerbosity;
  zdrEnabled: 'unset' | 'true' | 'false';
  defaultHeaders: string;
  modelKwargs: string;
  anthropicThinkingMode: 'unset' | 'disabled' | 'adaptive' | 'enabled';
  anthropicThinkingBudgetTokens: string;
  toolChoice: 'unset' | 'auto' | 'required' | 'none' | 'function';
  toolChoiceFunctionName: string;
  endpointOverride: string;
  guidedJson: string;
  guidedRegex: string;
  guidedChoice: string;
  guidedGrammar: string;
};

export type EnabledModelOption = {
  modelKey: string;
  modelId: string;
  providerId: string;
  label: string;
};

export type ProviderTypeMeta = {
  defaultBaseUrl: string;
};

const editableProviderTypes: readonly EditableProviderType[] = [
  'openai_compatible',
  'anthropic_compatible',
  'nvidia',
  'openrouter',
  'llama_cpp'
];

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function createProviderDraft(type: EditableProviderType, provider?: ProviderConfig): ProviderDraft {
  if (!editableProviderTypes.includes(type)) {
    throw new Error(`Unsupported provider draft type: ${type}`);
  }
  if (type === 'nvidia') {
    const normalized = normalizeFixedNvidiaProvider(provider);
    return {
      mode: 'edit',
      id: fixedNvidiaProviderId,
      name: fixedNvidiaProviderName,
      type: 'nvidia',
      endpoint: fixedNvidiaBaseUrl,
      apiKey: '',
      enabled: normalized.enabled,
      modelsText: normalized.models.map(formatProviderModelDraft).join('\n'),
      temperature:
        typeof normalized.options?.temperature === 'number' ? String(normalized.options.temperature) : '',
      maxTokens:
        typeof normalized.options?.maxTokens === 'number' ? String(normalized.options.maxTokens) : '',
      thinking: booleanDraftValue(normalized.options?.thinking),
      ...createNvidiaAdvancedFields(normalized)
    };
  }
  if (type === 'openrouter') {
    const normalized = normalizeFixedOpenRouterProvider(provider);
    return {
      mode: 'edit',
      id: fixedOpenRouterProviderId,
      name: fixedOpenRouterProviderName,
      type: 'openrouter',
      endpoint: fixedOpenRouterBaseUrl,
      apiKey: '',
      enabled: normalized.enabled,
      modelsText: normalized.models.map(formatProviderModelDraft).join('\n'),
      temperature: '',
      maxTokens: '',
      thinking: 'unset',
      ...defaultProviderAdvancedFields()
    };
  }
  if (type === 'llama_cpp') {
    const normalized = normalizeFixedLlamaCppProvider(provider);
    return {
      mode: 'edit',
      id: fixedLlamaCppProviderId,
      name: fixedLlamaCppProviderName,
      type: 'llama_cpp',
      endpoint: normalized.endpoint,
      apiKey: '',
      enabled: normalized.enabled,
      modelsText: normalized.models.map(formatProviderModelDraft).join('\n'),
      temperature: '',
      maxTokens: '',
      thinking: 'unset',
      ...defaultProviderAdvancedFields()
    };
  }
  if (provider === undefined) {
    return {
      mode: 'create',
      id: '',
      name: '',
      type,
      endpoint: '',
      apiKey: '',
      enabled: true,
      modelsText: '',
      temperature: '',
      maxTokens: '',
      thinking: 'unset',
      ...defaultProviderAdvancedFields()
    };
  }
  if (!editableProviderTypes.includes(provider.type as EditableProviderType)) {
    throw new Error(`Unsupported provider edit type: ${provider.type}`);
  }
  const advancedFields =
    provider.type === 'openai_compatible'
      ? createOpenAiCompatibleAdvancedFields(provider)
      : provider.type === 'anthropic_compatible'
        ? createAnthropicCompatibleAdvancedFields(provider)
        : defaultProviderAdvancedFields();
  return {
    mode: 'edit',
    id: provider.id,
    name: provider.name,
    type: provider.type as EditableProviderType,
    endpoint: provider.endpoint,
    apiKey: '',
    enabled: provider.enabled,
    modelsText: provider.models.map(formatProviderModelDraft).join('\n'),
    temperature: typeof provider.options?.temperature === 'number' ? String(provider.options.temperature) : '',
    maxTokens: typeof provider.options?.maxTokens === 'number' ? String(provider.options.maxTokens) : '',
    thinking: booleanDraftValue(provider.options?.thinking),
    ...advancedFields
  };
}

export function parseProviderModelDraft(modelsText: string): ProviderModel[] {
  return modelsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length > 3) {
        throw new Error('Provider model 格式应为 modelId | displayName | image。');
      }
      const firstPart = parts[0];
      if (firstPart === undefined) {
        throw new Error('Provider model ID 不能为空。');
      }
      const secondPart = parts[1];
      const thirdPart = parts[2];
      const id = firstPart;
      const displayName = secondPart === undefined ? id : secondPart;
      if (id.length === 0) {
        throw new Error('Provider model ID 不能为空。');
      }
      if (displayName.length === 0) {
        throw new Error('Provider model displayName 不能为空。');
      }
      const supportsImages = parseProviderModelImageCapability(thirdPart);
      return {
        id,
        displayName,
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages
      };
    });
}

function formatProviderModelDraft(model: ProviderModel): string {
  const baseLine = `${model.id} | ${model.displayName}`;
  if (model.supportsImages) {
    return `${baseLine} | image`;
  }
  return baseLine;
}

function parseProviderModelImageCapability(value: string | undefined): boolean {
  if (value === undefined || value.length === 0 || value === 'text') {
    return false;
  }
  if (value === 'image') {
    return true;
  }
  throw new Error('Provider model 图片能力仅支持 image 或 text。');
}

export function buildProviderIdFromName(name: string): string {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error('Provider 名称不能为空。');
  }
  const id = normalizedName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id.length === 0 || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider 名称无法生成合法 ID，请使用字母或数字。');
  }
  return id;
}

function resolveProviderDraftId(draft: ProviderDraft): string {
  if (draft.mode === 'create') {
    return buildProviderIdFromName(draft.name);
  }
  const id = draft.id.trim();
  if (id.length === 0) {
    throw new Error('Provider ID 不能为空。');
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider ID 只允许字母、数字、下划线和短横线。');
  }
  return id;
}

export function assertProviderCreateIdAvailable(
  providers: readonly ProviderConfig[],
  providerId: string
): void {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (providers.some((provider) => provider.id.trim().toLowerCase() === normalizedProviderId)) {
    throw new Error('Provider 名称生成的 ID 已存在，请调整名称后重试。');
  }
}

export function buildProviderConfigFromDraft(draft: ProviderDraft): ProviderConfig {
  const options = buildProviderOptionsFromDraft(draft);
  if (draft.type === 'nvidia') {
    const models = parseProviderModelDraft(draft.modelsText);
    if (models.length === 0) {
      throw new Error('NVIDIA 至少需要一个模型。');
    }
    const provider = normalizeFixedNvidiaProvider({
      id: fixedNvidiaProviderId,
      name: fixedNvidiaProviderName,
      type: 'nvidia',
      endpoint: fixedNvidiaBaseUrl,
      credentialRef: `secret:${fixedNvidiaProviderId}`,
      enabled: draft.enabled,
      models,
      options
    });
    return options === undefined ? { ...provider, options: undefined } : provider;
  }
  if (draft.type === 'openrouter') {
    const modelsText = draft.modelsText.trim();
    const provider = normalizeFixedOpenRouterProvider({
      id: fixedOpenRouterProviderId,
      name: fixedOpenRouterProviderName,
      type: 'openrouter',
      endpoint: fixedOpenRouterBaseUrl,
      credentialRef: `secret:${fixedOpenRouterProviderId}`,
      enabled: draft.enabled,
      models: modelsText.length === 0 ? createFixedOpenRouterModelConfigs() : parseProviderModelDraft(modelsText),
      options: undefined
    });
    return { ...provider, options: undefined };
  }
  if (draft.type === 'llama_cpp') {
    const models = parseProviderModelDraft(draft.modelsText);
    if (models.length === 0) {
      throw new Error('llama.cpp 至少需要一个模型。');
    }
    return normalizeFixedLlamaCppProvider({
      id: fixedLlamaCppProviderId,
      name: fixedLlamaCppProviderName,
      type: 'llama_cpp',
      endpoint: draft.endpoint.trim(),
      credentialRef: draft.apiKey.trim().length === 0 ? null : `secret:${fixedLlamaCppProviderId}`,
      enabled: draft.enabled,
      models,
      options: undefined
    });
  }

  const id = resolveProviderDraftId(draft);
  const name = draft.name.trim();
  const endpoint = draft.endpoint.trim();
  if (name.length === 0) {
    throw new Error('Provider 名称不能为空。');
  }
  if (endpoint.length === 0) {
    throw new Error('Provider endpoint 不能为空。');
  }
  const models = parseProviderModelDraft(draft.modelsText);
  if (models.length === 0) {
    throw new Error('Provider 至少需要一个模型。');
  }
  return {
    id,
    name,
    type: draft.type,
    endpoint,
    credentialRef: `secret:${id}`,
    enabled: draft.enabled,
    models,
    options
  };
}

export function buildEnabledModelOptions(providers: ProviderConfig[]): EnabledModelOption[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          modelKey: buildProviderModelKey(provider.id, model.id),
          modelId: model.id,
          providerId: provider.id,
          label: `${provider.name} / ${model.displayName}`
        }))
    );
}

export function providerTypeMeta(type: EditableProviderType): ProviderTypeMeta {
  if (type === 'nvidia') {
    return {
      defaultBaseUrl: fixedNvidiaBaseUrl
    };
  }
  if (type === 'openrouter') {
    return {
      defaultBaseUrl: fixedOpenRouterBaseUrl
    };
  }
  if (type === 'llama_cpp') {
    return {
      defaultBaseUrl: fixedLlamaCppBaseUrl
    };
  }
  if (type === 'anthropic_compatible') {
    return {
      defaultBaseUrl: 'https://api.anthropic.com'
    };
  }
  return {
    defaultBaseUrl: 'https://api.openai.com/v1'
  };
}
