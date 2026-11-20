import type { SequencedChatRunEvent } from '../../src/shared/types';

// Frozen from use-chat-run.ts at 14b97220. This is a benchmark reference, never a runtime fallback.
const maxSeenRunSequences = 64;
const maxLiveReplayTailEvents = 10_000;
const maxLiveReplayTailBytes = 8 * 1024 * 1024;

type LiveReplayTail = {
  events: SequencedChatRunEvent[];
  bytes: number;
  droppedThroughSequence: number;
};

function rememberLiveReplayEvent(tails: Map<string, LiveReplayTail>, event: SequencedChatRunEvent): void {
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  const tail = tails.get(event.runId) ?? { events: [], bytes: 0, droppedThroughSequence: 0 };
  tail.events.push(event);
  tail.bytes += eventBytes;
  while (tail.events.length > maxLiveReplayTailEvents || tail.bytes > maxLiveReplayTailBytes) {
    const dropped = tail.events.shift();
    if (dropped === undefined) break;
    tail.bytes -= new TextEncoder().encode(JSON.stringify(dropped)).byteLength;
    tail.droppedThroughSequence = Math.max(tail.droppedThroughSequence, dropped.sequence);
  }
  tails.delete(event.runId);
  tails.set(event.runId, tail);
  while (tails.size > maxSeenRunSequences) {
    const oldestRunId = tails.keys().next().value;
    if (oldestRunId === undefined || oldestRunId === event.runId) break;
    tails.delete(oldestRunId);
  }
}

export class ReplayByteBudget {
  readonly stores = new Set<ChatReplayStore>();

  snapshot(): { storedBytes: number; tailCount: number } {
    let storedBytes = 0;
    let tailCount = 0;
    for (const store of this.stores) {
      for (const tail of store.tails.values()) {
        storedBytes += tail.bytes;
        tailCount += 1;
      }
    }
    return { storedBytes, tailCount };
  }
}

export class ChatReplayStore {
  readonly tails = new Map<string, LiveReplayTail>();

  constructor(budget: ReplayByteBudget) {
    budget.stores.add(this);
  }

  remember(event: SequencedChatRunEvent): void {
    rememberLiveReplayEvent(this.tails, event);
  }

  events(runId: string): Iterable<SequencedChatRunEvent> {
    return this.tails.get(runId)?.events ?? [];
  }

  stats(runId: string): { storedBytes: number; eventCount: number; droppedThroughSequence: number } | null {
    const tail = this.tails.get(runId);
    return tail === undefined ? null : {
      storedBytes: tail.bytes,
      eventCount: tail.events.length,
      droppedThroughSequence: tail.droppedThroughSequence
    };
  }

  clear(): void {
    this.tails.clear();
  }
}
