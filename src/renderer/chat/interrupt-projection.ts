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
  if (event.type === 'approval_requested') {
    return {
      kind: 'record',
      interrupt: {
        kind: 'approval',
        ...event.payload
      }
    };
  }
  if (event.type === 'human_question_requested') {
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
  if (event.type === 'approval_decision' || event.type === 'human_question_answered') {
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
