import Database from 'better-sqlite3';
import type { Item } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMemoryDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import { RocSqliteStore } from '../../../src/main/services/memory/sqlite-store';

let db: Database.Database;
let store: RocSqliteStore;

beforeEach(() => {
  db = new Database(':memory:');
  applyMemoryDatabaseSchema(db);
  store = new RocSqliteStore(db);
});

afterEach(() => {
  db.close();
});

describe('RocSqliteStore', () => {
  it('does not create memory tables during construction', () => {
    const isolatedDb = new Database(':memory:');
    try {
      new RocSqliteStore(isolatedDb);

      expect(tableExists(isolatedDb, 'langgraph_store_items')).toBe(false);
    } finally {
      isolatedDb.close();
    }
  });

  it('puts and gets an item with timestamps', async () => {
    await store.put(['roc', 'memory', 'global'], '/USER.md', { content: '# User' });

    const item = await store.get(['roc', 'memory', 'global'], '/USER.md');

    expect(item).toMatchObject({
      key: '/USER.md',
      namespace: ['roc', 'memory', 'global'],
      value: { content: '# User' }
    });
    expect(item?.createdAt).toBeInstanceOf(Date);
    expect(item?.updatedAt).toBeInstanceOf(Date);
  });

  it('updates value while preserving createdAt', async () => {
    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'old' });
    const first = await store.get(['roc', 'memory', 'global'], '/MEMORY.md');

    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'new' });
    const second = await store.get(['roc', 'memory', 'global'], '/MEMORY.md');

    expect(second?.value).toEqual({ content: 'new' });
    expect(second?.createdAt.toISOString()).toBe(first?.createdAt.toISOString());
  });

  it('deletes items', async () => {
    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'notes' });

    await store.delete(['roc', 'memory', 'global'], '/MEMORY.md');

    expect(await store.get(['roc', 'memory', 'global'], '/MEMORY.md')).toBeNull();
  });

  it('searches by namespace prefix with limit and offset', async () => {
    await store.put(['roc', 'memory', 'global'], '/AGENTS.md', { content: 'global agents', scope: 'global' });
    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'global memory', scope: 'global' });
    await store.put(['roc', 'memory', 'workspaces', 'abc'], '/MEMORY.md', {
      content: 'workspace memory',
      scope: 'workspace'
    });

    const result = await store.search(['roc', 'memory'], { limit: 2, offset: 1 });

    expect(result.map((item) => [item.namespace, item.key, item.value.content])).toEqual([
      [['roc', 'memory', 'global'], '/MEMORY.md', 'global memory'],
      [['roc', 'memory', 'workspaces', 'abc'], '/MEMORY.md', 'workspace memory']
    ]);
  });

  it('filters search results by top-level value fields', async () => {
    await store.put(['roc', 'memory', 'global'], '/USER.md', { content: 'user', kind: 'user' });
    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'memory', kind: 'memory' });

    const result = await store.search(['roc', 'memory', 'global'], { filter: { kind: 'memory' } });

    expect(result.map((item) => item.key)).toEqual(['/MEMORY.md']);
  });

  it('batches put, get, search, and list namespaces in order', async () => {
    const result = await store.batch([
      { namespace: ['roc', 'memory', 'global'], key: '/USER.md', value: { content: 'user' } },
      { namespace: ['roc', 'memory', 'global'], key: '/USER.md' },
      { namespacePrefix: ['roc', 'memory'], limit: 10, offset: 0 },
      {
        matchConditions: [{ matchType: 'prefix', path: ['roc', 'memory'] }],
        maxDepth: 3,
        limit: 10,
        offset: 0
      }
    ]);

    expect(result[0]).toBeUndefined();
    const getResult = result[1] as Item | null;
    const searchResult = result[2] as Item[];
    const namespaceResult = result[3] as string[][];
    expect(getResult?.value).toEqual({ content: 'user' });
    expect(searchResult.map((item) => item.key)).toEqual(['/USER.md']);
    expect(namespaceResult).toEqual([['roc', 'memory', 'global']]);
  });

  it('lists unique namespaces with prefix and maxDepth', async () => {
    await store.put(['roc', 'memory', 'global'], '/USER.md', { content: 'user' });
    await store.put(['roc', 'memory', 'global'], '/MEMORY.md', { content: 'memory' });
    await store.put(['roc', 'memory', 'workspaces', 'abc'], '/MEMORY.md', { content: 'workspace' });

    const result = await store.listNamespaces({ prefix: ['roc', 'memory'], maxDepth: 3 });

    expect(result).toEqual([['roc', 'memory', 'global'], ['roc', 'memory', 'workspaces']]);
  });

  it('rejects invalid namespaces and keys explicitly', async () => {
    await expect(store.put(['roc', ''], '/USER.md', { content: 'user' })).rejects.toThrow('invalid_store_namespace');
    await expect(store.get(['roc', 'memory'], '')).rejects.toThrow('invalid_store_key');
  });
});

function tableExists(connection: Database.Database, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}
