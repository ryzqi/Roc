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
      await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', loader: { '.md': 'text' } });
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

test('full scans honor aborts, skip symlink files, and enforce safety caps', async () => {
  const dir = mkdtempSync(realpathSync(join(tmpdir())) + '/roc-index-scan-limits-');
  try {
    const outfile = join(dir, 'index-files.mjs');
    await build({
      entryPoints: ['src/main/plugins/research/index-files.ts'],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external'
    });
    const files = await import(outfile);
    const options = { kinds: ['markdown'], include: ['**/*.md'], exclude: [] };
    const storage = join(dir, 'storage');
    mkdirSync(storage);

    const root = join(dir, 'workspace');
    mkdirSync(root);
    const target = join(root, 'actual.md');
    writeFileSync(target, 'content');
    symlinkSync(target, join(root, 'linked.md'), 'file');
    const signal = new AbortController().signal;
    const scanned = await files.scanIndexFiles(root, options, storage, signal);
    assert.deepEqual(scanned.map((file) => file.path), ['actual.md']);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => files.scanIndexFiles(root, options, storage, aborted.signal),
      (error) => error?.name === 'AbortError'
    );

    const visitRoot = join(dir, 'visited-entries');
    mkdirSync(visitRoot);
    const seed = join(dir, 'symlink-target');
    writeFileSync(seed, 'ignored');
    for (let index = 0; index < 50_001; index += 1) {
      symlinkSync(seed, join(visitRoot, `entry-${index}.link`), 'file');
    }
    await assert.rejects(
      () => files.scanIndexFiles(visitRoot, options, storage, signal),
      /research_index_directory_limit/
    );

    const fileRoot = join(dir, 'indexed-files');
    mkdirSync(fileRoot);
    for (let index = 0; index < 10_001; index += 1) {
      writeFileSync(join(fileRoot, `file-${index}.md`), '');
    }
    await assert.rejects(
      () => files.scanIndexFiles(fileRoot, options, storage, signal),
      /research_index_file_limit/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
