import { ToolMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';

import { AgentToolEffectStore, hashToolInput } from './tool-effect-store';

type ToolEffectIdempotencyOptions = {
  runId: string;
  threadId: string;
  store: AgentToolEffectStore;
};

type ToolCallRequest = {
  tool?: ClientTool;
  toolCall: {
    args: unknown;
    id?: string;
    name: string;
  };
};

type StoredToolMessage = {
  kind: 'tool_message';
  content: ToolMessage['content'];
  metadata: ToolMessage['metadata'] | undefined;
  name: string;
  status: ToolMessage['status'] | undefined;
  toolCallId: string;
};

const sideEffectingToolNames = new Set<string>([
  'delete_file',
  'run_shell_command',
  'propose_background_task',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task',
  'write_file',
  'edit_file'
]);

const readOnlyToolNames = new Set<string>([
  'ask_user',
  'glob',
  'grep',
  'ls',
  'read_background_task',
  'read_file',
  'web_read',
  'web_search',
  'write_todos'
]);

export function createToolEffectIdempotencyMiddleware(options: ToolEffectIdempotencyOptions) {
  return createMiddleware({
    name: 'RocToolEffectIdempotencyMiddleware',
    wrapToolCall: async (request, handler) => {
      const typedRequest = request as ToolCallRequest;
      if (!isSideEffectingToolCall(typedRequest)) {
        return await handler(request);
      }

      const toolCallId = readToolCallId(typedRequest);
      if (toolCallId === null) {
        return new ToolMessage({
          tool_call_id: 'unknown-tool-call',
          name: typedRequest.toolCall.name,
          content: 'agent_tool_effect_call_id_missing',
          status: 'error'
        });
      }

      const inputHash = hashToolInput({
        args: typedRequest.toolCall.args,
        name: typedRequest.toolCall.name
      });
      const reusable = options.store.readReusable({
        runId: options.runId,
        toolCallId,
        inputHash
      });
      if (reusable !== null) {
        return deserializeToolResult(reusable.result);
      }

      options.store.start({
        runId: options.runId,
        threadId: options.threadId,
        toolCallId,
        toolName: typedRequest.toolCall.name,
        inputHash
      });
      try {
        const result = await handler(request);
        options.store.finishSuccess({
          runId: options.runId,
          toolCallId,
          result: serializeToolResult(result)
        });
        return result;
      } catch (error) {
        options.store.finishError({
          runId: options.runId,
          toolCallId,
          error
        });
        throw error;
      }
    }
  });
}

export function isSideEffectingToolCall(request: ToolCallRequest): boolean {
  if (isToolMarkedReadOnly(request.tool)) {
    return false;
  }
  if (readOnlyToolNames.has(request.toolCall.name)) {
    return false;
  }
  if (sideEffectingToolNames.has(request.toolCall.name)) {
    return true;
  }
  return isMcpToolName(request.toolCall.name);
}

function serializeToolResult(result: unknown): StoredToolMessage {
  if (!ToolMessage.isInstance(result)) {
    throw new Error('agent_tool_effect_result_not_tool_message');
  }
  const name = readToolMessageName(result);
  return {
    kind: 'tool_message',
    content: result.content,
    metadata: result.metadata,
    name,
    status: result.status,
    toolCallId: result.tool_call_id
  };
}

function deserializeToolResult(result: unknown): ToolMessage {
  if (!isStoredToolMessage(result)) {
    throw new Error('agent_tool_effect_result_invalid');
  }
  return new ToolMessage({
    tool_call_id: result.toolCallId,
    name: result.name,
    content: result.content,
    status: result.status,
    metadata: result.metadata
  });
}

function isStoredToolMessage(value: unknown): value is StoredToolMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'tool_message' &&
    typeof value.name === 'string' &&
    typeof value.toolCallId === 'string' &&
    'content' in value
  );
}

function readToolCallId(request: ToolCallRequest): string | null {
  if (typeof request.toolCall.id !== 'string') {
    return null;
  }
  if (request.toolCall.id.length === 0) {
    return null;
  }
  return request.toolCall.id;
}

function readToolMessageName(message: ToolMessage): string {
  const name = Reflect.get(message, 'name');
  if (typeof name !== 'string') {
    throw new Error('agent_tool_effect_result_name_missing');
  }
  if (name.length === 0) {
    throw new Error('agent_tool_effect_result_name_missing');
  }
  return name;
}

function isMcpToolName(name: string): boolean {
  return name.includes('__');
}

function isToolMarkedReadOnly(tool: ClientTool | undefined): boolean {
  if (tool === undefined) {
    return false;
  }
  const metadata = Reflect.get(tool, 'metadata');
  if (hasReadOnlyHint(metadata)) {
    return true;
  }
  const annotations = Reflect.get(tool, 'annotations');
  return hasReadOnlyHint(annotations);
}

function hasReadOnlyHint(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.readOnlyHint === true || value.readonly === true || value.readOnly === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
