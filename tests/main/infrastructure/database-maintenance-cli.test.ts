import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDatabaseMaintenanceCli } from '../../../src/main/infrastructure/database-maintenance-cli';
import { acquireDatabaseMaintenanceLease } from '../../../src/main/infrastructure/database-maintenance-lease';

let dataRoot: string;
let backupRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'roc-database-maintenance-cli-data-'));
  backupRoot = mkdtempSync(join(tmpdir(), 'roc-database-maintenance-cli-backup-'));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(backupRoot, { recursive: true, force: true });
});

describe('runDatabaseMaintenanceCli', () => {
  it('rejects missing, duplicate, unknown, and workspace-routed arguments with exact errors', async () => {
    await expect(runCli(['backup'])).resolves.toMatchObject({
      exitCode: 1,
      stderr: ['database_maintenance_cli_arguments_invalid']
    });
    await expect(
      runCli([
        'backup',
        '--data-root',
        dataRoot,
        '--backup-root',
        backupRoot,
        '--id',
        'one',
        '--id',
        'two'
      ])
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: ['database_maintenance_cli_arguments_invalid']
    });
    await expect(
      runCli(['backup', '--data-root', dataRoot, '--backup-root', backupRoot, '--id', 'one', '--extra', 'value'])
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: ['database_maintenance_cli_arguments_invalid']
    });
    await expect(
      runCli(['backup', '--data-root', '/workspace/project', '--backup-root', backupRoot, '--id', 'one'])
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: ['database_maintenance_workspace_path_invalid']
    });
  });

  it('fails while the app maintenance lease is held', async () => {
    const lease = acquireDatabaseMaintenanceLease({
      rootDir: join(dataRoot, 'plugin-data'),
      owner: { kind: 'app', pid: process.pid }
    });
    try {
      await expect(
        runCli(['backup', '--data-root', dataRoot, '--backup-root', backupRoot, '--id', 'locked'])
      ).resolves.toMatchObject({
        exitCode: 1,
        stderr: ['database_maintenance_locked']
      });
    } finally {
      lease.release();
    }
  });

  it('runs backup and restore offline with a receipt and retained rollback generation', async () => {
    const backup = await runCli([
      'backup',
      '--data-root',
      dataRoot,
      '--backup-root',
      backupRoot,
      '--id',
      'cli-smoke'
    ]);

    expect(backup.exitCode).toBe(0);
    expect(backup.stderr).toEqual([]);
    expect(existsSync(join(backupRoot, 'cli-smoke', 'manifest.json'))).toBe(true);

    const restore = await runCli([
      'restore',
      '--data-root',
      dataRoot,
      '--backup-dir',
      join(backupRoot, 'cli-smoke')
    ]);

    expect(restore.exitCode).toBe(0);
    expect(restore.stderr).toEqual([]);
    expect(existsSync(join(dataRoot, 'plugin-data', 'restore-receipt.json'))).toBe(true);
    expect(
      readdirSync(join(dataRoot, 'plugin-data')).filter((entry) => entry.startsWith('data.rollback-'))
    ).toHaveLength(1);
  });
});

async function runCli(args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runDatabaseMaintenanceCli(args, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  });
  return { exitCode, stdout, stderr };
}
