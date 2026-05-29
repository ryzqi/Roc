import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { rescueToolCall } from '../rescue-parser';

type TextBlock = {
  type?: string;
  text?: unknown;
};

export function createRescueParsingMiddleware(opts: { availableTools: () => string[] }) {
  return createMiddleware({
    name: 'ForgeRescueParsingMiddleware',
    afterModel: (state) => {
      const messages = state.messages;
      if (messages.length === 0) {
        return undefined;
      }
      const last = messages[messages.length - 1];
      if (!AIMessage.isInstance(last)) {
        return undefined;
      }
      if (last.tool_calls !== undefined && last.tool_calls.length > 0) {
        return undefined;
      }
      if (last.id === undefined) {
        return undefined;
      }

      const content = typeof last.content === 'string' ? last.content : extractTextFromBlocks(last.content);
      if (content.trim().length === 0) {
        return undefined;
      }

      const result = rescueToolCall(content, opts.availableTools());
      if (result.toolCalls.length === 0) {
        return undefined;
      }

      const additional_kwargs: Record<string, unknown> = {
        ...last.additional_kwargs,
        forge_rescue: { strategy: result.strategy }
      };
      if (result.reasoningText !== null) {
        additional_kwargs.forge_reasoning_text = result.reasoningText;
      }

      const rebuilt = new AIMessage({
        id: last.id,
        content: '',
        tool_calls: result.toolCalls.map((toolCall, index) => ({
          name: toolCall.tool,
          args: toolCall.args,
          id: `call_rescued_${last.id}_${index}`,
          type: 'tool_call' as const
        })),
        additional_kwargs,
        response_metadata: last.response_metadata,
        usage_metadata: last.usage_metadata
      });

      return {
        messages: [new RemoveMessage({ id: last.id }), rebuilt]
      };
    }
  });
}

function extractTextFromBlocks(content: BaseMessage['content']): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      chunks.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const textBlock = block as TextBlock;
    if ((textBlock.type === undefined || textBlock.type === 'text') && typeof textBlock.text === 'string') {
      chunks.push(textBlock.text);
    }
  }
  return chunks.join('\n');
}
