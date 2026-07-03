import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRunEventLog, applyAgentRunEventLogSchema } from '../../../../src/main/plugins/agent/run-event-log';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentRunEventLogSchema(db);
});

afterEach(() => {
  db.close();
});

describe('AgentRunEventLog', () => {
  it('assigns increasing per-run sequence numbers and replays after a sequence', () => {
    const log = new AgentRunEventLog(db);
    const first = log.recordRunEvent({
      type: 'run_started',
      runId: 'run_1',
      mode: 'chat',
      threadId: 'thread_1',
      providerId: 'openai',
      modelId: 'openai:gpt-4.1',
      createdAt: '2026-07-03T00:00:00.000Z'
    });
    const second = log.recordRunEvent({
      type: 'assistant_block',
      runId: 'run_1',
      block: {
        kind: 'text',
        blockId: 'text-run_1',
        phase: 'delta',
        text: 'partial'
      }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.listRunEvents({ runId: 'run_1', afterSequence: 1 })).toEqual([second]);
  });
});
