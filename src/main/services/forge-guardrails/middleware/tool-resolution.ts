import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { RocToolResolutionError } from '../errors';
import { tagForgeMessage } from '../message-tags';
import { unwrapMiddlewareError } from './middleware-error';

export function createToolResolutionMiddleware() {
  return createMiddleware({
    name: 'ForgeToolResolutionMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        const toolError = unwrapMiddlewareError(error);
        if (!(toolError instanceof RocToolResolutionError)) {
          throw error;
        }
        const toolCallId = request.toolCall.id === undefined ? `unknown_${request.toolCall.name}` : request.toolCall.id;
        const toolMessage = new ToolMessage({
          tool_call_id: toolCallId,
          name: request.toolCall.name,
          content: `[ToolResolutionError] ${toolError.message}`,
          status: 'success'
        });
        return tagForgeMessage(toolMessage, 'forge:tool_resolution');
      }
    }
  });
}
