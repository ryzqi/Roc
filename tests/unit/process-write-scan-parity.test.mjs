import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

async function load(path, simulated = false) {
  const contents = await readFile(path, 'utf8');
  const compiled = await build({
    stdin: { contents: contents + (path.includes('legacy') ? '' : '\nexport { assertProcessWriteLimits };'),
      loader: 'ts', resolveDir: dirname(resolve(path)) },
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: simulated ? [{
      name: 'scanner-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^node:fs\/promises$/ }, args => args.namespace === 'scanner-fixture'
          ? { path: args.path, external: true } : { path: args.path, namespace: 'scanner-fixture' });
        builder.onLoad({ filter: /.*/, namespace: 'scanner-fixture' }, () => ({
          contents: `export * from 'node:fs/promises';
            export const lstat = path => globalThis.__rocScannerFixture.lstat(path);
            export const opendir = path => globalThis.__rocScannerFixture.opendir(path);
            export const realpath = async path => path;`, loader: 'js'
        }));
      }
    }] : []
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)).assertProcessWriteLimits;
}
const current = await load('src/main/plugins/research/process-runner.ts', true);
const legacy = await load('tests/fixtures/process-write-limits-legacy.ts', true);
const realCurrent = await load('src/main/plugins/research/process-runner.ts');
const realLegacy = await load('tests/fixtures/process-write-limits-legacy.ts');
const limits = overrides => ({ path: '/root', maxFileBytes: 128, maxTotalBytes: 1024, maxFiles: 64, maxEntries: 128, ...overrides });
const info = (kind = 'file', size = 1, nlink = 1) => ({
  size, nlink, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink'
});
const missing = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
function fixture(records, { iteratorError, iteratorErrorAt = records.length } = {}) {
  let active = 0, maxActive = 0;
  const calls = [], opened = [];
  return {
    calls, opened, get maxActive() { return maxActive; }, get active() { return active; },
    async lstat(path) {
      calls.push(path);
      if (path === '/root') return info('directory');
      const record = records.find(item => item.path === path);
      assert.ok(record, path);
      active++; maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolveDelay => setTimeout(resolveDelay, record.delay ?? 1));
        if (record.error) throw record.error;
        return record.info ?? info();
      } finally { active--; }
    },
    async opendir(path) {
      opened.push(path);
      return (async function* () {
        const children = records.filter(record => dirname(record.path) === path);
        for (let index = 0; index < children.length; index++) {
          if (index === iteratorErrorAt && iteratorError) throw iteratorError;
          yield { name: children[index].path.slice(path.length + 1) };
        }
        if (iteratorError && path === '/root' && iteratorErrorAt >= children.length) throw iteratorError;
      })();
    }
  };
}
async function outcome(scan, state, configuration = limits()) {
  globalThis.__rocScannerFixture = state;
  try { await scan([configuration]); return 'ok'; }
  catch (error) { return `${error.code ?? ''}:${error.message}`; }
  finally { assert.equal(state.active, 0, 'all lookahead observations must settle before returning'); }
}

test('fresh batched snapshots preserve serial budgets, traversal and ordered failures', async () => {
  const cases = [
    { records: [] },
    { records: Array.from({ length: 19 }, (_, index) => ({ path: `/root/${index}`, delay: 20 - index })) },
    { records: [{ path: '/root/a', error: missing() }, { path: '/root/b', info: info('file', 128) }] },
    { records: [{ path: '/root/a', info: info('symlink'), delay: 3 }, { path: '/root/b', error: new Error('later-failure') }] },
    { records: [{ path: '/root/a', info: info('other') }, { path: '/root/b', info: info('file', 9000) }] },
    { records: [{ path: '/root/a', info: info('file', 1, 2) }] },
    { records: [{ path: '/root/a', info: info('file', 129) }] },
    { records: [{ path: '/root/a' }, { path: '/root/b', error: new Error('over-limit-stat-must-not-run') }], limit: { maxEntries: 1 } },
    { records: [{ path: '/root/a', error: new Error('first-error') }, { path: '/root/b' }], limit: { maxEntries: 1 } },
    { records: [{ path: '/root/a', info: info('file', 100) }, { path: '/root/b', info: info('file', 100) }], limit: { maxTotalBytes: 150 } },
    { records: [{ path: '/root/a' }, { path: '/root/b' }], limit: { maxFiles: 1 } },
    { records: [{ path: '/root/a', info: info('file', Number.MAX_SAFE_INTEGER) }, { path: '/root/b' }],
      limit: { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER } },
    { records: [{ path: '/root/a', info: info('directory') }, { path: '/root/b', info: info('directory') },
      { path: '/root/a/child' }, { path: '/root/b/child' }] },
    { records: [{ path: '/root/a', error: new Error('stat-before-iterator') }], options: { iteratorError: new Error('iterator-error') } },
    { records: [{ path: '/root/a' }], options: { iteratorError: new Error('iterator-error') } },
    { records: Array.from({ length: 10 }, (_, index) => ({ path: `/root/${index}` })),
      options: { iteratorError: new Error('iterator-after-partial-batch'), iteratorErrorAt: 9 } }
  ];
  for (const scenario of cases) {
    const oldState = fixture(scenario.records, scenario.options), newState = fixture(scenario.records, scenario.options);
    assert.equal(await outcome(current, newState, limits(scenario.limit)), await outcome(legacy, oldState, limits(scenario.limit)));
    assert.deepEqual(newState.opened, oldState.opened);
    assert.ok(newState.maxActive <= 8);
    if (scenario.limit?.maxEntries === 1) assert.deepEqual(newState.calls, ['/root', '/root/a']);
  }
  delete globalThis.__rocScannerFixture;
});

test('parallel observations are bounded and the serial diagnostic path retains exact results', async () => {
  const records = Array.from({ length: 25 }, (_, index) => ({ path: `/root/${index}`, delay: 4 }));
  const state = fixture(records);
  assert.equal(await outcome(current, state), 'ok');
  assert.equal(state.maxActive, 8);
  const previous = process.env.ROC_PERF_PROCESS_SCAN_BATCH;
  try {
    process.env.ROC_PERF_PROCESS_SCAN_BATCH = '0';
    const serial = fixture(records);
    assert.equal(await outcome(current, serial), 'ok');
    assert.equal(serial.maxActive, 1);
  } finally {
    if (previous === undefined) delete process.env.ROC_PERF_PROCESS_SCAN_BATCH;
    else process.env.ROC_PERF_PROCESS_SCAN_BATCH = previous;
    delete globalThis.__rocScannerFixture;
  }
});

test('real deep trees, source replacements and links are freshly rejected on every scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roc-write-scan-parity-'));
  try {
    let directory = root;
    for (let index = 0; index < 100; index++) { directory = join(directory, 'd'); await mkdir(directory); }
    const file = join(directory, 'result');
    await writeFile(file, 'small');
    const configured = [limits({ path: root, maxEntries: 102 })];
    for (const scan of [realLegacy, realCurrent]) await scan(configured);
    const replacement = join(directory, 'replacement');
    await writeFile(replacement, Buffer.alloc(1024)); await rename(replacement, file);
    for (const scan of [realLegacy, realCurrent]) await assert.rejects(scan(configured), /research_process_write_limit/);
    await writeFile(file, 'small');
    await link(file, join(root, 'hardlink'));
    for (const scan of [realLegacy, realCurrent]) await assert.rejects(scan(configured), /research_process_write_limit/);
    await rm(join(root, 'hardlink'));
    await symlink(file, join(root, 'symlink'));
    for (const scan of [realLegacy, realCurrent]) await assert.rejects(scan(configured), /research_process_write_symlink/);
    await rm(join(root, 'symlink'));
    await symlink(root, join(root, 'root-alias'));
    for (const scan of [realLegacy, realCurrent]) await assert.rejects(scan([limits({ path: join(root, 'root-alias') })]), /write_path_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
