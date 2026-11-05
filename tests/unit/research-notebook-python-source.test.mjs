import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

let api, root;
const hash = value => createHash('sha256').update(value).digest('hex');
before(async () => {
  root = await mkdtemp('/private/tmp/roc-notebook-python-source-');
  const output = join(root, 'api.mjs');
  await build({ stdin: { contents: 'export { notebookPythonSource } from "./src/main/plugins/research/notebook-python-source";',
    resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  api = await import(output);
  assert.match(execFileSync('python3', ['-I', '-S', '-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8' }), /^3\.14\.\d+\n$/u);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
function recipe(sources, overrides = {}) {
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {
    language_info: { name: 'python' }, kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' }
  }, cells: sources.map((source, index) => ({ id: `cell-${index}`, cell_type: 'code', metadata: {}, source,
    execution_count: 91 + index, outputs: [{ output_type: 'stream', name: 'stdout', text: 'OLD UNTRUSTED RESULT' }] })), ...overrides };
  const bytes = Buffer.from(JSON.stringify(notebook, null, 2) + '\n');
  const snapshot = { schemaVersion: 1, id: 'notebook-1',
    request: { projectId: 'project-1', path: 'analysis.ipynb', requestId: 'import-1', expectedSha256: hash(bytes) },
    actor: { kind: 'user', id: 'window:72' }, workspacePath: '/workspace', sha256: hash(bytes), size: bytes.length, recordedAt: '2026-11-06T00:00:00Z' };
  return { bytes, receipt: { snapshot, snapshotHash: hash(JSON.stringify(snapshot)) } };
}
async function run(sources) {
  const original = recipe(sources), generated = api.notebookPythonSource(original.bytes, original.receipt);
  const path = join(root, `source-${generated.sourceHash}.py`);
  await writeFile(path, generated.source);
  return { original, generated, result: spawnSync('python3', ['-I', '-S', '-B', '-X', 'utf8', path], { cwd: root, encoding: 'utf8' }) };
}

test('original full cell source, order, hashes and receipt produce a deterministic Python recipe', async () => {
  const f = recipe(['x = 4\n', ['def value():\n', '    return x + 2\n'], 'print(value())\n']);
  const first = api.notebookPythonSource(f.bytes, f.receipt);
  assert.deepEqual(first, api.notebookPythonSource(f.bytes, f.receipt));
  assert.equal(first.sourceHash, hash(first.source));
  assert.equal(first.receiptHash, f.receipt.snapshotHash);
  assert.equal(first.sha256, hash(f.bytes));
  assert.deepEqual(first.cells.map(cell => [cell.id, cell.index]), [['cell-0', 0], ['cell-1', 1], ['cell-2', 2]]);
  assert.equal(first.cells[1].source, 'def value():\n    return x + 2\n');
  assert.equal(first.cells[1].sourceHash, hash(first.cells[1].source));
  const long = recipe(['#' + '完整源码'.repeat(3000) + '\nprint(__name__)\n']);
  const full = api.notebookPythonSource(long.bytes, long.receipt);
  assert.equal(full.cells[0].source, JSON.parse(long.bytes).cells[0].source);
  assert.equal(full.cells[0].source.length > 8000, true);
  const { result } = await run(['x = 4\n', 'def value():\n    return x + 2\n', 'print(value())\n']);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '6\n');
  assert.equal(first.source.includes('OLD UNTRUSTED RESULT'), false);
});

test('ordinary literals, comments, unicode and modulo stay Python source; expression display is explicitly absent', async () => {
  const { result } = await run(['# %load_ext and !ls are literal comments\ntext = """%time\\n!echo literal\\n你好"""\nx = 9 % 4\n',
    'print(text, x)\n', '123456789\nassert __name__ == "__main__"\n']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '%time\n!echo literal\n你好 1\n');
});

test('all cells compile before any code runs and errors keep exact original cell identity and line', async () => {
  const marker = join(root, 'SYNTAX_EXECUTED');
  const { generated, result } = await run(['from pathlib import Path\nPath("SYNTAX_EXECUTED").write_text("unsafe")\n', 'valid = 1\nbroken =\n']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /SyntaxError/u);
  assert.ok(result.stderr.includes(`roc-notebook:${generated.sha256}/cell-1`));
  assert.match(result.stderr, /line 2/u);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('magics, shell, extensions, interactive state, top-level await and cross-cell future state are rejected before execution', async () => {
  const unsupported = ['%time print(1)\n', '!echo unsafe\n', '%%bash\necho unsafe\n',
    'get_ipython().run_line_magic("time", "1")\n', 'import IPython\n', 'import subprocess\n',
    'from os import system\nsystem("echo unsafe")\n', 'exec("print(1)")\n',
    'await value()\n', 'from __future__ import annotations\n'];
  for (const source of unsupported) {
    const { result } = await run(['from pathlib import Path\nPath("UNSUPPORTED_EXECUTED").write_text("unsafe")\n', source]);
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, /SyntaxError/u, source);
    await assert.rejects(readFile(join(root, 'UNSUPPORTED_EXECUTED')), { code: 'ENOENT' });
  }
});

test('runtime failures retain negative outcomes and exact failed cell while later cells never run', async () => {
  const { generated, result } = await run(['print("earlier actual output")\n', 'raise ValueError("negative result")\n',
    'from pathlib import Path\nPath("LATER_EXECUTED").write_text("unsafe")\n']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, 'earlier actual output\n');
  assert.ok(result.stderr.includes(`roc-notebook:${generated.sha256}/cell-1`));
  assert.match(result.stderr, /ValueError: negative result/u);
  await assert.rejects(readFile(join(root, 'LATER_EXECUTED')), { code: 'ENOENT' });
});

test('missing language, foreign kernel, raw-only semantics, empty programs and receipt tampering fail before generation', () => {
  for (const overrides of [
    { metadata: {} }, { metadata: { language_info: { name: 'julia' } } },
    { metadata: { language_info: { name: 'python' }, kernelspec: { name: 'custom', language: 'python', display_name: 'Custom' } } },
    { cells: [{ id: 'raw-1', cell_type: 'raw', metadata: {}, source: 'print(1)' }] },
    { cells: [{ id: 'md-1', cell_type: 'markdown', metadata: {}, source: '# Text' }] }
  ]) {
    const f = recipe(['print(1)\n'], overrides);
    assert.throws(() => api.notebookPythonSource(f.bytes, f.receipt), /research_notebook_/u);
  }
  const f = recipe(['print(1)\n']);
  assert.throws(() => api.notebookPythonSource(f.bytes, { ...f.receipt, snapshotHash: 'f'.repeat(64) }), /research_notebook_hash_mismatch/u);
  const changed = recipe(['print(2)\n']);
  assert.throws(() => api.notebookPythonSource(changed.bytes, f.receipt), /research_notebook_hash_mismatch/u);
});
