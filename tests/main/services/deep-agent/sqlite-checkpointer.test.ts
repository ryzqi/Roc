import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('RocSqliteCheckpointer', () => {
  it('persists checkpoint data so another instance can read the same thread state', async () => {
    const first = new RocSqliteCheckpointer(db);
    const checkpoint = {
      v: 4,
      id: 'checkpoint_1',
      ts: '2026-07-03T00:00:00.000Z',
      channel_values: { messages: ['partial'] },
      channel_versions: { messages: 1 },
      versions_seen: {}
    };

    const config = await first.put(
      {
        configurable: {
          thread_id: 'thread_recovery_1',
          checkpoint_ns: '',
          checkpoint_id: 'parent_checkpoint_1'
        }
      },
      checkpoint,
      {
        source: 'input',
        step: 1,
        parents: {}
      },
      {}
    );

    const second = new RocSqliteCheckpointer(db);
    const loaded = await second.getTuple(config);

    expect(loaded?.checkpoint).toEqual(checkpoint);
    expect(loaded?.config.configurable?.thread_id).toBe('thread_recovery_1');
    expect(loaded?.config.configurable?.checkpoint_id).toBe('checkpoint_1');
    expect(loaded?.parentConfig?.configurable?.checkpoint_id).toBe('parent_checkpoint_1');
  });
});
