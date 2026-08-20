import type {
  AnthropicThinkingOption,
  NvidiaToolChoice,
  OpenAiReasoningOption,
  OpenAiServiceTier,
  OpenAiVerbosity,
  ProviderConfig,
  ProviderConnectionOptions,
  ProviderModel,
  ProviderModelOptions,
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
  options?: ProviderConnectionOptions;
};

export type CommonProviderParams = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
};

export type ProviderConnectionParams = {
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  organization?: string;
  endpointOverride?: string;
};

export type OpenAICompatibleParams = CommonProviderParams & {
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  useResponsesApi?: boolean;
  reasoning?: OpenAiReasoningOption;
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
  serviceTier?: OpenAiServiceTier;
  verbosity?: OpenAiVerbosity;
  zdrEnabled?: boolean;
  modelKwargs?: ProviderModelOptions['modelKwargs'];
};

export type AnthropicCompatibleParams = CommonProviderParams & {
  topK?: number;
  stopSequences?: string[];
  thinking?: AnthropicThinkingOption;
  betas?: string[];
  invocationKwargs?: ProviderModelOptions['invocationKwargs'];
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
  guidedJson?: ProviderModelOptions['guidedJson'];
  guidedRegex?: string;
  guidedChoice?: string[];
  guidedGrammar?: string;
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

export function toTypedProviderConfig(
  legacy: ProviderConfig,
  modelOptions: ProviderModelOptions
): ProviderConfigTyped {
  const baseConfig: BaseProviderConfig = {
    id: legacy.id,
    name: legacy.name,
    enabled: legacy.enabled,
    models: legacy.models,
    endpoint: legacy.endpoint,
    credentialRef: legacy.credentialRef,
    options: legacy.options
  };
  const opts = modelOptions;

  switch (legacy.type) {
    case 'openai_compatible':
      return {
        type: 'openai_compatible',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          frequencyPenalty: opts.frequencyPenalty,
          presencePenalty: opts.presencePenalty,
          seed: opts.seed,
          stop: opts.stop,
          useResponsesApi: opts.useResponsesApi,
          reasoning: opts.reasoning,
          parallelToolCalls: opts.parallelToolCalls,
          streamUsage: opts.streamUsage,
          serviceTier: opts.serviceTier,
          verbosity: opts.verbosity,
          zdrEnabled: opts.zdrEnabled,
          modelKwargs: opts.modelKwargs
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
  const modelOptions = providerOptionsFromTypedParams(typed);
  return {
    ...typed.config,
    type: typed.type,
    models:
      Object.keys(modelOptions).length === 0
        ? typed.config.models
        : typed.config.models.map((model) => ({ ...model, options: modelOptions }))
  };
}

function providerOptionsFromTypedParams(typed: ProviderConfigTyped): ProviderModelOptions {
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
