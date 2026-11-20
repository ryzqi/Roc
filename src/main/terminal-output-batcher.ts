import type { TerminalSessionOutputEvent } from '../shared/types';

export type TerminalOutputBatcher = {
  schedule: (event: TerminalSessionOutputEvent) => void;
  flush: () => void;
};

export function createTerminalOutputBatcher({
  intervalMs,
  send
}: {
  intervalMs: number;
  send: (event: TerminalSessionOutputEvent) => void;
}): TerminalOutputBatcher {
  const pendingBySession = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingBySession.size === 0) {
      return;
    }
    const pendingEvents = [...pendingBySession.entries()].map(([sessionId, data]) => ({
      sessionId,
      data
    }));
    pendingBySession.clear();
    for (const event of pendingEvents) {
      send(event);
    }
  }

  return {
    schedule: (event) => {
      const pending = pendingBySession.get(event.sessionId);
      pendingBySession.set(event.sessionId, pending === undefined ? event.data : pending + event.data);
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, intervalMs);
      }
    },
    flush
  };
}
