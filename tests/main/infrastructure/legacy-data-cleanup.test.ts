import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteLegacyMonolithData,
  legacyMonolithDataFileNames
} from '../../../src/main/infrastructure/legacy-data-cleanup';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'roc-legacy-data-cleanup-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('deleteLegacyMonolithData', () => {
  it('keeps legacy monolith database files when migration completion has not been verified', async () => {
    writeFileSync(join(root, 'roc.sqlite'), 'old database', 'utf8');

    const result = await deleteLegacyMonolithData(root);

    expect(result.deleted).toEqual([]);
    expect(result.skippedDirectories).toEqual([]);
    expect(existsSync(join(root, 'roc.sqlite'))).toBe(true);
  });

  it('deletes only legacy monolith database files directly under the Roc data root after migration completion is verified', async () => {
    const allowedFiles = [
      ...legacyMonolithDataFileNames,
      'roc.sqlite.phase1-backup-2026-06-09T00-00-00-000Z',
      'roc.sqlite.bak-2026-06-09T00-00-00-000Z'
    ];
    writeMigrationMarker();
    for (const fileName of allowedFiles) {
      writeFileSync(join(root, fileName), fileName, 'utf8');
    }
    writeFileSync(join(root, 'plugin-data.db'), 'new data', 'utf8');
    mkdirSync(join(root, 'roc.sqlite-directory'), { recursive: true });

    const result = await deleteLegacyMonolithData(root);

    expect(result.deleted.sort()).toEqual(allowedFiles.map((fileName) => resolve(root, fileName)).sort());
    expect(result.skippedDirectories).toEqual([]);
    for (const fileName of allowedFiles) {
      expect(existsSync(join(root, fileName))).toBe(false);
    }
    expect(existsSync(join(root, 'plugin-data.db'))).toBe(true);
    expect(existsSync(join(root, 'roc.sqlite-directory'))).toBe(true);
  });

  it('does not delete directories even when their names match legacy database files', async () => {
    writeMigrationMarker();
    mkdirSync(join(root, 'roc.sqlite'), { recursive: true });
    writeFileSync(join(root, 'roc.sqlite', 'nested.txt'), 'nested', 'utf8');

    const result = await deleteLegacyMonolithData(root);

    expect(result.deleted).toEqual([]);
    expect(result.skippedDirectories).toEqual([resolve(root, 'roc.sqlite')]);
    expect(existsSync(join(root, 'roc.sqlite', 'nested.txt'))).toBe(true);
  });

  it('does not delete matching legacy files outside the supplied Roc data root', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'roc-legacy-data-outside-test-'));
    try {
      writeFileSync(join(outsideRoot, 'roc.sqlite'), 'outside', 'utf8');

      const result = await deleteLegacyMonolithData(root);

      expect(result.deleted).toEqual([]);
      expect(existsSync(join(outsideRoot, 'roc.sqlite'))).toBe(true);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

function writeMigrationMarker(): void {
  mkdirSync(join(root, 'plugin-data'), { recursive: true });
  writeFileSync(
    join(root, 'plugin-data', '.migration-complete.json'),
    `${JSON.stringify({
      sourceDatabasePath: join(root, 'roc.sqlite'),
      sourceChecksum: 'sha256-test',
      pluginDatabaseChecksums: {
        '@roc/plugin-agent': 'agent-checksum'
      },
      completedAt: '2026-06-09T00:00:00.000Z'
    }, null, 2)}\n`,
    'utf8'
  );
}
