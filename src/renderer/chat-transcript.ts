import type { BackgroundTask, TaskEvent, TaskSnapshot } from '../shared/types';
import type { ChatRunState } from './chat-run-state';

export type ChatTranscriptMessage = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
};

type MessagePayload = {
  role: 'user' | 'assistant';
  content: string;
};

type MessageTaskEvent = TaskEvent & {
  type: 'message';
  payload: MessagePayload;
};

function isMessagePayload(payload: unknown): payload is MessagePayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const role = Reflect.get(payload, 'role');
  const content = Reflect.get(payload, 'content');
  return (role === 'user' || role === 'assistant') && typeof content === 'string';
}

function isMessageTaskEvent(event: TaskEvent, threadId: string): event is MessageTaskEvent {
  return event.threadId === threadId && event.type === 'message' && isMessagePayload(event.payload);
}

function resolveActiveThreadId(selectedThreadId: string | null, chatRunState: ChatRunState): string | null {
  if (selectedThreadId !== null) {
    return selectedThreadId;
  }
  return chatRunState.threadId;
}

function buildPersistedTranscriptMessages(recentEvents: TaskEvent[], threadId: string): ChatTranscriptMessage[] {
  return recentEvents
    .filter((event): event is MessageTaskEvent => isMessageTaskEvent(event, threadId))
    .slice()
    .reverse()
    .map((event) => ({
      key: event.id,
      role: event.payload.role,
      content: event.payload.content,
      reasoning: null
    }));
}

export function buildChatTranscript(input: {
  backgroundTasks: BackgroundTask[];
  chatRunState: ChatRunState;
  pendingUserInput: string | null;
  selectedThreadId: string | null;
  taskSnapshot: TaskSnapshot;
}): ChatTranscriptMessage[] {
  const activeThreadId = resolveActiveThreadId(input.selectedThreadId, input.chatRunState);
  if (activeThreadId === null) {
    return input.pendingUserInput === null
      ? []
      : [
          {
            key: 'pending-user-message',
            role: 'user',
            content: input.pendingUserInput,
            reasoning: null
          }
        ];
  }

  const messages = buildPersistedTranscriptMessages(input.taskSnapshot.recentEvents, activeThreadId);
  if (input.pendingUserInput !== null && !messages.some((message) => message.role === 'user' && message.content === input.pendingUserInput)) {
    messages.push({
      key: 'pending-user-message',
      role: 'user',
      content: input.pendingUserInput,
      reasoning: null
    });
  }

  if (input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }

  const liveContent = input.chatRunState.assistantMessage;
  const liveReasoning = input.chatRunState.reasoning;
  const lastAssistantIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant');
  const assistantIndex = lastAssistantIndex === -1 ? -1 : messages.length - 1 - lastAssistantIndex;
  const matchesPersistedAssistant =
    assistantIndex !== -1 &&
    messages[assistantIndex].content === liveContent &&
    input.chatRunState.status !== 'running';

  if (matchesPersistedAssistant) {
    messages[assistantIndex] = {
      ...messages[assistantIndex],
      reasoning: liveReasoning.length === 0 ? null : liveReasoning
    };
    return messages;
  }

  if (liveContent.length === 0 && liveReasoning.length === 0) {
    return messages;
  }

  messages.push({
    key: `live-${input.chatRunState.runId ?? 'assistant'}`,
    role: 'assistant',
    content: liveContent,
    reasoning: liveReasoning.length === 0 ? null : liveReasoning
  });
  return messages;
}
