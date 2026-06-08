import type {
  AnthropicThinkingOption,
  NvidiaToolChoice,
  OpenAiReasoningOption,
  OpenAiServiceTier,
  OpenAiVerbosity,
  ProviderConfig,
  ProviderModel,
  ProviderOptions,
  ProviderSamplingProfileOverrides
} from './settings';

export type {
  AnthropicThinkingOption,
  NvidiaToolChoice,
  OpenAiReasoningOption,
  OpenAiServiceTier,
  OpenAiVerbosity,
  ProviderSamplingProfileOverrides
} from './settings';

export type BaseProviderConfig = {
  id: string;
  name: string;
  enabled: boolean;
  models: ProviderModel[];
  endpoint: string;
  credentialRef: string | null;
};

export type CommonProviderParams = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
};

export type OpenAICompatibleParams = CommonProviderParams & {
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  organization?: string;
  useResponsesApi?: boolean;
  reasoning?: OpenAiReasoningOption;
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
  serviceTier?: OpenAiServiceTier;
  verbosity?: OpenAiVerbosity;
  zdrEnabled?: boolean;
};

export type AnthropicCompatibleParams = CommonProviderParams & {
  topK?: number;
  stopSequences?: string[];
  thinking?: AnthropicThinkingOption;
  betas?: string[];
  invocationKwargs?: Record<string, unknown>;
};

export type NvidiaParams = CommonProviderParams & {
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  stop?: string[];
  thinking?: boolean;
  includeReasoning?: boolean;
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
  toolChoice?: NvidiaToolChoice;
  guidedJson?: Record<string, unknown>;
  guidedRegex?: string;
  guidedChoice?: string[];
  guidedGrammar?: string;
  endpointOverride?: string;
};

export type LlamaCppParams = CommonProviderParams & {
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  samplingProfileOverrides?: ProviderSamplingProfileOverrides;
  contextBudgetTokens?: number;
};

export type OpenRouterParams = Record<string, never>;

export type ProviderConfigTyped =
  | {
      type: 'openai_compatible';
      config: BaseProviderConfig;
      params: OpenAICompatibleParams;
    }
  | {
      type: 'anthropic_compatible';
      config: BaseProviderConfig;
      params: AnthropicCompatibleParams;
    }
  | {
      type: 'nvidia';
      config: BaseProviderConfig;
      params: NvidiaParams;
    }
  | {
      type: 'openrouter';
      config: BaseProviderConfig;
      params: OpenRouterParams;
    }
  | {
      type: 'llama_cpp';
      config: BaseProviderConfig;
      params: LlamaCppParams;
    };

type LegacyProviderConfig = Pick<
  ProviderConfig,
  'id' | 'name' | 'type' | 'enabled' | 'models' | 'endpoint' | 'credentialRef' | 'options'
>;

export function isOpenAIProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'openai_compatible' }> {
  return config.type === 'openai_compatible';
}

export function isAnthropicProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'anthropic_compatible' }> {
  return config.type === 'anthropic_compatible';
}

export function isNvidiaProvider(config: ProviderConfigTyped): config is Extract<ProviderConfigTyped, { type: 'nvidia' }> {
  return config.type === 'nvidia';
}

export function isLlamaCppProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'llama_cpp' }> {
  return config.type === 'llama_cpp';
}

export function isOpenRouterProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'openrouter' }> {
  return config.type === 'openrouter';
}

export function toTypedProviderConfig(legacy: LegacyProviderConfig): ProviderConfigTyped {
  const baseConfig: BaseProviderConfig = {
    id: legacy.id,
    name: legacy.name,
    enabled: legacy.enabled,
    models: legacy.models,
    endpoint: legacy.endpoint,
    credentialRef: legacy.credentialRef
  };
  const opts = legacy.options ?? {};

  switch (legacy.type) {
    case 'openai_compatible':
      return {
        type: 'openai_compatible',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          frequencyPenalty: opts.frequencyPenalty,
          presencePenalty: opts.presencePenalty,
          seed: opts.seed,
          stop: opts.stop,
          organization: opts.organization,
          useResponsesApi: opts.useResponsesApi,
          reasoning: opts.reasoning,
          parallelToolCalls: opts.parallelToolCalls,
          streamUsage: opts.streamUsage,
          serviceTier: opts.serviceTier,
          verbosity: opts.verbosity,
          zdrEnabled: opts.zdrEnabled
        }
      };

    case 'anthropic_compatible':
      return {
        type: 'anthropic_compatible',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          topK: opts.topK,
          stopSequences: opts.stop,
          thinking: opts.anthropicThinking,
          betas: opts.anthropicBetas,
          invocationKwargs: opts.invocationKwargs
        }
      };

    case 'nvidia':
      return {
        type: 'nvidia',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          topK: opts.topK,
          minP: opts.minP,
          frequencyPenalty: opts.frequencyPenalty,
          presencePenalty: opts.presencePenalty,
          repetitionPenalty: opts.repetitionPenalty,
          seed: opts.seed,
          stop: opts.stop,
          thinking: opts.thinking,
          includeReasoning: opts.includeReasoning,
          parallelToolCalls: opts.parallelToolCalls,
          streamUsage: opts.streamUsage,
          toolChoice: opts.toolChoice,
          guidedJson: opts.guidedJson,
          guidedRegex: opts.guidedRegex,
          guidedChoice: opts.guidedChoice,
          guidedGrammar: opts.guidedGrammar,
          endpointOverride: opts.endpointOverride
        }
      };

    case 'openrouter':
      return {
        type: 'openrouter',
        config: baseConfig,
        params: {}
      };

    case 'llama_cpp':
      return {
        type: 'llama_cpp',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          topK: opts.topK,
          minP: opts.minP,
          presencePenalty: opts.presencePenalty,
          repetitionPenalty: opts.repetitionPenalty,
          samplingProfileOverrides: opts.samplingProfileOverrides,
          contextBudgetTokens: opts.contextBudgetTokens
        }
      };

    case 'ollama':
    case 'custom':
      throw new Error(`Provider type ${legacy.type} does not support typed provider config.`);

    default:
      return assertNeverProviderType(legacy.type);
  }
}

export function fromTypedProviderConfig(typed: ProviderConfigTyped): ProviderConfig {
  return {
    ...typed.config,
    type: typed.type,
    options: providerOptionsFromTypedParams(typed)
  };
}

function providerOptionsFromTypedParams(typed: ProviderConfigTyped): ProviderOptions {
  switch (typed.type) {
    case 'openai_compatible':
    case 'nvidia':
      return { ...typed.params };

    case 'anthropic_compatible':
      return {
        temperature: typed.params.temperature,
        maxTokens: typed.params.maxTokens,
        topP: typed.params.topP,
        topK: typed.params.topK,
        timeoutMs: typed.params.timeoutMs,
        defaultHeaders: typed.params.defaultHeaders,
        stop: typed.params.stopSequences,
        anthropicThinking: typed.params.thinking,
        anthropicBetas: typed.params.betas,
        invocationKwargs: typed.params.invocationKwargs
      };

    case 'openrouter':
      return {};

    case 'llama_cpp':
      return { ...typed.params };

    default:
      return assertNeverTypedConfig(typed);
  }
}

function assertNeverProviderType(type: never): never {
  throw new Error(`Unhandled provider type: ${String(type)}`);
}

function assertNeverTypedConfig(typed: never): never {
  throw new Error(`Unhandled typed provider config: ${JSON.stringify(typed)}`);
}
