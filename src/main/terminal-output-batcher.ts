import type { TerminalSessionOutputEvent } from '../shared/types';

export type TerminalOutputBatcher = {
  schedule: (event: TerminalSessionOutputEvent) => void;
  flush: () => void;
};

/** Preserve UTF-16 sequence ranges across batching so replay/live overlaps can be clipped. */
export function createTerminalOutputBatcher({intervalMs, send}: {
  intervalMs: number;
  send: (event: TerminalSessionOutputEvent) => void;
}): TerminalOutputBatcher {
  const pendingBySession = new Map<string, TerminalSessionOutputEvent>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function flush(): void {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    const pending = [...pendingBySession.values()];
    pendingBySession.clear();
    for (const event of pending) send(event);
  }
  return {
    schedule: event => {
      const pending = pendingBySession.get(event.sessionId);
      if (pending !== undefined && (pending.attachmentId !== event.attachmentId || pending.sequence !== event.startSequence ||
        pending.data.length + event.data.length > 256 * 1024)) {
        pendingBySession.delete(event.sessionId);
        send(pending);
      }
      const previous = pendingBySession.get(event.sessionId);
      pendingBySession.set(event.sessionId, previous === undefined ? event :
        {...event, startSequence: previous.startSequence, data: previous.data + event.data});
      if (flushTimer === null) flushTimer = setTimeout(flush, intervalMs);
    },
    flush
  };
}
