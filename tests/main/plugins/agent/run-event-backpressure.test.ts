import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  chatRunEventQueueMaxCoalescedChars,
  createChatRunEventQueue
} from '../../../../src/main/plugins/agent/chat-run-event-queue';
import { agentRunEventLogMaxEvents, AgentRunEventLog } from '../../../../src/main/plugins/agent/run-event-log';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';

describe('agent run event backpressure', () => {
  it('coalesces 100k adjacent text deltas and stops a 10k non-coalescible producer at its high-water mark', async () => {
    const coalescedQueue = createChatRunEventQueue({ maxEvents: 1_000 });
    for (let index = 0; index < 100_000; index += 1) {
      expect(coalescedQueue.push(textEvent('x'))).toBe(true);
    }
    expect(coalescedQueue.stats()).toEqual({
      highWaterMark: Math.ceil(100_000 / chatRunEventQueueMaxCoalescedChars),
      queuedEventCount: Math.ceil(100_000 / chatRunEventQueueMaxCoalescedChars),
      maxEvents: 1_000
    });
    coalescedQueue.close();
    const coalescedEvents = await collect(coalescedQueue);
    expect(
      coalescedEvents
        .map((event) => (isTextAssistantBlock(event) ? event.block.text : ''))
        .join('')
    ).toBe('x'.repeat(100_000));

    const fullCoalescedQueue = createChatRunEventQueue({ maxEvents: 1 });
    expect(fullCoalescedQueue.push(textEvent('first'))).toBe(true);
    expect(fullCoalescedQueue.push(textEvent(' second'))).toBe(true);
    fullCoalescedQueue.close();
    await expect(collect(fullCoalescedQueue)).resolves.toEqual([textEvent('first second')]);

    const boundedQueue = createChatRunEventQueue({ maxEvents: 1_000 });
    let rejectedCount = 0;
    for (let index = 0; index < 10_000; index += 1) {
      if (!boundedQueue.push(textEvent('event', `text-${index}`))) {
        rejectedCount += 1;
      }
    }
    expect(rejectedCount).toBe(9_000);
    expect(boundedQueue.stats()).toEqual({ highWaterMark: 1_000, queuedEventCount: 1_000, maxEvents: 1_000 });
    await expect(collect(boundedQueue)).rejects.toThrow('chat_run_event_queue_overflow');
  });

  it('caps each run timeline at 10k events and replays the retained sequence within a bounded P95', () => {
    const db = new Database(':memory:');
    try {
      applyAgentPluginSchema(db);
      seedRun(db);
      const log = new AgentRunEventLog(db);
      const maxStreamedEvents = agentRunEventLogMaxEvents - 1;
      for (let index = 0; index < maxStreamedEvents; index += 1) {
        log.recordRunEvent(textEvent(`event-${index}`, `text-${index}`));
      }

      const replayDurations: number[] = [];
      let replayedCount = 0;
      for (let sample = 0; sample < 5; sample += 1) {
        const startedAt = performance.now();
        const replayed = log.listRunEvents({ runId: 'run_1', afterSequence: 0 });
        replayDurations.push(performance.now() - startedAt);
        replayedCount = replayed.length;
      }

      expect(replayedCount).toBe(maxStreamedEvents);
      expect(percentile95(replayDurations)).toBeLessThan(1_000);
      expect(() => log.recordRunEvent(textEvent('overflow', 'text-overflow'))).toThrow('agent_run_event_log_capacity_exceeded');
      expect(log.listRunEvents({ runId: 'run_1', afterSequence: 0 }).map((event) => event.sequence)).toEqual(
        Array.from({ length: maxStreamedEvents }, (_, index) => index + 1)
      );
    } finally {
      db.close();
    }
  });
});

function seedRun(db: Database.Database): void {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('thread_1', 'chat', 'Run event test', 'Run event test', 'waiting_next_turn', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
      enabled_capabilities_json, workspace_path, task_source, workflow_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'run_1',
    'thread_1',
    1,
    'Run event test',
    'waiting_next_turn',
    '2026-07-17T00:00:00.000Z',
    null,
    'openai',
    'openai:gpt-4.1',
    '{"mcpServers":[],"skills":[]}',
    null,
    null,
    null
  );
}

function textEvent(text: string, blockId = 'text-1') {
  return {
    type: 'assistant_block' as const,
    runId: 'run_1',
    block: {
      kind: 'text' as const,
      blockId,
      phase: 'delta' as const,
      text
    }
  };
}

async function collect(queue: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (value === undefined) {
    throw new Error('replay_duration_samples_missing');
  }
  return value;
}

function isTextAssistantBlock(event: unknown): event is ReturnType<typeof textEvent> {
  return (
    typeof event === 'object' &&
    event !== null &&
    Reflect.get(event, 'type') === 'assistant_block' &&
    Reflect.get(Reflect.get(event, 'block') as object, 'kind') === 'text'
  );
}
