import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { RocToolResolutionError } from '../errors';
import { tagForgeMessage } from '../message-tags';

export function createToolResolutionMiddleware() {
  return createMiddleware({
    name: 'ForgeToolResolutionMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (!(error instanceof RocToolResolutionError)) {
          throw error;
        }
        const toolCallId = request.toolCall.id === undefined ? `unknown_${request.toolCall.name}` : request.toolCall.id;
        const toolMessage = new ToolMessage({
          tool_call_id: toolCallId,
          name: request.toolCall.name,
          content: `[ToolResolutionError] ${error.message}`,
          status: 'success'
        });
        return tagForgeMessage(toolMessage, 'forge:tool_resolution');
      }
    }
  });
}
