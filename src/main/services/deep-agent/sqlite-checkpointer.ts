import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from '@langchain/langgraph';
import type { Database as DatabaseConnection } from 'better-sqlite3';

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint_blob: Buffer;
  metadata_type: string;
  metadata_blob: Buffer;
};

type WriteRow = {
  task_id: string;
  channel: string;
  value_type: string;
  value_blob: Buffer;
};

type CheckpointKey = {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
};

const writesIndexByChannel = new Map<string, number>([
  ['__error__', -1],
  ['__scheduled__', -2],
  ['__interrupt__', -3],
  ['__resume__', -4]
]);

export class RocSqliteCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly db: DatabaseConnection) {
    super();
    applyRocSqliteCheckpointerSchema(db);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = readCheckpointKeyForGet(config);
    if (key.threadId === null) {
      return undefined;
    }
    const checkpointId =
      key.checkpointId === null ? this.readLatestCheckpointId(key.threadId, key.checkpointNs) : key.checkpointId;
    if (checkpointId === null) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                checkpoint_type, checkpoint_blob, metadata_type, metadata_blob
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .get(key.threadId, key.checkpointNs, checkpointId) as CheckpointRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return await this.rowToTuple(row);
  }

  override async *list(
    config: RunnableConfig,
    options?: Parameters<BaseCheckpointSaver['list']>[1]
  ): AsyncGenerator<CheckpointTuple> {
    const key = readCheckpointKeyForList(config);
    const rows = this.listRows(key, options);
    for (const row of rows) {
      yield await this.rowToTuple(row);
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Parameters<BaseCheckpointSaver['put']>[3]
  ): Promise<RunnableConfig> {
    const key = readCheckpointKeyForPut(config, checkpoint);
    const parentCheckpointId =
      config.configurable !== undefined && typeof config.configurable.checkpoint_id === 'string'
        ? config.configurable.checkpoint_id
        : null;
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata)
    ]);
    this.db
      .prepare(
        `INSERT INTO langgraph_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           parent_checkpoint_id = excluded.parent_checkpoint_id,
           checkpoint_type = excluded.checkpoint_type,
           checkpoint_blob = excluded.checkpoint_blob,
           metadata_type = excluded.metadata_type,
           metadata_blob = excluded.metadata_blob`
      )
      .run(
        key.threadId,
        key.checkpointNs,
        key.checkpointId,
        parentCheckpointId,
        checkpointType,
        Buffer.from(checkpointBytes),
        metadataType,
        Buffer.from(metadataBytes),
        new Date().toISOString()
      );
    return {
      configurable: {
        thread_id: key.threadId,
        checkpoint_ns: key.checkpointNs,
        checkpoint_id: key.checkpointId
      }
    };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: Parameters<BaseCheckpointSaver['putWrites']>[1],
    taskId: string
  ): Promise<void> {
    const key = readCheckpointKeyForWrites(config);
    requireStorageKey(taskId, 'agent_checkpoint_task_id_missing');
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO langgraph_checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING`
    );
    const upsertSpecialWrite = this.db.prepare(
      `INSERT INTO langgraph_checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
         channel = excluded.channel,
         value_type = excluded.value_type,
         value_blob = excluded.value_blob,
         created_at = excluded.created_at`
    );
    const serializedWrites = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
        const mappedIndex = writesIndexByChannel.get(channel);
        return {
          channel,
          index: mappedIndex === undefined ? index : mappedIndex,
          special: mappedIndex !== undefined,
          valueType,
          valueBytes
        };
      })
    );
    this.db.transaction(() => {
      for (const write of serializedWrites) {
        const statement = write.special ? upsertSpecialWrite : insert;
        statement.run(
          key.threadId,
          key.checkpointNs,
          key.checkpointId,
          taskId,
          write.index,
          write.channel,
          write.valueType,
          Buffer.from(write.valueBytes),
          now
        );
      }
    })();
  }

  override async deleteThread(threadId: string): Promise<void> {
    requireStorageKey(threadId, 'agent_checkpoint_thread_id_missing');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id = ?').run(threadId);
    })();
  }

  private readLatestCheckpointId(threadId: string, checkpointNs: string): string | null {
    const row = this.db
      .prepare(
        `SELECT checkpoint_id
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC
         LIMIT 1`
      )
      .get(threadId, checkpointNs) as { checkpoint_id: string } | undefined;
    return row === undefined ? null : row.checkpoint_id;
  }

  private listRows(
    key: ReturnType<typeof readCheckpointKeyForList>,
    options: Parameters<BaseCheckpointSaver['list']>[1]
  ): CheckpointRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (key.threadId !== null) {
      clauses.push('thread_id = ?');
      params.push(key.threadId);
    }
    if (key.checkpointNs !== null) {
      clauses.push('checkpoint_ns = ?');
      params.push(key.checkpointNs);
    }
    if (key.checkpointId !== null) {
      clauses.push('checkpoint_id = ?');
      params.push(key.checkpointId);
    }
    if (options?.before?.configurable !== undefined && typeof options.before.configurable.checkpoint_id === 'string') {
      clauses.push('checkpoint_id < ?');
      params.push(options.before.configurable.checkpoint_id);
    }
    const whereClause = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const limitClause = options?.limit === undefined ? '' : 'LIMIT ?';
    if (options?.limit !== undefined) {
      params.push(options.limit);
    }
    return this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                checkpoint_type, checkpoint_blob, metadata_type, metadata_blob
         FROM langgraph_checkpoints
         ${whereClause}
         ORDER BY checkpoint_id DESC
         ${limitClause}`
      )
      .all(...params) as CheckpointRow[];
  }

  private async rowToTuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const pendingWrites = await this.readPendingWrites(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id
        }
      },
      checkpoint: await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint_blob),
      metadata: await this.serde.loadsTyped(row.metadata_type, row.metadata_blob),
      pendingWrites
    };
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id
        }
      };
    }
    return tuple;
  }

  private async readPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<NonNullable<CheckpointTuple['pendingWrites']>> {
    const rows = this.db
      .prepare(
        `SELECT task_id, channel, value_type, value_blob
         FROM langgraph_checkpoint_writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         ORDER BY task_id ASC, idx ASC`
      )
      .all(threadId, checkpointNs, checkpointId) as WriteRow[];
    const pendingWrites: NonNullable<CheckpointTuple['pendingWrites']> = [];
    for (const row of rows) {
      pendingWrites.push([row.task_id, row.channel, await this.serde.loadsTyped(row.value_type, row.value_blob)]);
    }
    return pendingWrites;
  }
}

export function applyRocSqliteCheckpointerSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint_type TEXT NOT NULL,
      checkpoint_blob BLOB NOT NULL,
      metadata_type TEXT NOT NULL,
      metadata_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread_checkpoint
      ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);

    CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      value_type TEXT NOT NULL,
      value_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );
  `);
}

function readCheckpointKeyForGet(config: RunnableConfig): {
  threadId: string | null;
  checkpointNs: string;
  checkpointId: string | null;
} {
  const configurable = config.configurable;
  if (configurable === undefined) {
    return { threadId: null, checkpointNs: '', checkpointId: null };
  }
  if (configurable.thread_id === undefined) {
    return { threadId: null, checkpointNs: '', checkpointId: null };
  }
  const threadId = requireStorageKey(configurable.thread_id, 'agent_checkpoint_thread_id_missing');
  const checkpointNs = readCheckpointNamespace(configurable.checkpoint_ns);
  const checkpointId =
    typeof configurable.checkpoint_id === 'string' && configurable.checkpoint_id.length > 0
      ? configurable.checkpoint_id
      : null;
  return {
    threadId,
    checkpointNs,
    checkpointId
  };
}

function readCheckpointKeyForList(config: RunnableConfig): {
  threadId: string | null;
  checkpointNs: string | null;
  checkpointId: string | null;
} {
  const configurable = config.configurable;
  if (configurable === undefined) {
    return { threadId: null, checkpointNs: null, checkpointId: null };
  }
  return {
    threadId:
      configurable.thread_id === undefined
        ? null
        : requireStorageKey(configurable.thread_id, 'agent_checkpoint_thread_id_missing'),
    checkpointNs: configurable.checkpoint_ns === undefined ? null : readCheckpointNamespace(configurable.checkpoint_ns),
    checkpointId:
      configurable.checkpoint_id === undefined
        ? null
        : requireStorageKey(configurable.checkpoint_id, 'agent_checkpoint_id_missing')
  };
}

function readCheckpointKeyForPut(config: RunnableConfig, checkpoint: Checkpoint): CheckpointKey {
  if (config.configurable === undefined) {
    throw new Error('agent_checkpoint_config_missing');
  }
  return {
    threadId: requireStorageKey(config.configurable.thread_id, 'agent_checkpoint_thread_id_missing'),
    checkpointNs: readCheckpointNamespace(config.configurable.checkpoint_ns),
    checkpointId: requireStorageKey(checkpoint.id, 'agent_checkpoint_id_missing')
  };
}

function readCheckpointKeyForWrites(config: RunnableConfig): CheckpointKey {
  if (config.configurable === undefined) {
    throw new Error('agent_checkpoint_config_missing');
  }
  return {
    threadId: requireStorageKey(config.configurable.thread_id, 'agent_checkpoint_thread_id_missing'),
    checkpointNs: readCheckpointNamespace(config.configurable.checkpoint_ns),
    checkpointId: requireStorageKey(config.configurable.checkpoint_id, 'agent_checkpoint_id_missing')
  };
}

function readCheckpointNamespace(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error('agent_checkpoint_namespace_invalid');
  }
  return value;
}

function requireStorageKey(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw new Error(code);
  }
  if (value.length === 0) {
    throw new Error(code);
  }
  if (value === '__proto__') {
    throw new Error('agent_checkpoint_storage_key_reserved');
  }
  if (value === 'constructor') {
    throw new Error('agent_checkpoint_storage_key_reserved');
  }
  if (value === 'prototype') {
    throw new Error('agent_checkpoint_storage_key_reserved');
  }
  return value;
}
