import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

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

export function createContextTokenCounter(
  model: Pick<BaseChatModel, 'getNumTokens'>
): ContextTokenCounter {
  let estimated = false;
  const countText = async (text: string): Promise<ContextTokenCount> => {
    const getNumTokens = model.getNumTokens;
    if (typeof getNumTokens === 'function') {
      try {
        const tokens = await getNumTokens.call(model, text);
        if (Number.isInteger(tokens) && tokens >= 0 && (text.length === 0 || tokens > 0)) {
          return { estimated: false, tokens };
        }
      } catch {
        estimated = true;
      }
    }
    estimated = true;
    return {
      estimated: true,
      tokens: conservativeTextEstimate(text)
    };
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
      const messageFramingTokens = messages.length * 8;
      return {
        estimated: counts.some((count) => count.estimated),
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
  return {
    contextWindowTokens: input.contextWindowTokens,
    modelInputTokens,
    reservedOutputTokens,
    systemToolOverheadTokens,
    summaryInputTokens: Math.max(1, Math.min(MAX_SUMMARY_INPUT_TOKENS, Math.floor(modelInputTokens / 2))),
    safetyMarginTokens
  };
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
