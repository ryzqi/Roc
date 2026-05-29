import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { retryNudge, unknownToolNudge } from '../nudge-templates';
import { readForgeMessageTag, tagForgeMessage } from '../message-tags';

export function createResponseValidationMiddleware(opts: { knownToolNames: () => string[] }) {
  return createMiddleware({
    name: 'ForgeResponseValidation',
    afterModel: {
      canJumpTo: ['model'],
      hook: (state) => {
        const messages = state.messages;
        if (messages.length === 0) {
          return undefined;
        }
        const last = messages[messages.length - 1];
        if (!AIMessage.isInstance(last)) {
          return undefined;
        }
        if (readForgeMessageTag(last) === 'forge:respond_synthetic') {
          return undefined;
        }

        const toolCalls = last.tool_calls === undefined ? [] : last.tool_calls;
        const knownToolNames = opts.knownToolNames();
        const unknownToolCalls = toolCalls.filter((toolCall) => !knownToolNames.includes(toolCall.name));
        if (unknownToolCalls.length > 0) {
          return {
            messages: unknownToolCalls.map((toolCall) => {
              const toolCallId = toolCall.id === undefined ? `unknown_${toolCall.name}` : toolCall.id;
              const message = new ToolMessage({
                tool_call_id: toolCallId,
                name: toolCall.name,
                content: `[UnknownTool] ${unknownToolNudge(toolCall.name, knownToolNames)}`,
                status: 'error'
              });
              return tagForgeMessage(message, 'forge:unknown_tool_nudge');
            }),
            jumpTo: 'model' as const
          };
        }

        const content = typeof last.content === 'string' ? last.content : '';
        if (toolCalls.length === 0 && content.trim().length > 0) {
          const nudge = new HumanMessage(retryNudge(content));
          tagForgeMessage(nudge, 'forge:retry_nudge');
          return {
            messages: [nudge],
            jumpTo: 'model' as const
          };
        }

        return undefined;
      }
    }
  });
}
