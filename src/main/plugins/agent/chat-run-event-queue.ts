import type { ChatRunEvent } from '../../../shared/types';

export function createChatRunEventQueue(): AsyncIterable<ChatRunEvent> & {
  close: () => void;
  fail: (error: unknown) => void;
  push: (event: ChatRunEvent) => void;
} {
  const events: ChatRunEvent[] = [];
  let nextEventIndex = 0;
  let closed = false;
  let failure: unknown = null;
  let waiting:
    | {
        resolve: (result: IteratorResult<ChatRunEvent>) => void;
        reject: (error: unknown) => void;
      }
    | null = null;

  const queue = {
    push: (event: ChatRunEvent): void => {
      if (closed || failure !== null) {
        return;
      }
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.resolve({
          done: false,
          value: event
        });
        return;
      }
      events.push(event);
    },
    close: (): void => {
      if (closed || failure !== null) {
        return;
      }
      closed = true;
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.resolve({
          done: true,
          value: undefined
        });
      }
    },
    fail: (error: unknown): void => {
      if (closed || failure !== null) {
        return;
      }
      failure = error;
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.reject(error);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ChatRunEvent> {
      return {
        next: async (): Promise<IteratorResult<ChatRunEvent>> => {
          if (nextEventIndex < events.length) {
            const event = events[nextEventIndex];
            nextEventIndex += 1;
            if (nextEventIndex === events.length) {
              events.length = 0;
              nextEventIndex = 0;
            }
            return {
              done: false,
              value: event
            };
          }
          if (failure !== null) {
            throw failure;
          }
          if (closed) {
            return {
              done: true,
              value: undefined
            };
          }
          return await new Promise<IteratorResult<ChatRunEvent>>((resolve, reject) => {
            waiting = {
              resolve,
              reject
            };
          });
        }
      };
    }
  };
  return queue;
}

