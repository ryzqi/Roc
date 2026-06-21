import type {
  AnthropicThinkingOption,
  NvidiaToolChoice,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
  OpenAiServiceTier,
  OpenAiVerbosity,
  ProviderConfig
} from '../../shared/types';

import type { ProviderDraft } from './provider-draft-model';

type ProviderAdvancedDraftFields = Pick<
  ProviderDraft,
  | 'topP'
  | 'topK'
  | 'minP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'repetitionPenalty'
  | 'seed'
  | 'stop'
  | 'organization'
  | 'useResponsesApi'
  | 'openAiReasoningEffort'
  | 'openAiReasoningSummary'
  | 'includeReasoning'
  | 'parallelToolCalls'
  | 'streamUsage'
  | 'serviceTier'
  | 'timeoutMs'
  | 'verbosity'
  | 'zdrEnabled'
  | 'defaultHeaders'
  | 'modelKwargs'
  | 'anthropicThinkingMode'
  | 'anthropicThinkingBudgetTokens'
  | 'toolChoice'
  | 'toolChoiceFunctionName'
  | 'endpointOverride'
  | 'guidedJson'
  | 'guidedRegex'
  | 'guidedChoice'
  | 'guidedGrammar'
>;

export function defaultProviderAdvancedFields(): ProviderAdvancedDraftFields {
  return {
    topP: '',
    topK: '',
    minP: '',
    frequencyPenalty: '',
    presencePenalty: '',
    repetitionPenalty: '',
    seed: '',
    stop: '',
    organization: '',
    useResponsesApi: 'unset',
    openAiReasoningEffort: 'unset',
    openAiReasoningSummary: 'unset',
    includeReasoning: 'unset',
    parallelToolCalls: 'unset',
    streamUsage: 'unset',
    serviceTier: 'unset',
    timeoutMs: '',
    verbosity: 'unset',
    zdrEnabled: 'unset',
    defaultHeaders: '',
    modelKwargs: '',
    anthropicThinkingMode: 'unset',
    anthropicThinkingBudgetTokens: '',
    toolChoice: 'unset',
    toolChoiceFunctionName: '',
    endpointOverride: '',
    guidedJson: '',
    guidedRegex: '',
    guidedChoice: '',
    guidedGrammar: ''
  };
}

export function booleanDraftValue(value: boolean | undefined): 'unset' | 'true' | 'false' {
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

export function createNvidiaAdvancedFields(provider?: ProviderConfig): ProviderAdvancedDraftFields {
  const options = provider?.options;
  return {
    ...defaultProviderAdvancedFields(),
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

function anthropicThinkingModeDraftValue(
  value: AnthropicThinkingOption | undefined
): ProviderDraft['anthropicThinkingMode'] {
  if (value === undefined || value === null || typeof value !== 'object') {
    return 'unset';
  }
  if (value.mode === 'disabled') {
    return 'disabled';
  }
  if (value.mode === 'adaptive') {
    return 'adaptive';
  }
  if (value.mode === 'enabled') {
    return 'enabled';
  }
  return 'unset';
}

function anthropicThinkingBudgetDraftValue(
  value: AnthropicThinkingOption | undefined
): string {
  if (value === undefined || value === null || typeof value !== 'object' || value.mode !== 'enabled') {
    return '';
  }
  return typeof value.budgetTokens === 'number' ? String(value.budgetTokens) : '';
}

function openAiReasoningEffortDraftValue(
  value: OpenAiReasoningEffort | undefined
): ProviderDraft['openAiReasoningEffort'] {
  if (value === undefined) {
    return 'unset';
  }
  return value;
}

function openAiReasoningSummaryDraftValue(
  value: OpenAiReasoningSummary | undefined
): ProviderDraft['openAiReasoningSummary'] {
  if (value === undefined) {
    return 'unset';
  }
  return value;
}

function openAiServiceTierDraftValue(
  value: OpenAiServiceTier | undefined
): ProviderDraft['serviceTier'] {
  if (value === undefined) {
    return 'unset';
  }
  return value;
}

function openAiVerbosityDraftValue(
  value: OpenAiVerbosity | undefined
): ProviderDraft['verbosity'] {
  if (value === undefined) {
    return 'unset';
  }
  return value;
}

export function createOpenAiCompatibleAdvancedFields(provider?: ProviderConfig): ProviderAdvancedDraftFields {
  const options = provider?.options;
  return {
    ...defaultProviderAdvancedFields(),
    topP: typeof options?.topP === 'number' ? String(options.topP) : '',
    frequencyPenalty: typeof options?.frequencyPenalty === 'number' ? String(options.frequencyPenalty) : '',
    presencePenalty: typeof options?.presencePenalty === 'number' ? String(options.presencePenalty) : '',
    seed: typeof options?.seed === 'number' ? String(options.seed) : '',
    stop: Array.isArray(options?.stop) ? options.stop.join('\n') : '',
    organization: typeof options?.organization === 'string' ? options.organization : '',
    useResponsesApi: booleanDraftValue(options?.useResponsesApi),
    openAiReasoningEffort: openAiReasoningEffortDraftValue(options?.reasoning?.effort),
    openAiReasoningSummary: openAiReasoningSummaryDraftValue(options?.reasoning?.summary),
    parallelToolCalls: booleanDraftValue(options?.parallelToolCalls),
    streamUsage: booleanDraftValue(options?.streamUsage),
    serviceTier: openAiServiceTierDraftValue(options?.serviceTier),
    timeoutMs: typeof options?.timeoutMs === 'number' ? String(options.timeoutMs) : '',
    verbosity: openAiVerbosityDraftValue(options?.verbosity),
    zdrEnabled: booleanDraftValue(options?.zdrEnabled),
    defaultHeaders: options?.defaultHeaders === undefined ? '' : JSON.stringify(options.defaultHeaders, null, 2),
    modelKwargs: options?.modelKwargs === undefined ? '' : JSON.stringify(options.modelKwargs, null, 2)
  };
}

export function createAnthropicCompatibleAdvancedFields(provider?: ProviderConfig): ProviderAdvancedDraftFields {
  const options = provider?.options;
  return {
    ...defaultProviderAdvancedFields(),
    topP: typeof options?.topP === 'number' ? String(options.topP) : '',
    topK: typeof options?.topK === 'number' ? String(options.topK) : '',
    stop: Array.isArray(options?.stop) ? options.stop.join('\n') : '',
    streamUsage: booleanDraftValue(options?.streamUsage),
    timeoutMs: typeof options?.timeoutMs === 'number' ? String(options.timeoutMs) : '',
    defaultHeaders: options?.defaultHeaders === undefined ? '' : JSON.stringify(options.defaultHeaders, null, 2),
    anthropicThinkingMode: anthropicThinkingModeDraftValue(options?.anthropicThinking),
    anthropicThinkingBudgetTokens: anthropicThinkingBudgetDraftValue(options?.anthropicThinking)
  };
}

