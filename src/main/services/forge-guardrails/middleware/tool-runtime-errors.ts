import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { RocDomainError } from '../../errors';

const NETWORK_TOOL_NAMES = new Set(['web_read', 'web_search']);

export function createToolRuntimeErrorMiddleware() {
  return createMiddleware({
    name: 'RocToolRuntimeErrorMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (isGraphBubbleUp(error) || isAbortError(error) || NETWORK_TOOL_NAMES.has(request.toolCall.name)) {
          throw error;
        }
        return new ToolMessage({
          tool_call_id: request.toolCall.id === undefined ? `unknown_${request.toolCall.name}` : request.toolCall.id,
          name: request.toolCall.name,
          content: formatToolRuntimeError(error),
          status: 'error'
        });
      }
    }
  });
}

function formatToolRuntimeError(error: unknown): string {
  if (error instanceof RocDomainError) {
    return formatRocToolError(error);
  }
  if (error instanceof Error) {
    return `[ToolRuntimeError] ${error.name}: ${error.message}`;
  }
  return `[ToolRuntimeError] ${String(error)}`;
}

function formatRocToolError(error: RocDomainError): string {
  if (error.userAction === undefined) {
    return `[RocToolError] ${error.code}: ${error.message}`;
  }
  return `[RocToolError] ${error.code}: ${error.message}\n${error.userAction}`;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError' || error.message.startsWith('AbortError') || error.message.startsWith('Cancel');
}
