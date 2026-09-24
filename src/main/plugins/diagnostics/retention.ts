import { unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// 采样行和诊断包会随运维页打开一直增加。这里只留最近一批，避免数据库和诊断目录无上限增长。
export const maxRetainedPerformanceSamples = 200;
export const maxRetainedDiagnosticPackages = 20;

type SqlStatement = {
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes: number };
};

type RetentionDb = {
  prepare(sql: string): SqlStatement;
};

export function prunePerformanceSamples(db: RetentionDb, maxRetained = maxRetainedPerformanceSamples): number {
  if (!Number.isInteger(maxRetained) || maxRetained < 1) {
    throw new Error('performance_sample_retention_invalid');
  }
  return db.prepare(
    `DELETE FROM performance_samples
     WHERE id NOT IN (
       SELECT id FROM performance_samples
       ORDER BY sampled_at DESC, id DESC
       LIMIT ?
     )`
  ).run(maxRetained).changes;
}

export function diagnosticPackagePathIsInside(rootDir: string, filePath: string): boolean {
  const root = resolve(rootDir);
  const target = resolve(filePath);
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

export function pruneDiagnosticPackages(input: {
  db: RetentionDb;
  diagnosticsDir: string;
  maxRetained?: number;
  removeFile?: (filePath: string) => void;
}): number {
  const maxRetained = input.maxRetained ?? maxRetainedDiagnosticPackages;
  if (!Number.isInteger(maxRetained) || maxRetained < 1) {
    throw new Error('diagnostic_package_retention_invalid');
  }
  const stale = input.db.prepare(
    `SELECT id, path FROM diagnostic_packages
     WHERE id NOT IN (
       SELECT id FROM diagnostic_packages
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )`
  ).all(maxRetained) as { id: string; path: string }[];
  const removeFile = input.removeFile ?? unlinkDiagnosticFile;
  for (const row of stale) {
    if (diagnosticPackagePathIsInside(input.diagnosticsDir, row.path)) {
      removeFile(row.path);
    }
  }
  if (stale.length === 0) {
    return 0;
  }
  const placeholders = stale.map(() => '?').join(', ');
  return input.db.prepare(`DELETE FROM diagnostic_packages WHERE id IN (${placeholders})`).run(
    ...stale.map((row) => row.id)
  ).changes;
}

function unlinkDiagnosticFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
