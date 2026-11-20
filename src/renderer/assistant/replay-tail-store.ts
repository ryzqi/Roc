import type { SequencedChatRunEvent } from '../../shared/types';
import { rendererCachesShouldReclaim, subscribeRendererCacheReclaim } from '../shared/renderer-resource-budget';

export const replayTailLimits = {
  activeBytes: 8 * 1024 * 1024,
  completedBytes: 1024 * 1024,
  globalBytes: 24 * 1024 * 1024,
  events: 10_000,
  runs: 64
} as const;

type StoredReplayEvent = {
  event: SequencedChatRunEvent;
  storedByteLength: number;
};

type ReplayTail = {
  entries: Array<StoredReplayEvent | undefined>;
  head: number;
  storedBytes: number;
  droppedThroughSequence: number;
  completed: boolean;
};

export type ReplayTailStats = {
  storedBytes: number;
  eventCount: number;
  droppedThroughSequence: number;
  completed: boolean;
};

const encoder = new TextEncoder();

/** Only tails with retained events are owned globally. Empty recovery watermarks stay in the bounded local store. */
export class ReplayByteBudget {
  private readonly tails = new Map<ReplayTail, true>();
  private storedBytes = 0;

  constructor(
    readonly maxBytes: number = replayTailLimits.globalBytes,
    private readonly shouldReclaimCompleted: () => boolean = () => false
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('chat_replay_budget_invalid');
  }

  retain(tail: ReplayTail, entry: StoredReplayEvent, maxBytes: number, maxEvents: number): void {
    tail.entries.push(entry);
    tail.storedBytes += entry.storedByteLength;
    this.storedBytes += entry.storedByteLength;
    this.tails.delete(tail);
    this.tails.set(tail, true);
    this.trim(tail, tail.completed && this.shouldReclaimCompleted() ? 0 : maxBytes, maxEvents);
    while (this.storedBytes > this.maxBytes) {
      let oldest: ReplayTail | undefined;
      for (const candidate of this.tails.keys()) {
        oldest ??= candidate;
        if (candidate.completed) {
          oldest = candidate;
          break;
        }
      }
      if (oldest === undefined) throw new Error('chat_replay_budget_accounting_invalid');
      this.evictOldest(oldest);
    }
  }

  trim(tail: ReplayTail, maxBytes: number, maxEvents: number): void {
    if (tail.completed && this.shouldReclaimCompleted()) { maxBytes = 0; maxEvents = 0; }
    while (tail.storedBytes > maxBytes || tail.entries.length - tail.head > maxEvents) {
      this.evictOldest(tail);
    }
  }

  release(tail: ReplayTail): void {
    this.storedBytes -= tail.storedBytes;
    this.tails.delete(tail);
    tail.entries = [];
    tail.head = 0;
    tail.storedBytes = 0;
  }

  reclaimCompleted(): number {
    const before = this.storedBytes;
    for (const tail of this.tails.keys()) {
      if (tail.completed) this.trim(tail, 0, 0);
    }
    return before - this.storedBytes;
  }

  snapshot(): { storedBytes: number; maxBytes: number; tailCount: number; completedBytes: number } {
    let completedBytes = 0;
    for (const tail of this.tails.keys()) {
      if (tail.completed) completedBytes += tail.storedBytes;
    }
    return { storedBytes: this.storedBytes, maxBytes: this.maxBytes, tailCount: this.tails.size, completedBytes };
  }

  private evictOldest(tail: ReplayTail): void {
    const entry = tail.entries[tail.head];
    if (entry === undefined) throw new Error('chat_replay_queue_invalid');
    // Release the object immediately; a head index alone would retain all evicted events.
    tail.entries[tail.head] = undefined;
    tail.head += 1;
    tail.storedBytes -= entry.storedByteLength;
    this.storedBytes -= entry.storedByteLength;
    tail.droppedThroughSequence = Math.max(tail.droppedThroughSequence, entry.event.sequence);
    if (tail.head === tail.entries.length) {
      tail.entries = [];
      tail.head = 0;
      this.tails.delete(tail);
    } else if (tail.head >= 1024 && tail.head * 2 >= tail.entries.length) {
      tail.entries = tail.entries.slice(tail.head);
      tail.head = 0;
    }
  }
}

export const rendererReplayByteBudget = new ReplayByteBudget(replayTailLimits.globalBytes, rendererCachesShouldReclaim);
subscribeRendererCacheReclaim(() => rendererReplayByteBudget.reclaimCompleted());

type StoreLimits = {
  activeBytes: number;
  completedBytes: number;
  events: number;
  runs: number;
};

export class ChatReplayStore {
  private readonly tails = new Map<string, ReplayTail>();
  private readonly limits: StoreLimits;

  constructor(
    private readonly budget: ReplayByteBudget = rendererReplayByteBudget,
    limits: Partial<StoreLimits> = {}
  ) {
    this.limits = {
      activeBytes: replayTailLimits.activeBytes,
      completedBytes: replayTailLimits.completedBytes,
      events: replayTailLimits.events,
      runs: replayTailLimits.runs,
      ...limits
    };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('chat_replay_store_limit_invalid');
    }
  }

  remember(event: SequencedChatRunEvent): void {
    const storedByteLength = encoder.encode(JSON.stringify(event)).byteLength;
    const tail = this.tails.get(event.runId) ?? {
      entries: [], head: 0, storedBytes: 0, droppedThroughSequence: 0, completed: false
    };
    const type = event.event.type;
    if (type === 'run_completed' || type === 'run_cancelled' || type === 'run_failed') tail.completed = true;
    else if (type === 'run_started' || type === 'run_continued' || type === 'run_resumed') tail.completed = false;
    this.tails.delete(event.runId);
    this.tails.set(event.runId, tail);
    while (this.tails.size > this.limits.runs) {
      const oldestRunId = this.tails.keys().next().value;
      if (oldestRunId === undefined) break;
      const oldest = this.tails.get(oldestRunId);
      if (oldest !== undefined) this.budget.release(oldest);
      this.tails.delete(oldestRunId);
    }
    this.budget.retain(tail, {
      event,
      storedByteLength
    }, tail.completed ? this.limits.completedBytes : this.limits.activeBytes, this.limits.events);
  }

  setCompleted(runId: string, completed: boolean): void {
    const tail = this.tails.get(runId);
    if (tail === undefined) return;
    tail.completed = completed;
    this.budget.trim(tail, completed ? this.limits.completedBytes : this.limits.activeBytes, this.limits.events);
  }

  *events(runId: string): Iterable<SequencedChatRunEvent> {
    const tail = this.tails.get(runId);
    if (tail === undefined) return;
    for (let index = tail.head; index < tail.entries.length; index += 1) {
      const entry = tail.entries[index];
      if (entry !== undefined) yield entry.event;
    }
  }

  stats(runId: string): ReplayTailStats | null {
    const tail = this.tails.get(runId);
    return tail === undefined ? null : {
      storedBytes: tail.storedBytes,
      eventCount: tail.entries.length - tail.head,
      droppedThroughSequence: tail.droppedThroughSequence,
      completed: tail.completed
    };
  }

  clear(): void {
    for (const tail of this.tails.values()) this.budget.release(tail);
    this.tails.clear();
  }
}
