import { existsSync, mkdtempSync, readFileSync, rmSync, type PathLike, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunDatabaseFastProbe = typeof import(
  '../../../src/main/infrastructure/database-fast-probe'
).runDatabaseFastProbe;

const moduleMocks = vi.hoisted(() => ({
  actualRenameSync: undefined as ((oldPath: PathLike, newPath: PathLike) => void) | undefined,
  actualRunDatabaseFastProbe: undefined as RunDatabaseFastProbe | undefined,
  renameSync: vi.fn<(oldPath: PathLike, newPath: PathLike) => void>(),
  runDatabaseFastProbe: vi.fn<RunDatabaseFastProbe>()
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  moduleMocks.actualRenameSync = actual.renameSync;
  moduleMocks.renameSync.mockImplementation(actual.renameSync);
  return {
    ...actual,
    renameSync: moduleMocks.renameSync
  };
});

vi.mock('../../../src/main/infrastructure/database-fast-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/infrastructure/database-fast-probe')>();
  moduleMocks.actualRunDatabaseFastProbe = actual.runDatabaseFastProbe;
  moduleMocks.runDatabaseFastProbe.mockImplementation(actual.runDatabaseFastProbe);
  return {
    ...actual,
    runDatabaseFastProbe: moduleMocks.runDatabaseFastProbe
  };
});

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
  if (moduleMocks.actualRenameSync === undefined || moduleMocks.actualRunDatabaseFastProbe === undefined) {
    throw new Error('database_backup_test_mock_not_initialized');
  }
  moduleMocks.renameSync.mockReset();
  moduleMocks.renameSync.mockImplementation(moduleMocks.actualRenameSync);
  moduleMocks.runDatabaseFastProbe.mockReset();
  moduleMocks.runDatabaseFastProbe.mockImplementation(moduleMocks.actualRunDatabaseFastProbe);
});

afterEach(() => {
  pool.closeAll();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(backupRoot, { recursive: true, force: true });
});

describe('database backup and restore', () => {
  it('backs up committed WAL data through SQLite backup with hashes, sizes, and an atomic manifest', async () => {
    applyAllSchemas(pool);
    pool
      .getCoreConnection()
      .prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('@roc/plugin-agent', 'enabled', 'true', '2026-07-06T00:00:00.000Z');
    const agentDb = pool.getConnection('@roc/plugin-agent');
    agentDb.pragma('wal_autocheckpoint = 0');
    agentDb
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'thread_backup_1',
        'chat',
        'WAL committed',
        'Backup',
        'running',
        '2026-07-06T00:00:00.000Z',
        '2026-07-06T00:00:00.000Z'
      );

    const manifest = await backupRocDatabases({
      pool,
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'manual-20260706',
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(manifest.id).toBe('manual-20260706');
    expect(manifest.status).toBe('complete');
    expect(manifest.databases).toHaveLength(6);
    expect(existsSync(join(manifest.backupDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, 'manifest.tmp'))).toBe(false);
    expect(existsSync(join(manifest.backupDir, 'core.db'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, '@roc-plugin-workspace.db'))).toBe(true);
    expect(existsSync(join(manifest.backupDir, '@roc-plugin-diagnostics.db'))).toBe(true);
    expect(manifest.databases.every((item) => item.sha256.length === 64)).toBe(true);
    expect(manifest.databases.every((item) => item.sizeBytes > 0)).toBe(true);
    const backedUpAgent = new Database(join(manifest.backupDir, '@roc-plugin-agent.db'), { readonly: true });
    try {
      expect(backedUpAgent.prepare('SELECT title FROM agent_threads WHERE id = ?').pluck().get('thread_backup_1')).toBe(
        'WAL committed'
      );
    } finally {
      backedUpAgent.close();
    }

    pool.closeAll();
    const currentCore = new Database(join(root, 'data', 'core.db'));
    try {
      currentCore.prepare('UPDATE plugin_config SET value_json = ? WHERE key = ?').run('after-backup', 'enabled');
    } finally {
      currentCore.close();
    }

    const restoreResult = await restoreRocDatabaseBackup({
      rootDir: root,
      backupDir: manifest.backupDir,
      generationId: 'restore-success',
      now: () => '2026-07-10T00:00:00.000Z'
    });

    expect(restoreResult.restored).toBe(true);
    expect(restoreResult.rollbackDataDir).toBe(join(root, 'data.rollback-restore-success'));
    expect(existsSync(join(root, 'data.rollback-restore-success'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'restore-receipt.json'), 'utf8'))).toEqual({
      backupId: 'manual-20260706',
      restoredAt: '2026-07-10T00:00:00.000Z',
      rollbackDataDir: join(root, 'data.rollback-restore-success'),
      currentDataDir: join(root, 'data')
    });
    const restoredCore = new Database(join(root, 'data', 'core.db'), { readonly: true });
    const restoredAgent = new Database(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'), { readonly: true });
    try {
      expect(restoredCore.prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('enabled')).toBe('true');
      expect(restoredAgent.prepare('SELECT title FROM agent_threads WHERE id = ?').pluck().get('thread_backup_1')).toBe('WAL committed');
    } finally {
      restoredCore.close();
      restoredAgent.close();
    }
    const rollbackCore = new Database(join(root, 'data.rollback-restore-success', 'core.db'), { readonly: true });
    try {
      expect(rollbackCore.prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('enabled')).toBe(
        'after-backup'
      );
    } finally {
      rollbackCore.close();
    }
  });

  it('rejects restore when a backup file hash does not match the manifest', async () => {
    applyAllSchemas(pool);
    const manifest = await backupRocDatabases({
      pool,
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'manual-corrupt',
      now: () => '2026-07-06T00:00:00.000Z'
    });
    pool.closeAll();
    const taskBackupPath = join(manifest.backupDir, '@roc-plugin-task.db');
    const corrupted = readFileSync(taskBackupPath);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    writeFileSync(taskBackupPath, corrupted);

    await expect(
      restoreRocDatabaseBackup({
        rootDir: root,
        backupDir: manifest.backupDir,
        generationId: 'restore-corrupt',
        now: () => '2026-07-10T00:00:00.000Z'
      })
    ).rejects.toThrow('database_backup_hash_mismatch');
  });

  it('writes only a failure artifact when a SQLite backup fails', async () => {
    applyAllSchemas(pool);
    pool
      .getCoreConnection()
      .prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('@roc/plugin-agent', 'backup-failure', 'preserved', '2026-07-10T00:00:00.000Z');
    vi.spyOn(pool.getConnection('@roc/plugin-memory'), 'backup').mockRejectedValueOnce(
      new Error('backup_third_database_injected')
    );

    await expect(
      backupRocDatabases({
        pool,
        rootDir: root,
        backupRootDir: backupRoot,
        backupId: 'manual-failure',
        now: () => '2026-07-10T00:00:00.000Z'
      })
    ).rejects.toThrow('backup_third_database_injected');

    const backupDir = join(backupRoot, 'manual-failure');
    expect(existsSync(join(backupDir, 'manifest.json'))).toBe(false);
    expect(existsSync(join(backupDir, 'manifest.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(backupDir, 'failure.json'), 'utf8'))).toEqual({
      id: 'manual-failure',
      failedAt: '2026-07-10T00:00:00.000Z',
      error: 'backup_third_database_injected'
    });
    expect(pool.getCoreConnection().prepare('SELECT COUNT(*) FROM database_backup_manifests').pluck().get()).toBe(0);
    expect(
      pool.getCoreConnection().prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('backup-failure')
    ).toBe('preserved');
  });

  it('restores the original current data and keeps failed staging when the final probe fails', async () => {
    applyAllSchemas(pool);
    pool
      .getCoreConnection()
      .prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('@roc/plugin-agent', 'restore-marker', 'backup-value', '2026-07-10T00:00:00.000Z');
    const manifest = await backupRocDatabases({
      pool,
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'restore-final-probe',
      now: () => '2026-07-10T00:00:00.000Z'
    });
    pool.closeAll();
    const currentCore = new Database(join(root, 'data', 'core.db'));
    try {
      currentCore.prepare('UPDATE plugin_config SET value_json = ? WHERE key = ?').run('current-before-restore', 'restore-marker');
    } finally {
      currentCore.close();
    }
    moduleMocks.runDatabaseFastProbe.mockReturnValueOnce({
      status: 'unhealthy',
      checkedAt: '2026-07-10T00:00:00.000Z',
      databases: []
    });

    await expect(
      restoreRocDatabaseBackup({
        rootDir: root,
        backupDir: manifest.backupDir,
        generationId: 'restore-final-fail',
        now: () => '2026-07-10T00:00:00.000Z'
      })
    ).rejects.toThrow('database_restore_final_probe_failed');

    const restoredCurrent = new Database(join(root, 'data', 'core.db'), { readonly: true });
    try {
      expect(restoredCurrent.prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('restore-marker')).toBe(
        'current-before-restore'
      );
    } finally {
      restoredCurrent.close();
    }
    expect(existsSync(join(root, 'data.rollback-restore-final-fail'))).toBe(false);
    expect(existsSync(join(root, '.restore-restore-final-fail.staging', 'data.failed'))).toBe(true);
  });

  it('restores the original current data when the staging directory switch fails', async () => {
    applyAllSchemas(pool);
    pool
      .getCoreConnection()
      .prepare('INSERT INTO plugin_config (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('@roc/plugin-agent', 'switch-marker', 'current-value', '2026-07-10T00:00:00.000Z');
    const manifest = await backupRocDatabases({
      pool,
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'restore-switch-failure',
      now: () => '2026-07-10T00:00:00.000Z'
    });
    pool.closeAll();
    const actualRenameSync = moduleMocks.actualRenameSync;
    if (actualRenameSync === undefined) {
      throw new Error('database_backup_test_mock_not_initialized');
    }
    let renameCallCount = 0;
    moduleMocks.renameSync.mockImplementation((oldPath, newPath) => {
      renameCallCount += 1;
      if (renameCallCount === 2) {
        throw new Error('restore_switch_injected');
      }
      actualRenameSync(oldPath, newPath);
    });

    await expect(
      restoreRocDatabaseBackup({
        rootDir: root,
        backupDir: manifest.backupDir,
        generationId: 'restore-switch-fail',
        now: () => '2026-07-10T00:00:00.000Z'
      })
    ).rejects.toThrow('restore_switch_injected');

    const restoredCurrent = new Database(join(root, 'data', 'core.db'), { readonly: true });
    try {
      expect(restoredCurrent.prepare('SELECT value_json FROM plugin_config WHERE key = ?').pluck().get('switch-marker')).toBe(
        'current-value'
      );
    } finally {
      restoredCurrent.close();
    }
    expect(existsSync(join(root, 'data.rollback-restore-switch-fail'))).toBe(false);
  });

  it('rejects a manifest whose recorded backup directory differs from the requested directory', async () => {
    applyAllSchemas(pool);
    const manifest = await backupRocDatabases({
      pool,
      rootDir: root,
      backupRootDir: backupRoot,
      backupId: 'restore-path-boundary',
      now: () => '2026-07-10T00:00:00.000Z'
    });
    const manifestPath = join(manifest.backupDir, 'manifest.json');
    const tampered = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    tampered.backupDir = join(backupRoot, 'outside');
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    await expect(
      restoreRocDatabaseBackup({
        rootDir: root,
        backupDir: manifest.backupDir,
        generationId: 'restore-path-fail',
        now: () => '2026-07-10T00:00:00.000Z'
      })
    ).rejects.toThrow('database_backup_manifest_path_mismatch');
    expect(existsSync(join(root, '.restore-restore-path-fail.staging'))).toBe(false);
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
