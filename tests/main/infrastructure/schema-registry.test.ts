import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { SchemaRegistry } from '../../../src/main/infrastructure/schema-registry';

let root: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-schema-registry-test-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});

function schemaVersion(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

describe('SchemaRegistry', () => {
  it('applies schema to the target plugin database and records the schema version in core.db', () => {
    const registry = new SchemaRegistry(pool);
    const sql = `
      CREATE TABLE agent_items (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `;

    registry.apply('@roc/plugin-agent', sql);

    const agentDb = pool.getConnection('@roc/plugin-agent');
    agentDb.prepare('INSERT INTO agent_items (id, body) VALUES (?, ?)').run('item_1', 'hello');
    expect(agentDb.prepare('SELECT body FROM agent_items WHERE id = ?').pluck().get('item_1')).toBe('hello');
    expect(() => pool.getConnection('@roc/plugin-task').prepare('SELECT * FROM agent_items').all()).toThrow();

    const row = pool.getCoreConnection().prepare('SELECT plugin_id, version, applied_at FROM plugin_schema_versions').get() as {
      plugin_id: string;
      version: string;
      applied_at: string;
    };
    expect(row).toEqual({
      plugin_id: '@roc/plugin-agent',
      version: schemaVersion(sql),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
    });
  });
});
