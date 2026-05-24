import type { NvidiaToolChoice, ProviderConfig, ProviderModel, ProviderType } from '../../shared/types';
import {
  fixedLlamaCppBaseUrl,
  fixedLlamaCppProviderId,
  fixedLlamaCppProviderName,
  fixedNvidiaBaseUrl,
  fixedNvidiaProviderId,
  fixedNvidiaProviderName,
  normalizeFixedLlamaCppProvider,
  normalizeFixedNvidiaProvider
} from '../../shared/provider-defaults';

export type EditableProviderType = Extract<ProviderType, 'openai_compatible' | 'anthropic_compatible' | 'nvidia' | 'llama_cpp'>;
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
  includeReasoning: 'unset' | 'true' | 'false';
  parallelToolCalls: 'unset' | 'true' | 'false';
  streamUsage: 'unset' | 'true' | 'false';
  toolChoice: 'unset' | 'auto' | 'required' | 'none' | 'function';
  toolChoiceFunctionName: string;
  endpointOverride: string;
  guidedJson: string;
  guidedRegex: string;
  guidedChoice: string;
  guidedGrammar: string;
};

export type EnabledModelOption = {
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
  'llama_cpp'
];

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type NvidiaAdvancedDraftFields = Pick<
  ProviderDraft,
  | 'topP'
  | 'topK'
  | 'minP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'repetitionPenalty'
  | 'seed'
  | 'stop'
  | 'includeReasoning'
  | 'parallelToolCalls'
  | 'streamUsage'
  | 'toolChoice'
  | 'toolChoiceFunctionName'
  | 'endpointOverride'
  | 'guidedJson'
  | 'guidedRegex'
  | 'guidedChoice'
  | 'guidedGrammar'
>;

function defaultNvidiaAdvancedFields(): NvidiaAdvancedDraftFields {
  return {
    topP: '',
    topK: '',
    minP: '',
    frequencyPenalty: '',
    presencePenalty: '',
    repetitionPenalty: '',
    seed: '',
    stop: '',
    includeReasoning: 'unset',
    parallelToolCalls: 'unset',
    streamUsage: 'unset',
    toolChoice: 'unset',
    toolChoiceFunctionName: '',
    endpointOverride: '',
    guidedJson: '',
    guidedRegex: '',
    guidedChoice: '',
    guidedGrammar: ''
  };
}

function booleanDraftValue(value: boolean | undefined): 'unset' | 'true' | 'false' {
  if (value === undefined) {
    return 'unset';
  }
  return value ? 'true' : 'false';
}

function toolChoiceDraftValue(value: NvidiaToolChoice | undefined): ProviderDraft['toolChoice'] {
  if (value === 'auto' || value === 'required' || value === 'none') {
    return value;
  }
  if (value !== undefined && typeof value === 'object' && value.type === 'function') {
    return 'function';
  }
  return 'unset';
}

function toolChoiceFunctionNameDraftValue(value: NvidiaToolChoice | undefined): string {
  if (value !== undefined && typeof value === 'object' && value.type === 'function') {
    return value.function.name;
  }
  return '';
}

function jsonDraftValue(value: Record<string, unknown> | undefined): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function createNvidiaAdvancedFields(provider?: ProviderConfig): NvidiaAdvancedDraftFields {
  const options = provider?.options;
  return {
    ...defaultNvidiaAdvancedFields(),
    topP: typeof options?.topP === 'number' ? String(options.topP) : '',
    topK: typeof options?.topK === 'number' ? String(options.topK) : '',
    minP: typeof options?.minP === 'number' ? String(options.minP) : '',
    frequencyPenalty: typeof options?.frequencyPenalty === 'number' ? String(options.frequencyPenalty) : '',
    presencePenalty: typeof options?.presencePenalty === 'number' ? String(options.presencePenalty) : '',
    repetitionPenalty: typeof options?.repetitionPenalty === 'number' ? String(options.repetitionPenalty) : '',
    seed: typeof options?.seed === 'number' ? String(options.seed) : '',
    stop: Array.isArray(options?.stop) ? options.stop.join('\n') : '',
    includeReasoning: booleanDraftValue(options?.includeReasoning),
    parallelToolCalls: booleanDraftValue(options?.parallelToolCalls),
    streamUsage: booleanDraftValue(options?.streamUsage),
    toolChoice: toolChoiceDraftValue(options?.toolChoice),
    toolChoiceFunctionName: toolChoiceFunctionNameDraftValue(options?.toolChoice),
    endpointOverride: typeof options?.endpointOverride === 'string' ? options.endpointOverride : '',
    guidedJson: jsonDraftValue(options?.guidedJson),
    guidedRegex: typeof options?.guidedRegex === 'string' ? options.guidedRegex : '',
    guidedChoice: Array.isArray(options?.guidedChoice) ? options.guidedChoice.join('\n') : '',
    guidedGrammar: typeof options?.guidedGrammar === 'string' ? options.guidedGrammar : ''
  };
}

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
      modelsText: normalized.models.map((model) => `${model.id} | ${model.displayName}`).join('\n'),
      temperature:
        typeof normalized.options?.temperature === 'number' ? String(normalized.options.temperature) : '',
      maxTokens:
        typeof normalized.options?.maxTokens === 'number' ? String(normalized.options.maxTokens) : '',
      thinking: booleanDraftValue(normalized.options?.thinking),
      ...createNvidiaAdvancedFields(normalized)
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
      modelsText: normalized.models.map((model) => `${model.id} | ${model.displayName}`).join('\n'),
      temperature: '',
      maxTokens: '',
      thinking: 'unset',
      ...defaultNvidiaAdvancedFields()
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
      ...defaultNvidiaAdvancedFields()
    };
  }
  if (!editableProviderTypes.includes(provider.type as EditableProviderType)) {
    throw new Error(`Unsupported provider edit type: ${provider.type}`);
  }
  return {
    mode: 'edit',
    id: provider.id,
    name: provider.name,
    type: provider.type as EditableProviderType,
    endpoint: provider.endpoint,
    apiKey: '',
    enabled: provider.enabled,
    modelsText: provider.models.map((model) => `${model.id} | ${model.displayName}`).join('\n'),
    temperature: typeof provider.options?.temperature === 'number' ? String(provider.options.temperature) : '',
    maxTokens: typeof provider.options?.maxTokens === 'number' ? String(provider.options.maxTokens) : '',
    thinking: booleanDraftValue(provider.options?.thinking),
    ...defaultNvidiaAdvancedFields()
  };
}

export function parseProviderModelDraft(modelsText: string): ProviderModel[] {
  return modelsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separatorIndex = line.indexOf('|');
      const id = separatorIndex === -1 ? line.trim() : line.slice(0, separatorIndex).trim();
      const displayName = separatorIndex === -1 ? id : line.slice(separatorIndex + 1).trim();
      if (id.length === 0) {
        throw new Error('Provider model ID 不能为空。');
      }
      if (displayName.length === 0) {
        throw new Error('Provider model displayName 不能为空。');
      }
      return {
        id,
        displayName,
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      };
    });
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

function parseOptionalNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是数字。`);
  }
  return parsed;
}

function parseOptionalInteger(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} 必须是整数。`);
  }
  return parsed;
}

function parseStringList(value: string): string[] | undefined {
  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length === 0 ? undefined : items;
}

function parseOptionalBoolean(value: 'unset' | 'true' | 'false'): boolean | undefined {
  if (value === 'unset') {
    return undefined;
  }
  return value === 'true';
}

function parseNvidiaToolChoice(draft: ProviderDraft): NvidiaToolChoice | undefined {
  if (draft.toolChoice === 'unset') {
    return undefined;
  }
  if (draft.toolChoice === 'auto' || draft.toolChoice === 'required' || draft.toolChoice === 'none') {
    return draft.toolChoice;
  }
  const functionName = draft.toolChoiceFunctionName.trim();
  if (functionName.length === 0) {
    throw new Error('tool_choice function name 不能为空。');
  }
  return {
    type: 'function',
    function: {
      name: functionName
    }
  };
}

function parseOptionalJsonObject(value: string, label: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 必须是 JSON 对象。`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} 必须是合法 JSON 对象。`);
  }
}

function buildProviderOptionsFromDraft(draft: ProviderDraft): ProviderConfig['options'] {
  const temperature = parseOptionalNumber(draft.temperature, 'Temperature');
  const maxTokens = parseOptionalNumber(draft.maxTokens, 'Max tokens');
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error('Max tokens 必须是正整数。');
  }
  if (draft.type === 'nvidia') {
    const options: NonNullable<ProviderConfig['options']> = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (maxTokens !== undefined) options.maxTokens = maxTokens;
    const thinking = parseOptionalBoolean(draft.thinking);
    if (thinking !== undefined) options.thinking = thinking;
    const topP = parseOptionalNumber(draft.topP, 'top_p');
    if (topP !== undefined) options.topP = topP;
    const topK = parseOptionalInteger(draft.topK, 'top_k');
    if (topK !== undefined) options.topK = topK;
    const minP = parseOptionalNumber(draft.minP, 'min_p');
    if (minP !== undefined) options.minP = minP;
    const frequencyPenalty = parseOptionalNumber(draft.frequencyPenalty, 'frequency_penalty');
    if (frequencyPenalty !== undefined) options.frequencyPenalty = frequencyPenalty;
    const presencePenalty = parseOptionalNumber(draft.presencePenalty, 'presence_penalty');
    if (presencePenalty !== undefined) options.presencePenalty = presencePenalty;
    const repetitionPenalty = parseOptionalNumber(draft.repetitionPenalty, 'repetition_penalty');
    if (repetitionPenalty !== undefined) options.repetitionPenalty = repetitionPenalty;
    const seed = parseOptionalInteger(draft.seed, 'seed');
    if (seed !== undefined) options.seed = seed;
    const stop = parseStringList(draft.stop);
    if (stop !== undefined) options.stop = stop;
    const includeReasoning = parseOptionalBoolean(draft.includeReasoning);
    if (includeReasoning !== undefined) options.includeReasoning = includeReasoning;
    const parallelToolCalls = parseOptionalBoolean(draft.parallelToolCalls);
    if (parallelToolCalls !== undefined) options.parallelToolCalls = parallelToolCalls;
    const streamUsage = parseOptionalBoolean(draft.streamUsage);
    if (streamUsage !== undefined) options.streamUsage = streamUsage;
    const toolChoice = parseNvidiaToolChoice(draft);
    if (toolChoice !== undefined) options.toolChoice = toolChoice;
    const endpointOverride = draft.endpointOverride.trim();
    if (endpointOverride.length > 0) options.endpointOverride = endpointOverride;
    const guidedJson = parseOptionalJsonObject(draft.guidedJson, 'guided_json');
    if (guidedJson !== undefined) options.guidedJson = guidedJson;
    const guidedRegex = draft.guidedRegex.trim();
    if (guidedRegex.length > 0) options.guidedRegex = guidedRegex;
    const guidedChoice = parseStringList(draft.guidedChoice);
    if (guidedChoice !== undefined) options.guidedChoice = guidedChoice;
    const guidedGrammar = draft.guidedGrammar.trim();
    if (guidedGrammar.length > 0) options.guidedGrammar = guidedGrammar;
    return Object.keys(options).length === 0 ? undefined : options;
  }
  const thinking = parseOptionalBoolean(draft.thinking);
  if (temperature === undefined && maxTokens === undefined && thinking === undefined) {
    return undefined;
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(thinking === undefined ? {} : { thinking })
  };
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
