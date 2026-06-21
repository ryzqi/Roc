import {
  anthropicThinkingMinBudgetTokens,
  type NvidiaToolChoice,
  type OpenAiReasoningOption,
  type OpenAiServiceTier,
  type OpenAiVerbosity,
  type ProviderConfig
} from '../../shared/types';

import type { ProviderDraft } from './provider-draft-model';

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

function parseOpenAiReasoning(
  draft: Pick<ProviderDraft, 'openAiReasoningEffort' | 'openAiReasoningSummary'>
): OpenAiReasoningOption | undefined {
  const effort = draft.openAiReasoningEffort === 'unset' ? undefined : draft.openAiReasoningEffort;
  const summary = draft.openAiReasoningSummary === 'unset' ? undefined : draft.openAiReasoningSummary;
  if (effort === undefined && summary === undefined) {
    return undefined;
  }
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(summary === undefined ? {} : { summary })
  };
}

function parseOpenAiServiceTier(value: ProviderDraft['serviceTier']): OpenAiServiceTier | undefined {
  if (value === 'unset') {
    return undefined;
  }
  return value;
}

function parseOpenAiVerbosity(value: ProviderDraft['verbosity']): OpenAiVerbosity | undefined {
  if (value === 'unset') {
    return undefined;
  }
  return value;
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

function parseOptionalPositiveInteger(value: string, label: string): number | undefined {
  const parsed = parseOptionalInteger(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed <= 0) {
    throw new Error(`${label} 必须是正整数。`);
  }
  return parsed;
}

function parseOptionalStringRecord(value: string, label: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} 必须是合法 JSON 对象。`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是合法 JSON 对象。`);
  }
  const entries = Object.entries(parsed);
  if (entries.some((entry) => typeof entry[1] !== 'string')) {
    throw new Error(`${label} 必须是 string -> string 的 JSON 对象。`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseAnthropicThinkingBudgetTokens(value: string): number {
  if (value.trim().length === 0) {
    throw new Error('Anthropic thinking budget tokens 不能为空。');
  }
  const budgetTokens = parseOptionalPositiveInteger(value, 'Anthropic thinking budget tokens');
  if (budgetTokens === undefined) {
    throw new Error('Anthropic thinking budget tokens 不能为空。');
  }
  if (budgetTokens < anthropicThinkingMinBudgetTokens) {
    throw new Error(`Anthropic thinking budget tokens 必须大于等于 ${anthropicThinkingMinBudgetTokens}。`);
  }
  return budgetTokens;
}

export function buildProviderOptionsFromDraft(draft: ProviderDraft): ProviderConfig['options'] {
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
  const options: NonNullable<ProviderConfig['options']> = {};
  if (temperature !== undefined) options.temperature = temperature;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;

  if (draft.type === 'openai_compatible') {
    const topP = parseOptionalNumber(draft.topP, 'top_p');
    if (topP !== undefined) options.topP = topP;
    const frequencyPenalty = parseOptionalNumber(draft.frequencyPenalty, 'frequency_penalty');
    if (frequencyPenalty !== undefined) options.frequencyPenalty = frequencyPenalty;
    const presencePenalty = parseOptionalNumber(draft.presencePenalty, 'presence_penalty');
    if (presencePenalty !== undefined) options.presencePenalty = presencePenalty;
    const seed = parseOptionalInteger(draft.seed, 'seed');
    if (seed !== undefined) options.seed = seed;
    const stop = parseStringList(draft.stop);
    if (stop !== undefined) options.stop = stop;
    const organization = draft.organization.trim();
    if (organization.length > 0) options.organization = organization;
    const useResponsesApi = parseOptionalBoolean(draft.useResponsesApi);
    if (useResponsesApi !== undefined) options.useResponsesApi = useResponsesApi;
    const reasoning = parseOpenAiReasoning(draft);
    if (reasoning !== undefined) options.reasoning = reasoning;
    const streamUsage = parseOptionalBoolean(draft.streamUsage);
    if (streamUsage !== undefined) options.streamUsage = streamUsage;
    const parallelToolCalls = parseOptionalBoolean(draft.parallelToolCalls);
    if (parallelToolCalls !== undefined) options.parallelToolCalls = parallelToolCalls;
    const serviceTier = parseOpenAiServiceTier(draft.serviceTier);
    if (serviceTier !== undefined) options.serviceTier = serviceTier;
    const timeoutMs = parseOptionalPositiveInteger(draft.timeoutMs, 'timeoutMs');
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
    const verbosity = parseOpenAiVerbosity(draft.verbosity);
    if (verbosity !== undefined) options.verbosity = verbosity;
    const zdrEnabled = parseOptionalBoolean(draft.zdrEnabled);
    if (zdrEnabled !== undefined) options.zdrEnabled = zdrEnabled;
    const defaultHeaders = parseOptionalStringRecord(draft.defaultHeaders, 'default_headers');
    if (defaultHeaders !== undefined) options.defaultHeaders = defaultHeaders;
    const modelKwargs = parseOptionalJsonObject(draft.modelKwargs, 'model_kwargs');
    if (modelKwargs !== undefined) options.modelKwargs = modelKwargs;
  }
  if (draft.type === 'anthropic_compatible') {
    const topP = parseOptionalNumber(draft.topP, 'top_p');
    if (topP !== undefined) options.topP = topP;
    const topK = parseOptionalInteger(draft.topK, 'top_k');
    if (topK !== undefined) options.topK = topK;
    const stop = parseStringList(draft.stop);
    if (stop !== undefined) options.stop = stop;
    const streamUsage = parseOptionalBoolean(draft.streamUsage);
    if (streamUsage !== undefined) options.streamUsage = streamUsage;
    const timeoutMs = parseOptionalPositiveInteger(draft.timeoutMs, 'timeoutMs');
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
    const defaultHeaders = parseOptionalStringRecord(draft.defaultHeaders, 'default_headers');
    if (defaultHeaders !== undefined) options.defaultHeaders = defaultHeaders;
    if (draft.anthropicThinkingMode === 'adaptive') {
      options.anthropicThinking = {
        mode: 'adaptive'
      };
    }
    if (draft.anthropicThinkingMode === 'disabled') {
      options.anthropicThinking = {
        mode: 'disabled'
      };
    }
    if (draft.anthropicThinkingMode === 'enabled') {
      const budgetTokens = parseAnthropicThinkingBudgetTokens(draft.anthropicThinkingBudgetTokens);
      if (maxTokens !== undefined && budgetTokens >= maxTokens) {
        throw new Error('Anthropic thinking budget tokens 必须小于 Max tokens。');
      }
      options.anthropicThinking = {
        mode: 'enabled',
        budgetTokens
      };
    }
  }

  return Object.keys(options).length === 0 ? undefined : options;
}

