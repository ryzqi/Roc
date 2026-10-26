import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { csvFormat } from 'd3-dsv';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const runnerPath = join(repositoryRoot, 'resources/research-runtime/typescript-experiment-runner.mts');
const runtimeExecutable = process.platform === 'darwin'
  ? join(repositoryRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : process.platform === 'win32'
    ? join(repositoryRoot, 'node_modules/electron/dist/electron.exe')
    : join(repositoryRoot, 'node_modules/electron/dist/electron');
const require = createRequire(import.meta.url);
const packageEntries = Object.fromEntries(['csv-parse', 'csv-stringify', 'd3-dsv', 'simple-statistics']
  .map((name) => [name, require.resolve(name)]));
const packageRoots = [...new Set(Object.values(packageEntries).map((entry) => {
  let root = dirname(entry);
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('research_experiment_test_package_root_missing');
    root = parent;
  }
  return realpathSync(root);
}))];

const defaultLimits = {
  inputFileBytes: 1024 * 1024,
  totalInputBytes: 2 * 1024 * 1024,
  csvRows: 1000,
  outputFileBytes: 1024,
  totalOutputBytes: 2048,
  outputFiles: 10
};

async function runRunner(source, limits = {}, inputFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'roc-experiment-csv-'));
  const canonicalRoot = realpathSync(root);
  const inputDir = join(canonicalRoot, 'input');
  const outputDir = join(canonicalRoot, 'output');
  await mkdir(inputDir);
  await mkdir(outputDir);
  await writeFile(join(inputDir, 'experiment.mts'), source);
  for (const [path, content] of Object.entries(inputFiles)) {
    const target = join(inputDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const request = {
    contractVersion: 1,
    sourcePath: 'experiment.mts',
    inputPaths: Object.keys(inputFiles),
    inputDir,
    outputDir,
    parameters: {},
    packageEntries,
    limits: { ...defaultLimits, ...limits }
  };
  const result = spawnSync(runtimeExecutable, [
    '--permission',
    `--allow-fs-read=${runnerPath}`,
    `--allow-fs-read=${inputDir}`,
    `--allow-fs-read=${join(inputDir, 'experiment.mts')}`,
    ...Object.keys(inputFiles).map((path) => `--allow-fs-read=${join(inputDir, path)}`),
    `--allow-fs-read=${outputDir}`,
    `--allow-fs-read=${outputDir}${sep}`,
    `--allow-fs-read=${runtimeExecutable}`,
    ...packageRoots.map((path) => `--allow-fs-read=${path}${sep}`),
    `--allow-fs-write=${outputDir}`,
    `--allow-fs-write=${outputDir}${sep}`,
    runnerPath
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  return { root, outputDir, result };
}

function rowsSource(rows, columns) {
  const records = rows.map((row) => `{${Object.entries(row)
    .map(([key, value]) => `${JSON.stringify(key)}:${value === undefined ? 'undefined' : JSON.stringify(value)}`).join(',')}}`);
  const options = columns === undefined ? '' : `, { columns: ${JSON.stringify(columns)} }`;
  return `export async function run(context) {
    await context.files.writeCsv('nested/results.csv', [${records.join(',')}]${options});
  }`;
}

test('experiment writeCsv preserves d3-dsv column, value and quoting semantics', async () => {
  const columns = ['id', 'text', 'empty', 'enabled', 'score', 'formula'];
  const rows = [
    { id: 1, text: 'comma, field', empty: null, enabled: false, score: 2.5, formula: '=A1', ignored: 'not exported' },
    { id: 2, text: 'line\nbreak and "quotes"', empty: undefined, enabled: true, score: -4.25, formula: '@SUM(1,2)' },
    { id: 3, text: 'carriage\rreturn', empty: '', enabled: false, score: 0, formula: '+1' },
    { id: 4, text: ' leading and trailing ', empty: '', enabled: false, score: 0, formula: '=1+1' }
  ];
  const { root, outputDir, result } = await runRunner(rowsSource(rows, columns));
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const outputPath = join(outputDir, 'nested/results.csv');
    assert.equal(await readFile(outputPath, 'utf8'), csvFormat(rows, columns));
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv infers columns in first-row key order', async () => {
  const rows = [
    { zeta: 'last header', alpha: 'first header', empty: null },
    { alpha: 'second row', zeta: 'first row', ignored: 'not exported' }
  ];
  const { root, outputDir, result } = await runRunner(rowsSource(rows));
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(outputDir, 'nested/results.csv'), 'utf8'), csvFormat(rows, ['zeta', 'alpha', 'empty']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv snapshots validated columns and row values before awaiting output setup', async () => {
  const source = `export async function run(context) {
    const rows = [{ before: 'original' }];
    const columns = ['before'];
    const writing = context.files.writeCsv('snapshot.csv', rows, { columns });
    rows[0].before = 'mutated';
    rows.push({ before: 'late row' });
    columns[0] = 'after';
    await writing;
  }`;
  const { root, outputDir, result } = await runRunner(source);
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(outputDir, 'snapshot.csv'), 'utf8'), 'before\noriginal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment readCsv still parses declared input for streamed CSV output', async () => {
  const source = `export async function run(context) {
    const rows = await context.files.readCsv('measurements.csv');
    await context.files.writeCsv('copy.csv', rows, { columns: ['label', 'value'] });
  }`;
  const { root, outputDir, result } = await runRunner(source, {}, {
    'measurements.csv': 'label,value\n"A,B",2\n"line\nbreak",3\n'
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(outputDir, 'copy.csv'), 'utf8'), 'label,value\n"A,B",2\n"line\nbreak",3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv enforces streamed file bytes and removes partial output', async () => {
  const rows = [{ value: '🙂' }];
  const source = rowsSource(rows, ['value']);
  const { root, outputDir, result } = await runRunner(source, { outputFileBytes: 9 });
  try {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /research_experiment_output_limit/u);
    await assert.rejects(access(join(outputDir, 'nested/results.csv')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv reserves total bytes across concurrent outputs', async () => {
  const source = `export async function run(context) {
    const results = await Promise.allSettled([
      context.files.writeCsv('first.csv', [{ value: 'a' }], { columns: ['value'] }),
      context.files.writeCsv('second.csv', [{ value: 'a' }], { columns: ['value'] })
    ]);
    if (results.filter((result) => result.status === 'fulfilled').length !== 1) {
      throw new Error('research_experiment_concurrent_output_budget_invalid');
    }
  }`;
  const { root, outputDir, result } = await runRunner(source, { totalOutputBytes: 9 });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const files = await Promise.all(['first.csv', 'second.csv'].map(async (path) => {
      try { return { path, content: await readFile(join(outputDir, path), 'utf8') }; }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    }));
    assert.equal(files.filter(Boolean).length, 1);
    assert.equal(files.find(Boolean).content, 'value\na');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv reserves output file slots across concurrent writes', async () => {
  const source = `export async function run(context) {
    const results = await Promise.allSettled([
      context.files.writeCsv('first.csv', [{ value: 'a' }], { columns: ['value'] }),
      context.files.writeCsv('second.csv', [{ value: 'a' }], { columns: ['value'] })
    ]);
    if (results.filter((result) => result.status === 'fulfilled').length !== 1) {
      throw new Error('research_experiment_concurrent_file_budget_invalid');
    }
  }`;
  const { root, outputDir, result } = await runRunner(source, { outputFiles: 1 });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const files = await Promise.all(['first.csv', 'second.csv'].map(async (path) => {
      try { return { path, content: await readFile(join(outputDir, path), 'utf8') }; }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    }));
    assert.equal(files.filter(Boolean).length, 1);
    assert.equal(files.find(Boolean).content, 'value\na');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv enforces the total byte budget without removing prior files', async () => {
  const source = `export async function run(context) {
    await context.files.writeCsv('first.csv', [{ value: 'ok' }], { columns: ['value'] });
    await context.files.writeCsv('second.csv', Array.from({ length: 20 }, () => ({ value: 'a' })), { columns: ['value'] });
  }`;
  const { root, outputDir, result } = await runRunner(source, { outputFileBytes: 1024, totalOutputBytes: 9 });
  try {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /research_experiment_output_limit/u);
    assert.equal(await readFile(join(outputDir, 'first.csv'), 'utf8'), 'value\nok');
    await assert.rejects(access(join(outputDir, 'second.csv')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeCsv aborts and removes a partial file when the runner is cancelled', async () => {
  const source = `export async function run(context) {
    const rows = Array.from({ length: 100000 }, () => ({ value: 'x'.repeat(512) }));
    const writing = context.files.writeCsv('cancelled.csv', rows, { columns: ['value'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.emit('SIGTERM');
    await writing;
  }`;
  const { root, outputDir, result } = await runRunner(source, {
    outputFileBytes: 60 * 1024 * 1024,
    totalOutputBytes: 60 * 1024 * 1024
  });
  try {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    await assert.rejects(access(join(outputDir, 'cancelled.csv')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment writeText removes a partial destination after a write error', async () => {
  const source = `import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function run(context) {
  const handle = await open(fileURLToPath(import.meta.url), 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const originalWriteFile = prototype.writeFile;
  prototype.writeFile = async function () { throw new Error('simulated_write_failure'); };
  try {
    try {
      await context.files.writeText('partial.txt', 'payload');
      throw new Error('write_succeeded');
    } catch (error) {
      if (error.message !== 'simulated_write_failure') throw error;
    }
  } finally {
    prototype.writeFile = originalWriteFile;
  }
}`;
  const { root, outputDir, result } = await runRunner(source);
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(join(outputDir, 'partial.txt')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
