import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const legacyMonolithDataFileNames = ['roc.sqlite', 'roc.sqlite-wal', 'roc.sqlite-shm'] as const;

export type LegacyMonolithDataCleanupResult = {
  deleted: string[];
  skippedDirectories: string[];
  skippedReason: 'migration_not_verified' | null;
};

export async function deleteLegacyMonolithData(root: string): Promise<LegacyMonolithDataCleanupResult> {
  const resolvedRoot = resolve(root);
  if (resolvedRoot !== root) {
    throw new Error('legacy_data_root_not_canonical');
  }

  const deleted: string[] = [];
  const skippedDirectories: string[] = [];
  if (!(await hasVerifiedMigrationCompletion(resolvedRoot))) {
    return { deleted, skippedDirectories, skippedReason: 'migration_not_verified' };
  }
  let entries: string[];
  try {
    entries = await readdir(resolvedRoot);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return { deleted, skippedDirectories, skippedReason: null };
    }
    throw error;
  }

  for (const entry of entries) {
    if (!isLegacyMonolithDataFileName(entry)) {
      continue;
    }
    const targetPath = resolve(resolvedRoot, entry);
    if (targetPath !== resolve(resolvedRoot, basename(targetPath))) {
      throw new Error('legacy_data_target_outside_root');
    }
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) {
      skippedDirectories.push(targetPath);
      continue;
    }
    await rm(targetPath, { force: true });
    deleted.push(targetPath);
  }

  return { deleted, skippedDirectories, skippedReason: null };
}

async function hasVerifiedMigrationCompletion(root: string): Promise<boolean> {
  const markerPath = join(root, 'plugin-data', '.migration-complete.json');
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const sourceDatabasePath = Reflect.get(parsed, 'sourceDatabasePath');
  const sourceChecksum = Reflect.get(parsed, 'sourceChecksum');
  const pluginDatabaseChecksums = Reflect.get(parsed, 'pluginDatabaseChecksums');
  const completedAt = Reflect.get(parsed, 'completedAt');
  if (sourceDatabasePath !== null && typeof sourceDatabasePath !== 'string') {
    return false;
  }
  if (sourceChecksum !== null && typeof sourceChecksum !== 'string') {
    return false;
  }
  return (
    pluginDatabaseChecksums !== null &&
    typeof pluginDatabaseChecksums === 'object' &&
    !Array.isArray(pluginDatabaseChecksums) &&
    Object.keys(pluginDatabaseChecksums).length > 0 &&
    typeof completedAt === 'string' &&
    completedAt.trim().length > 0
  );
}

function isLegacyMonolithDataFileName(value: string): boolean {
  return (
    legacyMonolithDataFileNames.includes(value as (typeof legacyMonolithDataFileNames)[number]) ||
    value.startsWith('roc.sqlite.phase1-backup-') ||
    value.startsWith('roc.sqlite.bak-')
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === code;
}
