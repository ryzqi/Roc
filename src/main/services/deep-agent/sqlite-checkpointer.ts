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

type StoredCheckpointRow = CheckpointRow & {
  created_at: string;
};

type StoredWriteRow = WriteRow & {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  idx: number;
  created_at: string;
};

type CheckpointDeleteResult = {
  checkpoints: number;
  checkpointWrites: number;
};

export type RocCheckpointInterrupt = {
  interruptId: string;
  payload: unknown;
};

type CheckpointKey = {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
};

type CheckpointMetadataRow = Pick<
  CheckpointRow,
  'thread_id' | 'checkpoint_ns' | 'checkpoint_id' | 'metadata_type' | 'metadata_blob'
>;

type CheckpointListCursor = {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
};

const filteredListPageSize = 64;

const writesIndexByChannel = new Map<string, number>([
  ['__error__', -1],
  ['__scheduled__', -2],
  ['__interrupt__', -3],
  ['__resume__', -4]
]);

export class RocSqliteCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly db: DatabaseConnection) {
    super();
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
    return await this.rowToTuple(row, await this.readMetadata(row));
  }

  override async *list(
    config: RunnableConfig,
    options?: Parameters<BaseCheckpointSaver['list']>[1]
  ): AsyncGenerator<CheckpointTuple> {
    const key = readCheckpointKeyForList(config);
    let remaining = options?.limit;
    if (remaining !== undefined && remaining <= 0) {
      return;
    }
    if (options?.filter !== undefined) {
      yield* this.listFiltered(key, options, options.filter);
      return;
    }
    const rows = this.listRows(key, options);
    for (const row of rows) {
      yield await this.rowToTuple(row, await this.readMetadata(row));
      if (remaining !== undefined) {
        remaining -= 1;
        if (remaining <= 0) {
          return;
        }
      }
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
    this.deleteThreadCheckpoints(threadId);
  }

  deleteThreadCheckpoints(threadId: string): CheckpointDeleteResult {
    requireStorageKey(threadId, 'agent_checkpoint_thread_id_missing');
    return this.db.transaction(() => {
      const checkpointWrites = this.db.prepare('DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?').run(threadId)
        .changes;
      const checkpoints = this.db.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id = ?').run(threadId).changes;
      return { checkpoints, checkpointWrites };
    })();
  }

  deleteExcessCheckpoints(input: {
    protectedThreadIds: readonly string[];
    maxCheckpointsPerThread: number;
  }): CheckpointDeleteResult {
    if (input.maxCheckpointsPerThread < 1) {
      throw new Error('agent_checkpoint_retention_limit_invalid');
    }
    return this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS temp.checkpoint_retention_protected_threads;
        CREATE TEMP TABLE checkpoint_retention_protected_threads (
          thread_id TEXT PRIMARY KEY
        );
      `);
      try {
        const insertProtectedThread = this.db.prepare(
          'INSERT INTO checkpoint_retention_protected_threads (thread_id) VALUES (?)'
        );
        for (const threadId of input.protectedThreadIds) {
          insertProtectedThread.run(threadId);
        }
        const rows = this.db
          .prepare(
            `SELECT thread_id, checkpoint_ns, checkpoint_id
             FROM (
               SELECT thread_id,
                      checkpoint_ns,
                      checkpoint_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY thread_id
                        ORDER BY created_at DESC, checkpoint_id DESC
                      ) AS checkpoint_rank
               FROM langgraph_checkpoints
               WHERE thread_id NOT IN (SELECT thread_id FROM checkpoint_retention_protected_threads)
             )
             WHERE checkpoint_rank > ?`
          )
          .all(input.maxCheckpointsPerThread) as Array<
          Pick<StoredCheckpointRow, 'thread_id' | 'checkpoint_ns' | 'checkpoint_id'>
        >;
        const deleteWrites = this.db.prepare(
          `DELETE FROM langgraph_checkpoint_writes
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        );
        const deleteCheckpoint = this.db.prepare(
          `DELETE FROM langgraph_checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        );
        let checkpoints = 0;
        let checkpointWrites = 0;
        for (const row of rows) {
          checkpointWrites += deleteWrites.run(row.thread_id, row.checkpoint_ns, row.checkpoint_id).changes;
          checkpoints += deleteCheckpoint.run(row.thread_id, row.checkpoint_ns, row.checkpoint_id).changes;
        }
        return { checkpoints, checkpointWrites };
      } finally {
        this.db.exec('DROP TABLE IF EXISTS temp.checkpoint_retention_protected_threads;');
      }
    })();
  }

  restoreFrom(source: DatabaseConnection | null): void {
    if (source === null) {
      return;
    }
    const checkpoints = readSourceRows<StoredCheckpointRow>(
      source,
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type,
         checkpoint_blob, metadata_type, metadata_blob, created_at
       FROM langgraph_checkpoints`
    );
    const writes = readSourceRows<StoredWriteRow>(
      source,
      `SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at
       FROM langgraph_checkpoint_writes`
    );
    const insertCheckpoint = this.db.prepare(
      `INSERT INTO langgraph_checkpoints (
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type,
        checkpoint_blob, metadata_type, metadata_blob, created_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertWrite = this.db.prepare(
      `INSERT INTO langgraph_checkpoint_writes (
        thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of checkpoints) {
      try {
        insertCheckpoint.run(
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          row.parent_checkpoint_id,
          row.checkpoint_type,
          row.checkpoint_blob,
          row.metadata_type,
          row.metadata_blob,
          row.created_at
        );
      } catch {
        continue;
      }
    }
    for (const row of writes) {
      try {
        insertWrite.run(
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          row.task_id,
          row.idx,
          row.channel,
          row.value_type,
          row.value_blob,
          row.created_at
        );
      } catch {
        continue;
      }
    }
  }

  readPendingInterrupts(threadId: string): RocCheckpointInterrupt[] | null {
    const rows = this.db
      .prepare(
        `SELECT value_type, value_blob
         FROM langgraph_checkpoint_writes
         WHERE thread_id = ?
           AND checkpoint_ns = ''
           AND checkpoint_id = (
             SELECT checkpoint_id
             FROM langgraph_checkpoints
             WHERE thread_id = ? AND checkpoint_ns = ''
             ORDER BY checkpoint_id DESC
             LIMIT 1
           )
           AND channel = '__interrupt__'
         ORDER BY rowid ASC`
      )
      .all(threadId, threadId) as Array<Pick<WriteRow, 'value_type' | 'value_blob'>>;
    if (rows.length === 0 || rows.some((row) => row.value_type !== 'json')) {
      return null;
    }
    try {
      const values = rows.flatMap((row) => {
        const value = JSON.parse(row.value_blob.toString('utf8')) as unknown;
        return Array.isArray(value) ? value : [value];
      });
      return values.map((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('agent_checkpoint_interrupt_invalid');
        }
        const interruptId = Reflect.get(value, 'id');
        if (typeof interruptId !== 'string' || interruptId.trim().length === 0) {
          throw new Error('agent_checkpoint_interrupt_id_invalid');
        }
        return {
          interruptId,
          payload: Reflect.get(value, 'value')
        };
      });
    } catch {
      return null;
    }
  }

  hasCheckpoint(threadId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM langgraph_checkpoints WHERE thread_id = ? LIMIT 1')
      .get(threadId) as { 1: number } | undefined;
    return row !== undefined;
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

  private async *listFiltered(
    key: ReturnType<typeof readCheckpointKeyForList>,
    options: NonNullable<Parameters<BaseCheckpointSaver['list']>[1]>,
    filter: Record<string, unknown>
  ): AsyncGenerator<CheckpointTuple> {
    let cursor: CheckpointListCursor | undefined;
    let remaining = options.limit;
    while (true) {
      const rows = this.listMetadataPage(key, options, cursor);
      for (const row of rows) {
        const metadata = await this.readMetadata(row);
        if (!matchesMetadataFilter(metadata, filter)) {
          continue;
        }
        const checkpointRow = this.readCheckpointRow(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
        if (checkpointRow === undefined) {
          continue;
        }
        yield await this.rowToTuple(checkpointRow, metadata);
        if (remaining !== undefined) {
          remaining -= 1;
          if (remaining <= 0) {
            return;
          }
        }
      }
      if (rows.length < filteredListPageSize) {
        return;
      }
      const lastRow = rows[rows.length - 1];
      if (lastRow === undefined) {
        return;
      }
      cursor = {
        checkpointId: lastRow.checkpoint_id,
        checkpointNs: lastRow.checkpoint_ns,
        threadId: lastRow.thread_id
      };
    }
  }

  private listMetadataPage(
    key: ReturnType<typeof readCheckpointKeyForList>,
    options: Parameters<BaseCheckpointSaver['list']>[1],
    cursor: CheckpointListCursor | undefined
  ): CheckpointMetadataRow[] {
    const { clauses, params } = createListPredicate(key, options);
    if (cursor !== undefined) {
      clauses.push(
        `(checkpoint_id < ?
          OR (checkpoint_id = ? AND thread_id > ?)
          OR (checkpoint_id = ? AND thread_id = ? AND checkpoint_ns > ?))`
      );
      params.push(
        cursor.checkpointId,
        cursor.checkpointId,
        cursor.threadId,
        cursor.checkpointId,
        cursor.threadId,
        cursor.checkpointNs
      );
    }
    const whereClause = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    params.push(filteredListPageSize);
    return this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, metadata_type, metadata_blob
         FROM langgraph_checkpoints
         ${whereClause}
         ORDER BY checkpoint_id DESC, thread_id ASC, checkpoint_ns ASC
         LIMIT ?`
      )
      .all(...params) as CheckpointMetadataRow[];
  }

  private listRows(
    key: ReturnType<typeof readCheckpointKeyForList>,
    options: Parameters<BaseCheckpointSaver['list']>[1]
  ): CheckpointRow[] {
    const { clauses, params } = createListPredicate(key, options);
    const whereClause = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const sqlLimit = options?.limit;
    const limitClause = sqlLimit === undefined ? '' : 'LIMIT ?';
    if (sqlLimit !== undefined) {
      params.push(sqlLimit);
    }
    return this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                checkpoint_type, checkpoint_blob, metadata_type, metadata_blob
         FROM langgraph_checkpoints
         ${whereClause}
         ORDER BY checkpoint_id DESC, thread_id ASC, checkpoint_ns ASC
         ${limitClause}`
      )
      .all(...params) as CheckpointRow[];
  }

  private readCheckpointRow(threadId: string, checkpointNs: string, checkpointId: string): CheckpointRow | undefined {
    return this.db
      .prepare(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                checkpoint_type, checkpoint_blob, metadata_type, metadata_blob
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .get(threadId, checkpointNs, checkpointId) as CheckpointRow | undefined;
  }

  private async readMetadata(row: CheckpointMetadataRow): Promise<CheckpointMetadata> {
    return await this.serde.loadsTyped(row.metadata_type, row.metadata_blob);
  }

  private async rowToTuple(row: CheckpointRow, metadata: CheckpointMetadata): Promise<CheckpointTuple> {
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
      metadata,
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
         ORDER BY rowid ASC`
      )
      .all(threadId, checkpointNs, checkpointId) as WriteRow[];
    const pendingWrites: NonNullable<CheckpointTuple['pendingWrites']> = [];
    for (const row of rows) {
      pendingWrites.push([row.task_id, row.channel, await this.serde.loadsTyped(row.value_type, row.value_blob)]);
    }
    return pendingWrites;
  }
}

function createListPredicate(
  key: ReturnType<typeof readCheckpointKeyForList>,
  options: Parameters<BaseCheckpointSaver['list']>[1]
): { clauses: string[]; params: unknown[] } {
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
  return { clauses, params };
}

function matchesMetadataFilter(metadata: CheckpointMetadata | undefined, filter: Record<string, unknown>): boolean {
  if (metadata === undefined) {
    return false;
  }
  return Object.entries(filter).every(([key, value]) => Reflect.get(metadata, key) === value);
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

function readSourceRows<TRow>(source: DatabaseConnection, sql: string): TRow[] {
  try {
    return source.prepare(sql).all() as TRow[];
  } catch {
    return [];
  }
}
