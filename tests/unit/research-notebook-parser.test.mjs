import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { parseResearchNotebook } = await importTypeScriptModule(
  'src/main/plugins/research/notebook-parser.ts', { platform: 'node' });
const bytes = notebook => Buffer.from(JSON.stringify(notebook));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const code = (id = 'code-1', source = ['value = 1\n', 'print(value)\n']) => ({
  id, cell_type: 'code', metadata: {}, source, execution_count: null, outputs: []
});
const notebook = cells => ({ nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, cells });

test('static notebook parsing preserves all original cell data and binds byte, source, cell and output identities', () => {
  const original = notebook([
    { id: 'intro', cell_type: 'markdown', source: ['# 中文\n', '<script>untrusted()</script>'],
      metadata: { custom: { author: 'fixture' } }, attachments: { 'figure.png': { 'image/png': 'aW1hZ2U=' } } },
    { ...code(), execution_count: 7, metadata: { trusted: true, execution: { 'iopub.status.idle': '2026-11-06' } },
      outputs: [{ output_type: 'execute_result', execution_count: 7,
        metadata: { custom: [1, 2] }, data: { 'application/json': { value: 1 }, 'text/plain': ['1', '\n'] } }] },
    { id: 'raw', cell_type: 'raw', source: '<iframe src="https://untrusted.invalid"></iframe>', metadata: { format: 'html' } }
  ]);
  const input = bytes(original), { notebook: retained, preview } = parseResearchNotebook(input);
  assert.deepEqual(retained, original);
  assert.equal(preview.sha256, sha256(input));
  assert.equal(preview.size, input.length);
  assert.deepEqual(preview.cells.map(cell => [cell.index, cell.id]), [[0, 'intro'], [1, 'code-1'], [2, 'raw']]);
  assert.equal(preview.cells[1].executionCount, 7);
  assert.equal(preview.cells[1].sourceHash, sha256('value = 1\nprint(value)\n'));
  assert.equal(preview.cells[1].cellHash, sha256(JSON.stringify(original.cells[1])));
  assert.equal(preview.cells[1].outputs[0].hash, sha256(JSON.stringify(original.cells[1].outputs[0])));
  assert.equal(preview.cells[0].attachments[0].hash, sha256(JSON.stringify(original.cells[0].attachments['figure.png'])));
  assert.equal(preview.cells[1].outputs[0].text, '1\n');
  assert.equal(preview.outputTrust, 'untrusted');
  assert.equal(preview.execution, 'static');
  const alternate = structuredClone(original);
  alternate.cells[1].source = 'value = 1\nprint(value)\n';
  const changed = parseResearchNotebook(bytes(alternate)).preview;
  assert.equal(changed.cells[1].sourceHash, preview.cells[1].sourceHash);
  assert.notEqual(changed.cells[1].cellHash, preview.cells[1].cellHash);
  assert.notEqual(changed.sha256, preview.sha256);
});

test('malicious code and trusted rich output remain inert, with only literal text exposed to preview', () => {
  delete globalThis.rocNotebookExecuted;
  const html = '<img src="https://untrusted.invalid" onerror="globalThis.rocNotebookExecuted=true">';
  const js = 'globalThis.rocNotebookExecuted=true';
  const original = notebook([{ ...code('malicious', js), metadata: { trusted: true }, outputs: [
    { output_type: 'display_data', metadata: { trusted: true },
      data: { 'text/html': html, 'application/javascript': js, 'image/svg+xml': `<svg onload="${js}"/>`, 'text/plain': html } },
    { output_type: 'display_data', metadata: {}, data: { 'application/javascript': js } }
  ] }]);
  const { notebook: retained, preview } = parseResearchNotebook(bytes(original));
  assert.equal(globalThis.rocNotebookExecuted, undefined);
  assert.deepEqual(retained, original);
  assert.equal(preview.cells[0].outputs[0].text, html); // must be rendered as literal text by the consumer
  assert.equal(preview.cells[0].outputs[1].text, '');
  assert.equal(preview.cells[0].outputs[0].trust, 'untrusted');
  assert.equal(preview.cells[0].reviewIssues.filter(issue => issue.kind === 'rich_output').length, 4);
  assert.equal('data' in preview.cells[0].outputs[0], false);
});

test('cell order, source lines, execution counts, errors and potential unsupported syntax remain visible', () => {
  const source = String.raw`%load_ext custom
!cat /private/data
import subprocess
path = "../data.csv"
absolute = "/etc/passwd"
get_ipython().run_line_magic("time", "run()")
`;
  const { preview } = parseResearchNotebook(bytes(notebook([{ ...code('review', source), execution_count: 0,
    outputs: [
      { output_type: 'stream', name: 'stderr', text: ['first\n', 'second\n'] },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line 1', 'line 2'] }
    ] }])));
  assert.deepEqual(preview.cells[0].reviewIssues.map(issue => [issue.kind, issue.line]),
    [['magic', 1], ['extension', 1], ['shell', 2], ['shell', 3], ['external_path', 4], ['external_path', 5], ['magic', 6]]);
  assert.equal(preview.cells[0].source, source);
  assert.equal(preview.cells[0].executionCount, 0);
  assert.equal(preview.cells[0].outputs[0].text, 'first\nsecond\n');
  assert.equal(preview.cells[0].outputs[1].text, 'ValueError: bad\nline 1\nline 2');
});

test('unsupported versions, missing IDs, duplicate identities and malformed structural metadata are refused', () => {
  for (const invalid of [
    { ...notebook([]), nbformat: 3 }, { ...notebook([]), nbformat_minor: 4 }, { ...notebook([]), nbformat_minor: 6 },
    notebook([{ ...code(), id: undefined }]), notebook([code('duplicate'), code('duplicate')]),
    notebook([{ ...code(), id: 'bad.id' }]), notebook([{ ...code(), execution_count: -1 }]),
    notebook([{ ...code(), unknown: 'cell field' }]),
    notebook([{ ...code(), metadata: { tags: ['same', 'same'] } }]),
    notebook([{ ...code('a'), metadata: { name: 'same' } }, { ...code('b'), metadata: { name: 'same' } }]),
    { ...notebook([]), metadata: { kernelspec: { name: 'python3' } } },
    notebook([{ ...code(), outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/html': { invalid: true } } }] }])
  ]) assert.throws(() => parseResearchNotebook(bytes(invalid)));
  assert.throws(() => parseResearchNotebook(Uint8Array.of(0xc3, 0x28)), TypeError);
  assert.throws(() => parseResearchNotebook(Buffer.from('{')), SyntaxError);
});

test('pre-parse byte, structural depth and node limits and per-cell source/output limits fail explicitly', () => {
  assert.throws(() => parseResearchNotebook(Buffer.alloc(8 * 1024 * 1024 + 1)), /research_notebook_size_limit/u);
  let nested = 'leaf';
  for (let level = 0; level < 33; level++) nested = { child: nested };
  assert.throws(() => parseResearchNotebook(bytes({ ...notebook([]), metadata: { nested } })), /research_notebook_depth_limit/u);
  assert.throws(() => parseResearchNotebook(bytes({ ...notebook([]), metadata: { large: Array(100001).fill(0) } })),
    /research_notebook_node_limit/u);
  assert.throws(() => parseResearchNotebook(bytes(notebook([code('long', 'x'.repeat(256 * 1024 + 1))]))),
    /research_notebook_source_limit/u);
  assert.throws(() => parseResearchNotebook(bytes(notebook([{ ...code(), outputs: [
    { output_type: 'stream', name: 'stdout', text: 'x'.repeat(2 * 1024 * 1024 + 1) }
  ] }]))), /research_notebook_output_limit/u);
  assert.throws(() => parseResearchNotebook(bytes(notebook(Array.from({ length: 501 }, (_, index) => code(`cell-${index}`))))));
  assert.throws(() => parseResearchNotebook(bytes(notebook([{ ...code(), outputs: Array.from({ length: 101 }, () =>
    ({ output_type: 'stream', name: 'stdout', text: 'output' })) }]))));
  assert.throws(() => parseResearchNotebook(bytes(notebook([code('too-many-review-lines', '%magic\n'.repeat(101))]))),
    /research_notebook_review_limit/u);
});

test('preview truncation is explicit while hashes and returned originals cover full source and output', () => {
  const source = 'print(1)\n'.repeat(1000), output = 'message\n'.repeat(2000);
  const original = notebook([{ ...code('long', source),
    outputs: [{ output_type: 'stream', name: 'stdout', text: output }] }]);
  const result = parseResearchNotebook(bytes(original)), cell = result.preview.cells[0];
  assert.deepEqual(result.notebook, original);
  assert.equal(cell.source.length, 8000);
  assert.equal(cell.sourceCharacters, source.length);
  assert.equal(cell.sourceHash, sha256(source));
  assert.equal(cell.outputs[0].text.length, 8000);
  assert.equal(cell.outputs[0].textCharacters, output.length);
  assert.equal(cell.outputs[0].hash, sha256(JSON.stringify(original.cells[0].outputs[0])));
  const undeclared = parseResearchNotebook(bytes({ ...notebook([]), metadata: {} })).preview;
  assert.equal(undeclared.language, null);
  assert.equal(undeclared.kernel, null);
});
