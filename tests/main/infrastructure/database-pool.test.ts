import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';

let root: string;
let pools: DatabasePool[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-pool-test-'));
  pools = [];
});

afterEach(() => {
  for (const pool of pools) {
    pool.closeAll();
  }
  rmSync(root, { recursive: true, force: true });
});

function createPool(): DatabasePool {
  const pool = new DatabasePool(root);
  pools.push(pool);
  return pool;
}

describe('DatabasePool', () => {
  it('opens one WAL and foreign-key-enabled database per plugin id path', () => {
    const pool = createPool();

    const agentDb = pool.getConnection('@roc/plugin-agent');
    const taskDb = pool.getConnection('@roc/plugin-task');

    agentDb.prepare('CREATE TABLE parent (id TEXT PRIMARY KEY)').run();
    agentDb.prepare('CREATE TABLE child (parent_id TEXT NOT NULL REFERENCES parent(id))').run();

    expect(() => taskDb.prepare('SELECT * FROM parent').all()).toThrow();
    expect(agentDb.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(agentDb.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(String(agentDb.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(existsSync(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'))).toBe(true);
    expect(existsSync(join(root, 'data', 'plugins', '@roc', 'plugin-task.db'))).toBe(true);
    expect(dirname(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'))).toBe(join(root, 'data', 'plugins', '@roc'));
    expect(pool.getDatabasePath('core')).toBe(join(root, 'data', 'core.db'));
    expect(pool.getDatabasePath('agent')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'));
    expect(pool.getDatabasePath('memory')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-memory.db'));
    expect(pool.getDatabasePath('task')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-task.db'));
  });

  it('rejects invalid plugin ids without sanitizing them into filenames', () => {
    const pool = createPool();

    expect(() => pool.getConnection('@roc/plugin-agent/../../core')).toThrow(/invalid_plugin_id/u);
    expect(() => pool.getConnection('plugin-agent')).toThrow(/invalid_plugin_id/u);
    expect(() => pool.getDatabasePath('plugin:@roc/plugin-agent/../../core')).toThrow(/invalid_plugin_id/u);
    expect(existsSync(join(root, 'data', 'plugins', 'core.db'))).toBe(false);
  });

  it('creates plugin-scoped database facades with no arbitrary plugin id parameter', () => {
    const pool = createPool();
    const facade = pool.createPluginDatabaseFacade('@roc/plugin-agent');

    facade.getConnection().prepare('CREATE TABLE scoped (id TEXT PRIMARY KEY)').run();
    facade.getCoreConnection().prepare('CREATE TABLE shared (id TEXT PRIMARY KEY)').run();

    expect(facade.getConnection.length).toBe(0);
    expect(facade.getCoreConnection.length).toBe(0);
    expect(() => pool.getConnection('@roc/plugin-task').prepare('SELECT * FROM scoped').all()).toThrow();
    expect(pool.getCoreConnection().prepare('SELECT name FROM sqlite_master WHERE name = ?').pluck().get('shared')).toBe(
      'shared'
    );
  });

  it('closes every open connection', () => {
    const pool = createPool();
    const agentDb = pool.getConnection('@roc/plugin-agent');
    const taskDb = pool.getConnection('@roc/plugin-task');

    pool.closeAll();

    expect(() => agentDb.prepare('SELECT 1').get()).toThrow();
    expect(() => taskDb.prepare('SELECT 1').get()).toThrow();
  });
});
