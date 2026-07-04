import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type {
  ChatRunEvent,
  RocHookCommandInput,
  RocHookRunEvent,
  RocHookSessionSource,
  WorkflowHint
} from '../../../shared/types';
import type { HookRuntime, HookRuntimeOutcome } from './runtime';

const stopContinuationLimit = 3;

export type RocHookRunContext = {
  runId: string;
  threadId: string | null;
  workspacePath: string | null;
  cwd: string;
  source: RocHookSessionSource;
  modelId: string;
  workflowHint: WorkflowHint;
};

export type RocHookMiddlewareOptions = {
  hookRuntime: Pick<HookRuntime, 'runEvent'>;
  runContext: RocHookRunContext;
  emitHookEvent: (event: ChatRunEvent) => void;
  initialContexts?: string[];
  scope?: 'run' | 'tool';
};

export function createRocHookMiddleware(options: RocHookMiddlewareOptions) {
  const scope = options.scope === undefined ? 'run' : options.scope;
  let userPromptSubmitted = false;
  let stopContinuationCount = 0;
  const queuedContexts: string[] = [];
  if (scope === 'run' && options.initialContexts !== undefined) {
    queuedContexts.push(...options.initialContexts);
  }

  const runHook = async (event: RocHookCommandInput['event'], payload: RocHookCommandInput['payload']): Promise<HookRuntimeOutcome> => {
    const outcome = await options.hookRuntime.runEvent(createHookInput(options.runContext, event, payload));
    emitHookEvents(options, outcome.events);
    return outcome;
  };

  const queueContexts = (contexts: string[]): void => {
    queuedContexts.push(...contexts);
  };

  const drainContextMessages = (): SystemMessage[] => {
    const messages = queuedContexts.map((context) => new SystemMessage({ content: context }));
    queuedContexts.length = 0;
    return messages;
  };

  const drainQueuedContextsBeforeModel = () => {
    const contextMessages = drainContextMessages();
    if (contextMessages.length === 0) {
      return undefined;
    }
    return {
      messages: contextMessages
    };
  };

  const wrapToolCall: NonNullable<Parameters<typeof createMiddleware>[0]['wrapToolCall']> = async (request, handler) => {
    const toolCallId = request.toolCall.id === undefined ? 'unknown-tool-call' : request.toolCall.id;
    const preOutcome = await runHook('PreToolUse', {
      toolName: request.toolCall.name,
      toolCallId,
      toolInput: request.toolCall.args
    });
    if (preOutcome.blocked) {
      return new ToolMessage({
        tool_call_id: toolCallId,
        name: request.toolCall.name,
        content: preOutcome.blockReason === null ? 'Tool call blocked by hook.' : preOutcome.blockReason,
        status: 'error'
      });
    }

    const nextRequest =
      preOutcome.updatedInput === undefined
        ? request
        : {
            ...request,
            toolCall: {
              ...request.toolCall,
              args: requireToolArgs(preOutcome.updatedInput)
            }
          };
    const result = await handler(nextRequest);
    const postOutcome = await runHook('PostToolUse', {
      toolName: request.toolCall.name,
      toolCallId,
      toolInput: nextRequest.toolCall.args,
      toolOutput: result
    });
    queueContexts(postOutcome.additionalContexts);
    return result;
  };

  if (scope === 'tool') {
    return createMiddleware({
      name: 'RocHookMiddleware',
      beforeModel: drainQueuedContextsBeforeModel,
      wrapToolCall
    });
  }

  return createMiddleware({
    name: 'RocHookMiddleware',
    beforeModel: async (state) => {
      const messages = readMessages(state);
      if (!userPromptSubmitted) {
        userPromptSubmitted = true;
        const outcome = await runHook('UserPromptSubmit', {
          prompt: readUserPrompt(messages)
        });
        if (outcome.blocked) {
          throw new Error(outcome.blockReason === null ? 'Blocked by hook.' : outcome.blockReason);
        }
        queueContexts(outcome.additionalContexts);
      }

      return drainQueuedContextsBeforeModel();
    },
    wrapToolCall,
    afterModel: async (state) => {
      const messages = readMessages(state);
      if (hasPendingToolCalls(messages)) {
        return undefined;
      }
      const outcome = await runHook('Stop', {
        lastAssistantMessage: readLastAssistantMessage(messages),
        visibleOutput: true
      });
      if (outcome.blocked) {
        throw new Error(outcome.blockReason === null ? 'Blocked by hook.' : outcome.blockReason);
      }
      queueContexts(outcome.additionalContexts);
      if (outcome.requestContinue === null) {
        stopContinuationCount = 0;
        return undefined;
      }
      if (stopContinuationCount >= stopContinuationLimit) {
        return undefined;
      }
      stopContinuationCount += 1;
      return {
        messages: [...drainContextMessages(), new HumanMessage({ content: outcome.requestContinue })],
        jumpTo: 'model' as const
      };
    }
  });
}

function createHookInput(
  context: RocHookRunContext,
  event: RocHookCommandInput['event'],
  payload: RocHookCommandInput['payload']
): RocHookCommandInput {
  return {
    schemaVersion: 1,
    event,
    runId: context.runId,
    threadId: context.threadId,
    workspacePath: context.workspacePath,
    cwd: context.cwd,
    triggeredAt: new Date().toISOString(),
    payload
  } as RocHookCommandInput;
}

function emitHookEvents(options: RocHookMiddlewareOptions, events: RocHookRunEvent[]): void {
  for (const event of events) {
    options.emitHookEvent(event);
  }
}

function readMessages(state: unknown): BaseMessage[] {
  if (!isRecord(state) || !Array.isArray(state.messages)) {
    return [];
  }
  return state.messages as BaseMessage[];
}

function readUserPrompt(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message._getType() === 'human') {
      return stringifyContent(message.content);
    }
  }
  return '';
}

function readLastAssistantMessage(messages: BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && AIMessage.isInstance(message)) {
      return stringifyContent(message.content);
    }
  }
  return null;
}

function hasPendingToolCalls(messages: BaseMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls;
      if (toolCalls === undefined) {
        return false;
      }
      if (toolCalls.length === 0) {
        return false;
      }

      const completedToolCallIds = new Set<string>();
      for (let toolMessageIndex = index + 1; toolMessageIndex < messages.length; toolMessageIndex += 1) {
        const toolMessage = messages[toolMessageIndex];
        if (toolMessage !== undefined && ToolMessage.isInstance(toolMessage)) {
          completedToolCallIds.add(toolMessage.tool_call_id);
        }
      }

      for (const toolCall of toolCalls) {
        if (toolCall.id === undefined) {
          return true;
        }
        if (!completedToolCallIds.has(toolCall.id)) {
          return true;
        }
      }
      return false;
    }
  }
  return false;
}

function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content);
}

function requireToolArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('hook_replace_input_invalid');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
