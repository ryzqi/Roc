import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activatePluginDataMigration } from '../../../src/main/infrastructure/migration/monolith-to-plugins';
import { DatabaseService } from '../../../src/main/services/database-service';
import { RocPaths } from '../../../src/main/services/paths';

let root: string;
let databaseService: DatabaseService | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'roc-runtime-migration-test-'));
  databaseService = null;
});

afterEach(() => {
  if (databaseService !== null) {
    databaseService.close();
  }
  rmSync(root, { recursive: true, force: true });
});

describe('runtime migration activation', () => {
  it('migrates old database through plugin-data-next, promotes plugin-data, and does not rerun', () => {
    const sourceDatabasePath = createCurrentDatabase();

    const first = activatePluginDataMigration({ sourceDatabasePath });

    expect(first).toMatchObject({
      migrated: true,
      pluginDataDir: join(root, 'plugin-data')
    });
    expect(existsSync(join(root, 'plugin-data'))).toBe(true);
    expect(existsSync(join(root, 'plugin-data-next'))).toBe(false);
    expect(readMarker()).toMatchObject({
      sourceDatabasePath,
      sourceChecksum: sha256File(sourceDatabasePath)
    });
    expect(countMigrationRuns()).toBe(1);

    const second = activatePluginDataMigration({ sourceDatabasePath });

    expect(second.migrated).toBe(false);
    expect(countMigrationRuns()).toBe(1);
  });

  it('wraps migration failures, keeps the old database unchanged, and does not promote plugin-data', () => {
    const sourceDatabasePath = createCurrentDatabase();
    const beforeChecksum = sha256File(sourceDatabasePath);
    databaseService?.db.exec('DROP TABLE skills');
    databaseService?.close();
    databaseService = null;
    const afterDropChecksum = sha256File(sourceDatabasePath);

    expect(() => activatePluginDataMigration({ sourceDatabasePath })).toThrow(/migration_failed/u);
    expect(sha256File(sourceDatabasePath)).toBe(afterDropChecksum);
    expect(afterDropChecksum).not.toBe(beforeChecksum);
    expect(existsSync(join(root, 'plugin-data'))).toBe(false);
    expect(existsSync(join(root, 'plugin-data', '.migration-complete.json'))).toBe(false);
  });

  it('cleans interrupted plugin-data-next and resumes migration without accepting a missing marker', () => {
    const sourceDatabasePath = createCurrentDatabase();
    const staleNext = join(root, 'plugin-data-next');
    mkdirSync(staleNext, { recursive: true });
    writeFileSync(join(staleNext, '.migration-lock'), 'interrupted', 'utf8');
    writeFileSync(join(staleNext, 'partial.txt'), 'partial', 'utf8');

    const result = activatePluginDataMigration({ sourceDatabasePath });

    expect(result.migrated).toBe(true);
    expect(existsSync(staleNext)).toBe(false);
    expect(readMarker().sourceChecksum).toBe(sha256File(sourceDatabasePath));
  });

  it('rejects existing plugin-data without a valid completion marker', () => {
    const sourceDatabasePath = createCurrentDatabase();
    mkdirSync(join(root, 'plugin-data'), { recursive: true });

    expect(() => activatePluginDataMigration({ sourceDatabasePath })).toThrow(/migration_target_exists/u);
  });
});

function createCurrentDatabase(): string {
  const paths = new RocPaths(root);
  paths.ensureTree();
  databaseService = new DatabaseService(paths);
  databaseService.initialize();
  return paths.databasePath;
}

function readMarker(): {
  sourceDatabasePath: string | null;
  sourceChecksum: string | null;
} {
  return JSON.parse(readFileSync(join(root, 'plugin-data', '.migration-complete.json'), 'utf8')) as {
    sourceDatabasePath: string | null;
    sourceChecksum: string | null;
  };
}

function countMigrationRuns(): number {
  const db = new Database(join(root, 'plugin-data', 'data', 'core.db'), { readonly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) FROM migration_runs').pluck().get());
  } finally {
    db.close();
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
