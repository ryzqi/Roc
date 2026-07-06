import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupRocDatabases, restoreRocDatabaseBackup } from '../../../src/main/infrastructure/database-backup';
import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';

let root: string;
let backupRoot: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-backup-test-'));
  backupRoot = mkdtempSync(join(tmpdir(), 'roc-database-backup-store-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
  rmSync(backupRoot, { recursive: true, force: true });
});

describe('database backup and restore', () => {
  it('backs up every managed database with hashes and restores the files into the data directory', () => {
    applyAllSchemas(pool);
    pool
      .getCoreConnection()
      .prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('@roc/plugin-agent', 'enabled', 'true', '2026-07-06T00:00:00.000Z');
    pool
      .getConnection('@roc/plugin-agent')
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('thread_backup_1', 'chat', 'Backup', 'Backup', 'running', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z');
    pool.closeAll();

    const manifest = backupRocDatabases({
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'manual-20260706',
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(manifest.id).toBe('manual-20260706');
    expect(manifest.databases).toHaveLength(6);
    expect(existsSync(join(manifest.backupDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, 'core.db'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, '@roc-plugin-workspace.db'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, '@roc-plugin-diagnostics.db'))).toBe(true);
    expect(manifest.databases.every((item) => item.sha256.length === 64)).toBe(true);

    rmSync(join(root, 'data'), { recursive: true, force: true });

    const restoreResult = restoreRocDatabaseBackup({
      rootDir: root,
      backupDir: manifest.backupDir
    });

    expect(restoreResult.restored).toBe(true);
    const restoredCore = new Database(join(root, 'data', 'core.db'), { readonly: true });
    const restoredAgent = new Database(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'), { readonly: true });
    try {
      expect(restoredCore.prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('enabled')).toBe('true');
      expect(restoredAgent.prepare('SELECT title FROM agent_threads WHERE id = ?').pluck().get('thread_backup_1')).toBe(
        'Backup'
      );
    } finally {
      restoredCore.close();
      restoredAgent.close();
    }
  });

  it('rejects restore when a backup file hash does not match the manifest', () => {
    applyAllSchemas(pool);
    pool.closeAll();
    const manifest = backupRocDatabases({
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'manual-corrupt',
      now: () => '2026-07-06T00:00:00.000Z'
    });
    writeFileSync(join(manifest.backupDir, '@roc-plugin-task.db'), 'corrupt', 'utf8');

    expect(() =>
      restoreRocDatabaseBackup({
        rootDir: root,
        backupDir: manifest.backupDir
      })
    ).toThrow('database_backup_hash_mismatch');
  });
});

function applyAllSchemas(targetPool: DatabasePool): void {
  const now = () => '2026-07-06T00:00:00.000Z';
  applyCoreDatabaseSchema(targetPool.getCoreConnection(), now);
  applyAgentDatabaseSchema(targetPool.getConnection('@roc/plugin-agent'), now);
  applyMemoryDatabaseSchema(targetPool.getConnection('@roc/plugin-memory'), now);
  applyTaskDatabaseSchema(targetPool.getConnection('@roc/plugin-task'), now);
  applyWorkspaceDatabaseSchema(targetPool.getConnection('@roc/plugin-workspace'), now);
  applyDiagnosticsDatabaseSchema(targetPool.getConnection('@roc/plugin-diagnostics'), now);
}
