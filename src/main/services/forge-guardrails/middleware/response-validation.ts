import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { readMessageContentSummary } from '../../deep-agent/record-utils';
import { emptyResponseNudge, retryNudge, unknownToolNudge } from '../nudge-templates';
import { createForgeMessageId, markForgeNudgeInternal, readForgeMessageTag, tagForgeMessage } from '../message-tags';

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
        const toolCalls = last.tool_calls === undefined ? [] : last.tool_calls;
        const knownToolNames = opts.knownToolNames();
        const unknownToolCalls = toolCalls.filter((toolCall) => !knownToolNames.includes(toolCall.name));
        if (unknownToolCalls.length > 0) {
          return {
            messages: unknownToolCalls.map((toolCall) => {
              const toolCallId = toolCall.id === undefined ? `unknown_${toolCall.name}` : toolCall.id;
              const message = new ToolMessage({
                id: createForgeMessageId('unknown-tool-nudge', toolCallId),
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

        const contentSummary = readMessageContentSummary(last);
        if (toolCalls.length === 0 && !contentSummary.hasVisibleText) {
          const sourceId = last.id === undefined ? 'empty-response' : last.id;
          const nudge = new HumanMessage({
            id: createForgeMessageId('retry-nudge', sourceId),
            content: emptyResponseNudge()
          });
          if (contentSummary.hasReasoning) {
            markForgeNudgeInternal(nudge);
          }
          tagForgeMessage(nudge, 'forge:retry_nudge');
          return {
            messages: [nudge],
            jumpTo: 'model' as const
          };
        }

        if (toolCalls.length === 0 && contentSummary.hasVisibleText && !contentSummary.hasReasoning) {
          if (isFinalTextAfterConfirmTool(messages)) {
            return undefined;
          }
          const visibleText = contentSummary.visibleText;
          const sourceId = last.id === undefined ? `content-${hashText(visibleText)}` : last.id;
          const nudge = new HumanMessage({
            id: createForgeMessageId('retry-nudge', sourceId),
            content: retryNudge(visibleText)
          });
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

function isFinalTextAfterConfirmTool(messages: readonly unknown[]): boolean {
  if (messages.length < 2) {
    return false;
  }
  const previous = messages[messages.length - 2];
  return ToolMessage.isInstance(previous) && previous.name === 'confirm_with_user' && previous.status !== 'error';
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash, 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
