import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { backupRocDatabases, restoreRocDatabaseBackup } from './database-backup';
import { runDatabaseFastProbe } from './database-fast-probe';
import { acquireDatabaseMaintenanceLease } from './database-maintenance-lease';
import { DatabasePool } from './database-pool';

type DatabaseMaintenanceCliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

type BackupCommand = {
  kind: 'backup';
  dataRoot: string;
  backupRoot: string;
  id: string;
};

type RestoreCommand = {
  kind: 'restore';
  dataRoot: string;
  backupDir: string;
};

type DatabaseMaintenanceCommand = BackupCommand | RestoreCommand;

export async function runDatabaseMaintenanceCli(
  args: readonly string[],
  io: DatabaseMaintenanceCliIo
): Promise<number> {
  try {
    const command = parseCommand(args);
    if (command.kind === 'backup') {
      const result = await runBackupCommand(command);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    const result = await runRestoreCommand(command);
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : 'database_maintenance_cli_failed');
    return 1;
  }
}

async function runBackupCommand(command: BackupCommand): Promise<Awaited<ReturnType<typeof backupRocDatabases>>> {
  const rootDir = join(command.dataRoot, 'plugin-data');
  const lease = acquireDatabaseMaintenanceLease({
    rootDir,
    owner: { kind: 'cli', pid: process.pid }
  });
  const pool = new DatabasePool(rootDir);
  try {
    const fastProbe = runDatabaseFastProbe({
      pool,
      now: () => new Date().toISOString()
    });
    if (fastProbe.status !== 'healthy') {
      throw new Error('database_fast_probe_unhealthy');
    }
    return await backupRocDatabases({
      pool,
      rootDir,
      backupRootDir: command.backupRoot,
      backupId: command.id,
      now: () => new Date().toISOString()
    });
  } finally {
    pool.closeAll();
    lease.release();
  }
}

async function runRestoreCommand(command: RestoreCommand): Promise<Awaited<ReturnType<typeof restoreRocDatabaseBackup>>> {
  const rootDir = join(command.dataRoot, 'plugin-data');
  const lease = acquireDatabaseMaintenanceLease({
    rootDir,
    owner: { kind: 'cli', pid: process.pid }
  });
  try {
    return await restoreRocDatabaseBackup({
      rootDir,
      backupDir: command.backupDir,
      generationId: randomUUID(),
      now: () => new Date().toISOString()
    });
  } finally {
    lease.release();
  }
}

function parseCommand(args: readonly string[]): DatabaseMaintenanceCommand {
  const command = args[0];
  if (command === 'backup') {
    const flags = readFlags(args.slice(1), ['--data-root', '--backup-root', '--id']);
    return {
      kind: 'backup',
      dataRoot: resolvePath(flags.get('--data-root')),
      backupRoot: resolvePath(flags.get('--backup-root')),
      id: requireArgument(flags.get('--id'))
    };
  }
  if (command === 'restore') {
    const flags = readFlags(args.slice(1), ['--data-root', '--backup-dir']);
    return {
      kind: 'restore',
      dataRoot: resolvePath(flags.get('--data-root')),
      backupDir: resolvePath(flags.get('--backup-dir'))
    };
  }
  throw new Error('database_maintenance_cli_arguments_invalid');
}

function readFlags(args: readonly string[], expectedFlags: readonly string[]): Map<string, string> {
  if (args.length !== expectedFlags.length * 2) {
    throw new Error('database_maintenance_cli_arguments_invalid');
  }
  const expected = new Set(expectedFlags);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !expected.has(flag) ||
      values.has(flag) ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      throw new Error('database_maintenance_cli_arguments_invalid');
    }
    values.set(flag, value);
  }
  for (const flag of expectedFlags) {
    if (!values.has(flag)) {
      throw new Error('database_maintenance_cli_arguments_invalid');
    }
  }
  return values;
}

function resolvePath(value: string | undefined): string {
  const argument = requireArgument(value);
  const normalized = argument.replaceAll('\\', '/');
  if (normalized === '/workspace' || normalized.startsWith('/workspace/')) {
    throw new Error('database_maintenance_workspace_path_invalid');
  }
  return resolve(argument);
}

function requireArgument(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error('database_maintenance_cli_arguments_invalid');
  }
  return value;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runDatabaseMaintenanceCli(process.argv.slice(2), {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message)
  });
}
