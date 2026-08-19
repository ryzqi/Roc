import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from '@langchain/langgraph';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema as applyAgentPluginSchema } from '../../../../src/main/infrastructure/database-schemas';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

type SaverFixture = {
  saver: BaseCheckpointSaver;
  close(): void;
};

const saverFactories: Array<[string, () => SaverFixture]> = [
  [
    'MemorySaver',
    () => ({
      saver: new MemorySaver(),
      close: () => undefined
    })
  ],
  [
    'RocSqliteCheckpointer',
    () => {
      const db = new Database(':memory:');
      applyAgentPluginSchema(db);
      return {
        saver: new RocSqliteCheckpointer(db),
        close: () => db.close()
      };
    }
  ]
];

describe.each(saverFactories)('%s BaseCheckpointSaver conformance', (_name, createFixture) => {
  it('supports put, latest and explicit get, ordered filtered list, and thread deletion', async () => {
    const fixture = createFixture();
    try {
      const { saver } = fixture;
      const threadConfig = configurable('thread_contract', 'scope');
      const otherThreadConfig = configurable('thread_other', 'scope');

      expect(await saver.get(threadConfig)).toBeUndefined();

      const firstConfig = await saver.put(
        threadConfig,
        checkpoint('checkpoint_001', 'first'),
        metadata('input', -1, 'alpha'),
        {}
      );
      const secondConfig = await saver.put(
        firstConfig,
        checkpoint('checkpoint_002', 'second'),
        metadata('loop', 0, 'beta'),
        {}
      );
      const thirdConfig = await saver.put(
        secondConfig,
        checkpoint('checkpoint_003', 'third'),
        metadata('loop', 1, 'alpha'),
        {}
      );
      const otherConfig = await saver.put(
        otherThreadConfig,
        checkpoint('checkpoint_004', 'other'),
        metadata('input', -1, 'other'),
        {}
      );

      expect((await saver.get(threadConfig))?.id).toBe('checkpoint_003');
      expect((await saver.getTuple(firstConfig))?.checkpoint.channel_values).toEqual({ messages: ['first'] });
      expect((await saver.getTuple(thirdConfig))?.parentConfig).toEqual(secondConfig);

      const ordered = await collect(saver, threadConfig);
      expect(checkpointIds(ordered)).toEqual(['checkpoint_003', 'checkpoint_002', 'checkpoint_001']);

      const filtered = await collect(saver, threadConfig, {
        before: thirdConfig,
        filter: { tenant: 'alpha' },
        limit: 1
      });
      expect(checkpointIds(filtered)).toEqual(['checkpoint_001']);

      await saver.putWrites(firstConfig, [['messages', 'delete-me']], 'task-delete');

      await saver.deleteThread('thread_contract');

      expect(await saver.get(threadConfig)).toBeUndefined();
      const recreatedConfig = await saver.put(
        threadConfig,
        checkpoint('checkpoint_001', 'recreated'),
        metadata('input', -1, 'recreated'),
        {}
      );
      expect(requirePendingWrites(await saver.getTuple(recreatedConfig))).toEqual([]);
      expect((await saver.get(otherConfig))?.id).toBe('checkpoint_004');
    } finally {
      fixture.close();
    }
  });

  it('keeps the first regular write and replaces repeated special writes', async () => {
    const fixture = createFixture();
    try {
      const config = await fixture.saver.put(
        configurable('thread_writes', ''),
        checkpoint('checkpoint_writes', 'writes'),
        metadata('input', -1, 'writes'),
        {}
      );
      await fixture.saver.putWrites(
        config,
        [
          ['messages', 'regular-first'],
          ['__error__', 'error-first'],
          ['__scheduled__', 'scheduled-first'],
          ['__interrupt__', 'interrupt-first'],
          ['__resume__', 'resume-first']
        ],
        'task-writes-a'
      );
      await fixture.saver.putWrites(
        config,
        [
          ['messages', 'regular-second'],
          ['__error__', 'error-second'],
          ['__scheduled__', 'scheduled-second'],
          ['__interrupt__', 'interrupt-second'],
          ['__resume__', 'resume-second']
        ],
        'task-writes-a'
      );
      await fixture.saver.putWrites(
        config,
        [
          ['messages', 'regular-other-task'],
          ['__interrupt__', 'interrupt-other-task']
        ],
        'task-writes-b'
      );

      const loaded = await fixture.saver.getTuple(config);
      const expectedWrites = [
        ['task-writes-a', 'messages', 'regular-first'],
        ['task-writes-a', '__error__', 'error-second'],
        ['task-writes-a', '__scheduled__', 'scheduled-second'],
        ['task-writes-a', '__interrupt__', 'interrupt-second'],
        ['task-writes-a', '__resume__', 'resume-second'],
        ['task-writes-b', 'messages', 'regular-other-task'],
        ['task-writes-b', '__interrupt__', 'interrupt-other-task']
      ];
      expect(requirePendingWrites(loaded)).toEqual(expectedWrites);

      const listed = await collect(fixture.saver, configurable('thread_writes', ''));
      expect(listed).toHaveLength(1);
      expect(requirePendingWrites(listed[0])).toEqual(expectedWrites);
    } finally {
      fixture.close();
    }
  });
});

describe('RocSqliteCheckpointer filtered list paging', () => {
  it('pages metadata and loads full checkpoint state only for matching rows', async () => {
    const statements: string[] = [];
    const db = new Database(':memory:', {
      verbose: (statement) => {
        if (typeof statement !== 'string') {
          throw new Error('sqlite_trace_statement_invalid');
        }
        statements.push(statement);
      }
    });
    try {
      applyAgentPluginSchema(db);
      const saver = new RocSqliteCheckpointer(db);
      const config = configurable('thread_filter_paging', 'scope');
      for (let index = 0; index < 130; index += 1) {
        const checkpointId = `checkpoint_${String(index).padStart(3, '0')}`;
        await saver.put(
          config,
          checkpoint(checkpointId, checkpointId),
          metadata('loop', index, index === 0 ? 'alpha' : 'beta'),
          {}
        );
      }
      statements.length = 0;

      const filtered = await collect(saver, config, {
        filter: { tenant: 'alpha' },
        limit: 1
      });

      expect(checkpointIds(filtered)).toEqual(['checkpoint_000']);
      expect(statements.filter((statement) => isMetadataPageRead(statement))).toHaveLength(3);
      expect(statements.filter((statement) => isFullCheckpointRead(statement))).toHaveLength(1);
      expect(statements.filter((statement) => statement.includes('FROM langgraph_checkpoint_writes'))).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

function configurable(threadId: string, checkpointNs: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs
    }
  };
}

function checkpoint(id: string, message: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: '2026-07-23T00:00:00.000Z',
    channel_values: { messages: [message] },
    channel_versions: { messages: 1 },
    versions_seen: {}
  };
}

function metadata(
  source: CheckpointMetadata['source'],
  step: number,
  tenant: string
): CheckpointMetadata & { tenant: string } {
  return {
    source,
    step,
    parents: {},
    tenant
  };
}

async function collect(
  saver: BaseCheckpointSaver,
  config: RunnableConfig,
  options?: Parameters<BaseCheckpointSaver['list']>[1]
): Promise<CheckpointTuple[]> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of saver.list(config, options)) {
    tuples.push(tuple);
  }
  return tuples;
}

function checkpointIds(tuples: readonly CheckpointTuple[]): string[] {
  return tuples.map((tuple) => tuple.checkpoint.id);
}

function requirePendingWrites(tuple: CheckpointTuple | undefined): NonNullable<CheckpointTuple['pendingWrites']> {
  if (tuple === undefined || tuple.pendingWrites === undefined) {
    throw new Error('checkpoint_pending_writes_missing');
  }
  return tuple.pendingWrites;
}

function isMetadataPageRead(statement: string): boolean {
  return statement.includes('SELECT thread_id, checkpoint_ns, checkpoint_id, metadata_type, metadata_blob');
}

function isFullCheckpointRead(statement: string): boolean {
  return statement.includes('SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id');
}
