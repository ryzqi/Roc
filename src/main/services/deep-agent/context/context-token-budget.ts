import { createHash } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { TiktokenModel } from 'js-tiktoken';
import type { ProviderType } from '../../../../shared/types';

export type ContextBudgetProfile = {
  contextWindowTokens: number;
  modelInputTokens: number;
  reservedOutputTokens: number;
  systemToolOverheadTokens: number;
  summaryInputTokens: number;
  safetyMarginTokens: number;
};

export type ContextTokenCount = {
  estimated: boolean;
  tokens: number;
};

export type ContextTokenCounter = {
  countMessages: (messages: readonly BaseMessage[]) => Promise<ContextTokenCount>;
  countText: (text: string) => Promise<ContextTokenCount>;
  wasEstimated: () => boolean;
};

export type ContextToolDefinition = {
  name: string;
  description: string;
  schema?: unknown;
};

const DEFAULT_RESERVED_OUTPUT_FRACTION = 0.125;
const DEFAULT_SAFETY_MARGIN_FRACTION = 0.05;
const MIN_RESERVED_OUTPUT_TOKENS = 256;
const MIN_SAFETY_MARGIN_TOKENS = 128;
const BASE_SYSTEM_TOOL_OVERHEAD_TOKENS = 128;
const MAX_SUMMARY_INPUT_TOKENS = 16_384;

const profileCache = new WeakMap<ContextTokenCounter, Map<string, ContextBudgetProfile>>();
const tokenizers = new Map<string, ReturnType<typeof import('js-tiktoken')['getEncoding']>>();

async function loadTokenizer(modelId: string): Promise<ReturnType<typeof import('js-tiktoken')['getEncoding']> | null> {
  const module = await import('js-tiktoken');
  let name: ReturnType<typeof module.getEncodingNameForModel>;
  try { name = module.getEncodingNameForModel(modelId as TiktokenModel); } catch { return null; }
  let tokenizer = tokenizers.get(name);
  if (tokenizer === undefined) { tokenizer = module.getEncoding(name); tokenizers.set(name, tokenizer); }
  return tokenizer;
}

export function createContextTokenCounter(input: { modelId: string; providerType: ProviderType; baseUrl: string | null }): ContextTokenCounter {
  const officialOpenAI = input.providerType === 'openai_compatible' &&
    (input.baseUrl === null || new URL(input.baseUrl).origin === 'https://api.openai.com');
  let estimated = false;
  const cache = new Map<string, ContextTokenCount>();
  let encoding: Promise<ReturnType<typeof import('js-tiktoken')['encodingForModel']> | null> | null = null;
  const countText = async (text: string): Promise<ContextTokenCount> => {
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    let count: ContextTokenCount;
    if (officialOpenAI) {
      encoding ??= loadTokenizer(input.modelId);
      const tokenizer = await encoding;
      count = tokenizer === null ? { estimated: true, tokens: conservativeTextEstimate(text) }
        : { estimated: false, tokens: tokenizer.encode(text, [], []).length };
    } else {
      count = { estimated: true, tokens: conservativeTextEstimate(text) };
    }
    estimated ||= count.estimated;
    // Bound cached text independently of conversation length. Exact bytes invalidate changed schemas.
    if (Buffer.byteLength(text, 'utf8') <= 131072) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(text, count);
    }
    return count;
  };

  return {
    countMessages: async (messages) => {
      const counts = await Promise.all(
        messages.map(async (message) => {
          const content = JSON.stringify({
            additional_kwargs: message.additional_kwargs,
            content: message.content,
            id: message.id,
            invalid_tool_calls: AIMessage.isInstance(message) ? message.invalid_tool_calls : undefined,
            tool_call_id: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
            tool_calls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
            tool_name: ToolMessage.isInstance(message) ? message.name : undefined,
            tool_status: ToolMessage.isInstance(message) ? message.status : undefined,
            type: message.getType()
          });
          return await countText(content);
        })
      );
      estimated = true;
      const messageFramingTokens = messages.length * 8;
      return {
        estimated: true, // Message framing and JSON projection remain estimates even with an exact text tokenizer.
        tokens: counts.reduce((total, count) => total + count.tokens, messageFramingTokens)
      };
    },
    countText,
    wasEstimated: () => estimated
  };
}

export async function deriveContextBudgetProfile(input: {
  contextWindowTokens: number;
  counter: ContextTokenCounter;
  systemPrompt: string;
  tools: readonly ContextToolDefinition[];
}): Promise<ContextBudgetProfile> {
  requirePositiveInteger(input.contextWindowTokens, 'context_window_tokens_invalid');
  const overheadText = [
    input.systemPrompt,
    ...input.tools.map((tool) => {
      const schema = normalizeToolSchema(tool.schema);
      if (tool.schema !== undefined && schema === undefined) {
        throw new Error('context_tool_schema_unserializable');
      }
      const serialized = JSON.stringify({
        description: tool.description,
        name: tool.name,
        schema
      });
      if (serialized === undefined) {
        throw new Error('context_tool_definition_unserializable');
      }
      return serialized;
    })
  ].join('\n');
  const key = createHash('sha256').update(`${input.contextWindowTokens}:${overheadText}`).digest('hex');
  let cachedProfiles = profileCache.get(input.counter);
  const cached = cachedProfiles?.get(key);
  if (cached !== undefined) return cached;
  const overheadCount = await input.counter.countText(overheadText);
  const systemToolOverheadTokens = Math.max(
    BASE_SYSTEM_TOOL_OVERHEAD_TOKENS,
    overheadCount.tokens + BASE_SYSTEM_TOOL_OVERHEAD_TOKENS
  );
  const reservedOutputTokens = Math.max(
    MIN_RESERVED_OUTPUT_TOKENS,
    Math.ceil(input.contextWindowTokens * DEFAULT_RESERVED_OUTPUT_FRACTION)
  );
  const safetyMarginTokens = Math.max(
    MIN_SAFETY_MARGIN_TOKENS,
    Math.ceil(input.contextWindowTokens * DEFAULT_SAFETY_MARGIN_FRACTION)
  );
  const modelInputTokens =
    input.contextWindowTokens - reservedOutputTokens - systemToolOverheadTokens - safetyMarginTokens;
  if (modelInputTokens <= 0) {
    throw new Error('context_budget_profile_invalid');
  }
  const profile = {
    contextWindowTokens: input.contextWindowTokens,
    modelInputTokens,
    reservedOutputTokens,
    systemToolOverheadTokens,
    summaryInputTokens: Math.max(1, Math.min(MAX_SUMMARY_INPUT_TOKENS, Math.floor(modelInputTokens / 2))),
    safetyMarginTokens
  };
  if (cachedProfiles === undefined) { cachedProfiles = new Map(); profileCache.set(input.counter, cachedProfiles); }
  if (cachedProfiles.size >= 8) cachedProfiles.delete(cachedProfiles.keys().next().value!);
  cachedProfiles.set(key, profile);
  return profile;
}

function conservativeTextEstimate(text: string): number {
  return Math.max(1, Buffer.byteLength(text, 'utf8'));
}

function normalizeToolSchema(schema: unknown): unknown {
  if (schema === undefined || schema === null) {
    return schema;
  }
  const toJSONSchema = Reflect.get(schema, 'toJSONSchema');
  if (typeof toJSONSchema === 'function') {
    return toJSONSchema.call(schema);
  }
  return schema;
}

function requirePositiveInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(code);
  }
}
