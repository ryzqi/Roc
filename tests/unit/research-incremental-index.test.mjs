import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

test('dirty file reconciliation preserves unrelated files and falls back for directories and unsafe paths', async () => {
  const dir = mkdtempSync(realpathSync(join(tmpdir())) + '/roc-dirty-index-');
  const db = new Database(':memory:');
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const modules = {};
    for (const [name, entry] of Object.entries({ files: 'src/main/plugins/research/index-files.ts', repo: 'src/main/plugins/research/repository.ts', schema: 'src/main/infrastructure/database-schemas.ts', options: 'src/shared/schemas/research-index.ts' })) {
      const outfile = join(dir, `${name}.mjs`);
      await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', loader: { '.py': 'text', '.md': 'text' } });
      modules[name] = await import(outfile);
    }
    const root = join(dir, 'workspace');
    const storage = join(root, 'storage');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(root, 'a.md'), 'a');
    writeFileSync(join(root, 'b.md'), 'b');
    writeFileSync(join(storage, 'internal.md'), 'ignore');
    const options = modules.options.defaultResearchIndexOptions;
    const signal = new AbortController().signal;
    const full = await modules.files.scanIndexFiles(root, options, storage, signal);
    assert.equal(full.length, 2);
    modules.schema.applyResearchDatabaseSchema(db);
    const repo = new modules.repo.ResearchRepository(db, () => '2026-07-10T00:00:00.000Z');
    const project = repo.createProject({ title: 'dirty', description: '', workspacePath: root });
    repo.indexing.bindRoot(project.id, root);
    const keys = new Map([['markdown', 'roc-text-1']]);
    repo.indexing.reconcile(project.id, repo.indexing.beginScan(project.id), full, false, null, keys);
    writeFileSync(join(root, 'a.md'), 'changed');
    const paths = new Set(['a.md']);
    const changed = await modules.files.scanChangedIndexFiles(root, paths, options, storage, signal);
    assert.equal(changed.length, 1);
    repo.indexing.reconcile(project.id, repo.indexing.beginScan(project.id), changed, false, null, keys, paths);
    assert.equal(repo.indexing.listFiles(project.id, '', false, 100).length, 2);
    assert.equal(await modules.files.scanChangedIndexFiles(root, new Set(['storage']), options, join(dir, 'elsewhere'), signal), null);
    assert.equal(await modules.files.scanChangedIndexFiles(root, new Set(['../escape.md']), options, storage, signal), null);
    assert.deepEqual(await modules.files.scanChangedIndexFiles(root, new Set(['storage/internal.md']), options, storage, signal), []);
    rmSync(join(root, 'a.md'));
    const deleted = await modules.files.scanChangedIndexFiles(root, paths, options, storage, signal);
    repo.indexing.reconcile(project.id, repo.indexing.beginScan(project.id), deleted, false, null, keys, paths);
    assert.deepEqual(repo.indexing.listFiles(project.id, '', false, 100).map(file => file.path), ['b.md']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
