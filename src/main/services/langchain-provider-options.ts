import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenAICallOptions } from '@langchain/openai';
import { anthropicThinkingMinBudgetTokens, type ProviderConfig, type ProviderModelOptions, type ProviderType } from '../../shared/types';
import type { LlamaCppParams, NvidiaParams, OpenAICompatibleParams } from '../../shared/types/provider-config';
import { RocDomainError } from './errors';
import {
  applyProviderOverride,
  resolveSamplingProfile,
  type SamplingProfile
} from './forge-guardrails/sampling-defaults';
import {
  nvidiaThinkingParameterName,
  resolveNvidiaModelFamily
} from './nvidia-model-family';
import type { LogService } from './log-service';

export type ModelFactoryLogService = Pick<LogService, 'info' | 'warn'>;

export function resolveLlamaCppSamplingProfile(
  provider: ProviderConfig,
  modelId: string,
  modelOptions: ProviderModelOptions,
  logService: ModelFactoryLogService | null
): SamplingProfile | null {
  const familyProfile = resolveSamplingProfile(modelId);
  const overrides = modelOptions.samplingProfileOverrides ?? {};
  if (familyProfile === null) {
    if (Object.keys(overrides).length === 0) {
      logService?.info('Provider local model family is unknown.', {
        service: 'langchain-model-factory',
        component: 'resolveLlamaCppSamplingProfile',
        metadata: {
          providerId: provider.id,
          modelId
        }
      });
      return null;
    }
    return { ...overrides };
  }
  return applyProviderOverride(familyProfile, overrides);
}

export function buildLlamaCppSamplingModelKwargs(options: LlamaCppParams, profile: SamplingProfile | null): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  const topK = options.topK ?? profile?.topK;
  if (typeof topK === 'number') {
    kwargs.top_k = topK;
  }
  const minP = options.minP ?? profile?.minP;
  if (typeof minP === 'number') {
    kwargs.min_p = minP;
  }
  const repeatPenalty = options.repetitionPenalty ?? profile?.repeatPenalty;
  if (typeof repeatPenalty === 'number') {
    kwargs.repeat_penalty = repeatPenalty;
  }
  return kwargs;
}

export function isLangChainProviderType(
  type: ProviderType
): type is 'openai_compatible' | 'anthropic_compatible' | 'nvidia' | 'openrouter' | 'llama_cpp' {
  return (
    type === 'openai_compatible' ||
    type === 'anthropic_compatible' ||
    type === 'nvidia' ||
    type === 'openrouter' ||
    type === 'llama_cpp'
  );
}

export function buildNvidiaModelKwargs(
  modelId: string,
  options: NvidiaParams,
  streaming: boolean
): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  const family = resolveNvidiaModelFamily(modelId);

  if (typeof options.thinking === 'boolean') {
    const paramName = nvidiaThinkingParameterName(family);
    if (paramName !== null) {
      kwargs.chat_template_kwargs = { [paramName]: options.thinking };
    }
  }
  if (family === 'deepseek') {
    kwargs.reasoning_effort = typeof options.thinking === 'boolean' && options.thinking ? 'medium' : 'none';
  }
  if (typeof options.includeReasoning === 'boolean' && !streaming) {
    kwargs.include_reasoning = options.includeReasoning;
  }
  if (typeof options.topP === 'number') {
    kwargs.top_p = options.topP;
  }
  if (typeof options.topK === 'number') {
    kwargs.top_k = options.topK;
  }
  if (typeof options.minP === 'number') {
    kwargs.min_p = options.minP;
  }
  if (typeof options.frequencyPenalty === 'number') {
    kwargs.frequency_penalty = options.frequencyPenalty;
  }
  if (typeof options.presencePenalty === 'number') {
    kwargs.presence_penalty = options.presencePenalty;
  }
  if (typeof options.repetitionPenalty === 'number') {
    kwargs.repetition_penalty = options.repetitionPenalty;
  }
  if (typeof options.seed === 'number') {
    kwargs.seed = options.seed;
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    kwargs.stop = [...options.stop];
  }
  if (options.toolChoice !== undefined) {
    kwargs.tool_choice = options.toolChoice;
  }

  const nvext: Record<string, unknown> = {};
  if (options.guidedJson !== undefined) {
    nvext.guided_json = options.guidedJson;
  }
  if (typeof options.guidedRegex === 'string') {
    nvext.guided_regex = options.guidedRegex;
  }
  if (Array.isArray(options.guidedChoice) && options.guidedChoice.length > 0) {
    nvext.guided_choice = [...options.guidedChoice];
  }
  if (typeof options.guidedGrammar === 'string') {
    nvext.guided_grammar = options.guidedGrammar;
  }
  if (Object.keys(nvext).length > 0) {
    kwargs.nvext = nvext;
  }

  return kwargs;
}

export function resolveStreamUsage(provider: ProviderConfig, modelOptions: ProviderModelOptions, streaming: boolean): boolean | undefined {
  if (!streaming) {
    return undefined;
  }
  if (provider.type === 'llama_cpp') {
    return false;
  }
  if (provider.type === 'nvidia') {
    return modelOptions.streamUsage ?? true;
  }
  if (provider.type === 'openai_compatible' || provider.type === 'anthropic_compatible') {
    if (modelOptions.streamUsage !== undefined) {
      return modelOptions.streamUsage;
    }
    // Default false for openai_compatible to maximize compatibility.
    // Official OpenAI supports stream_options, but many compatible providers don't.
    // Users can explicitly set streamUsage: true if their provider supports it.
    if (provider.type === 'openai_compatible') {
      return false;
    }
    // anthropic_compatible defaults to undefined (let LangChain decide)
    return undefined;
  }
  return undefined;
}

export function resolveAnthropicBetas(betas: string[]): string[] {
  const validBetas: string[] = [];
  for (const beta of betas) {
    if (beta.trim().length > 0) {
      validBetas.push(beta);
    }
  }
  return validBetas;
}

export function resolveAnthropicThinking(
  options: ProviderModelOptions
): { type: 'disabled' } | { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | undefined {
  if (options?.anthropicThinking === undefined) {
    return undefined;
  }
  if (options.anthropicThinking.mode === 'disabled') {
    return {
      type: 'disabled'
    };
  }
  if (options.anthropicThinking.mode === 'adaptive') {
    return {
      type: 'adaptive'
    };
  }
  if (options.anthropicThinking.mode === 'enabled') {
    if (
      !Number.isInteger(options.anthropicThinking.budgetTokens) ||
      options.anthropicThinking.budgetTokens < anthropicThinkingMinBudgetTokens
    ) {
      throw new RocDomainError({
        code: 'provider_invalid',
        message: `Anthropic thinking budget tokens 必须大于等于 ${anthropicThinkingMinBudgetTokens}。`,
        category: 'validation',
        retryable: false,
        userAction: '请在设置页将 Anthropic thinking budget tokens 调整到官方下限以上。'
      });
    }
    if (
      typeof options.maxTokens === 'number' &&
      options.anthropicThinking.budgetTokens >= options.maxTokens
    ) {
      throw new RocDomainError({
        code: 'provider_invalid',
        message: 'Anthropic thinking budget tokens 必须小于 Max tokens。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页调大 Max tokens，或调小 Anthropic thinking budget tokens。'
      });
    }
    return {
      type: 'enabled',
      budget_tokens: options.anthropicThinking.budgetTokens
    };
  }
  return undefined;
}

export function resolveOpenAiCompatibleDefaultOptions(
  params: OpenAICompatibleParams | null
): Partial<ChatOpenAICallOptions> & { parallel_tool_calls?: boolean } {
  if (params === null) {
    return {};
  }
  const defaults: Partial<ChatOpenAICallOptions> & { parallel_tool_calls?: boolean } = {};
  if (typeof params.seed === 'number') {
    defaults.seed = params.seed;
  }
  if (typeof params.parallelToolCalls === 'boolean') {
    defaults.parallel_tool_calls = params.parallelToolCalls;
  }
  if (params.verbosity !== undefined) {
    defaults.verbosity = params.verbosity;
  }
  return defaults;
}

export function applyOpenAiCompatibleDefaultOptions(
  model: BaseChatModel,
  defaults: Partial<ChatOpenAICallOptions> & { parallel_tool_calls?: boolean }
): void {
  if (Object.keys(defaults).length === 0) {
    return;
  }
  const target = model as BaseChatModel & {
    defaultOptions?: Record<string, unknown>;
  };
  target.defaultOptions = {
    ...(target.defaultOptions ?? {}),
    ...defaults
  };
}

export function createFetchWithoutAuthorization(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    const overrideHeaders = new Headers(init?.headers);
    overrideHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    headers.delete('authorization');
    headers.delete('Authorization');
    headers.delete('api-key');
    headers.delete('x-api-key');
    const nextInit = {
      ...init,
      headers
    };
    if (input instanceof Request) {
      return await globalThis.fetch(new Request(input, nextInit));
    }
    return await globalThis.fetch(input, nextInit);
  };
}
