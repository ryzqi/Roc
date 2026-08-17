import type {
  ChatPendingInterrupt,
  ChatRunEvent,
  TaskEvent
} from '../../shared/types';

export type ChatInterruptProjectionEvent =
  | {
      kind: 'record';
      interrupt: ChatPendingInterrupt;
    }
  | {
      kind: 'consume';
      interruptId: string;
    };

type PersistedApprovalInterrupt = Omit<Extract<ChatPendingInterrupt, { kind: 'approval' }>, 'kind'>;

export function readLiveInterruptProjection(event: ChatRunEvent): ChatInterruptProjectionEvent | null {
  if (event.type === 'run_interrupted') {
    return {
      kind: 'record',
      interrupt:
        event.payload.kind === 'approval'
          ? {
              kind: 'approval',
              interruptId: event.interruptId,
              ...event.payload.request
            }
          : {
              interruptId: event.interruptId,
              ...event.payload
            }
    };
  }
  if (event.type === 'run_resumed') {
    return {
      kind: 'consume',
      interruptId: event.interruptId
    };
  }
  return null;
}

export function readPersistedInterruptProjection(event: TaskEvent): ChatInterruptProjectionEvent | null {
  if (event.type === 'approval_requested' && isApprovalRequestedPayload(event.payload)) {
    return {
      kind: 'record',
      interrupt: {
        kind: 'approval',
        ...event.payload
      }
    };
  }
  if (event.type === 'human_question_requested' && isHumanQuestionPayload(event.payload)) {
    return {
      kind: 'record',
      interrupt: {
        kind: 'question',
        interruptId: event.payload.interruptId,
        question: event.payload.question,
        ...(event.payload.context === null ? {} : { context: event.payload.context }),
        suggestedResponses: event.payload.suggestedResponses
      }
    };
  }
  if ((event.type === 'approval_decision' || event.type === 'human_question_answered') && isConsumedInterruptPayload(event.payload)) {
    return {
      kind: 'consume',
      interruptId: event.payload.interruptId
    };
  }
  return null;
}

export function applyPendingInterruptProjection(
  interrupts: readonly ChatPendingInterrupt[],
  event: ChatInterruptProjectionEvent
): ChatPendingInterrupt[] {
  if (event.kind === 'consume') {
    return interrupts.filter((interrupt) => interrupt.interruptId !== event.interruptId);
  }
  const existingIndex = interrupts.findIndex((interrupt) => interrupt.interruptId === event.interrupt.interruptId);
  if (existingIndex === -1) {
    return [...interrupts, event.interrupt];
  }
  return interrupts.map((interrupt, index) => (index === existingIndex ? event.interrupt : interrupt));
}

function isApprovalRequestedPayload(payload: unknown): payload is PersistedApprovalInterrupt {
  return (
    isRecord(payload) &&
    typeof payload.interruptId === 'string' &&
    Array.isArray(payload.actionRequests) &&
    Array.isArray(payload.reviewConfigs)
  );
}

function isHumanQuestionPayload(payload: unknown): payload is {
  interruptId: string;
  question: string;
  context: string | null;
  suggestedResponses: string[];
} {
  return (
    isRecord(payload) &&
    typeof payload.interruptId === 'string' &&
    typeof payload.question === 'string' &&
    (payload.context === null || typeof payload.context === 'string') &&
    Array.isArray(payload.suggestedResponses) &&
    payload.suggestedResponses.every((response): response is string => typeof response === 'string')
  );
}

function isConsumedInterruptPayload(payload: unknown): payload is { interruptId: string } {
  return isRecord(payload) && typeof payload.interruptId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
