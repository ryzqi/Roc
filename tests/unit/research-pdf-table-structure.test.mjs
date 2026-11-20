import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let extract, schema, paper;
before(async () => {
  [extract, schema, paper] = await Promise.all(['src/main/plugins/research/pdf-table-extractor.ts',
    'src/shared/schemas/research-paper-table.ts', 'src/main/plugins/research/paper-ir.ts']
    .map(entry => importTypeScriptModule(entry, {platform: 'node'})));
});
const block = extra => ({id: 't', kind: 'table', text: 'Exact original table text.', locator: 'page 2',
  imagePath: 'regions/t.png', locations: [{page: 2, bbox: [10, 20, 110, 120], coordinateOrigin: 'TOPLEFT'}], ...extra});
const html = '<table><caption>Table 3. Scores</caption><thead><tr><th rowspan="2">Method</th><th colspan="2">Score (%)</th></tr><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>Ours</td><td>95.1</td><td>96.2*</td></tr></tbody><tfoot><tr><td colspan="3">* test set</td></tr></tfoot></table>';
const table = (raw = html, extra = {}) => extract.extractPaperTable(block(), {id: 't', tableMatches: {fullHtml: raw}, ...extra});

test('merged grid, hierarchical headers, captions, explicit units, footnotes and raw HTML retain identities', () => {
  const t = table();
  assert.equal(t.status, 'parsed'); assert.equal(t.rawHtml, html);
  assert.equal(t.tableNumber, '3'); assert.equal(t.caption, 'Table 3. Scores');
  assert.deepEqual(t.columns.map(c => c.header), ['Method', 'Score (%) / A', 'Score (%) / B']);
  assert.deepEqual(t.columns.map(c => c.unit), [null, '%', '%']);
  assert.equal(t.rows[0].cells[0].rowSpan, 2); assert.equal(t.rows[0].cells[1].colSpan, 2);
  assert.deepEqual(t.rows[1].cells.map(c => c.column), [1, 2]);
  assert.equal(t.rows[2].cells[2].text, '96.2*'); assert.deepEqual(t.footnotes, ['* test set']);
  assert.equal(t.source.page, 2); assert.deepEqual(t.source.bbox, block().locations[0].bbox);
  schema.assertPaperTableBlock({...block(), table: t});
  const chunks = paper.paperBlocks([{...block(), table: t}], {paperId: 'p', parseId: 'parse', sourceHash: 'a'.repeat(64)});
  assert.equal(chunks[0].content, block().text);
  assert.deepEqual(chunks[0].semantic.table, t);
  const empty = paper.paperBlocks([{...block({text: ''}), table: t}], {paperId: 'p', parseId: 'parse', sourceHash: 'a'.repeat(64)});
  assert.equal(empty[0].content, '');
  assert.deepEqual(empty[0].semantic.table, t);
});

test('rootless SLANet thead HTML, matched preference, empty-fullHtml fallback and ordinary td rows', () => {
  const rootless = '<thead><tr><td>Time [ms]</td></tr></thead><tbody><tr><td>2.0</td></tr></tbody>';
  const t = table(rootless, {table: {html: '<tr><td>wrong</td></tr>'}});
  assert.equal(t.columns[0].header, 'Time [ms]'); assert.equal(t.columns[0].unit, 'ms');
  assert.equal(t.rows[1].cells[0].text, '2.0'); assert.equal(t.htmlSource, 'matched');
  const fallback = table('', {tableMatches: {fullHtml: '', html: rootless}});
  assert.equal(fallback.status, 'parsed'); assert.equal(fallback.rawHtml, rootless);
  const plain = table('<tr><td>Method</td></tr><tr><td>Ours</td></tr>');
  assert.equal(plain.columns[0].header, ''); assert.equal(plain.rows[0].cells[0].header, false);
  assert.equal(table('<tr><td>&lt;1<br>😀 <script>bad()</script></td></tr>').rows[0].cells[0].text, '<1 😀');
});

test('missing and invalid structures remain explicit and raw HTML is retained on failure', () => {
  const missing = extract.extractPaperTable(block(), null);
  assert.equal(missing.status, 'missing'); assert.deepEqual(missing.rows, []);
  for (const raw of ['<p>not a grid</p>', '<tr><td rowspan="0">x</td></tr>', '<tr><td colspan="-1">x</td></tr>',
    '<tr><td rowspan="2">x</td></tr>', '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>',
    '<table><tr><td>x</td></tr></table><table><tr><td>y</td></tr></table>']) {
    const t = table(raw); assert.equal(t.status, 'invalid', raw); assert.equal(t.rawHtml, raw);
    assert.deepEqual(t.rows, []); assert.ok(t.warnings.includes('research_table_structure_invalid'));
  }
  assert.throws(() => table('x'.repeat(schema.paperTableLimits.maxHtmlChars + 1)), /html_too_large/);
  assert.throws(() => extract.attachPaperTables([block()], [{regions: [{id: 't'}, {id: 't'}]}]), /binding_invalid/);
  assert.throws(() => extract.extractPaperTable(block(), {id: 'foreign'}), /binding_invalid/);
});

test('complete crop boxes map to original page, incomplete or invalid mappings never invent cell geometry', () => {
  const raw = '<tr><td>a</td><td>b</td></tr>';
  const t = table(raw, {table: {bbox: [[0, 0, 40, 0, 40, 20, 0, 20], [40, 0, 80, 20]]}});
  assert.deepEqual(t.rows[0].cells.map(c => c.bbox), [[10, 20, 50, 40], [50, 20, 90, 40]]);
  for (const boxes of [[], [[0, 0, 40, 20]], [[0, 0, 40, 20], [40, 0, 120, 20]],
    [[0, 0, 40, 20], [40, 0, Number.NaN, 20]]]) {
    const t = table(raw, {table: {bbox: boxes}});
    assert.ok(t.rows[0].cells.every(c => c.bbox === null)); assert.ok(t.warnings.length);
  }
});

test('schema and original block reject changed identity, overlaps, headers, geometry and asset references', () => {
  for (const mutate of [t => t.id = 'foreign', t => t.rows[0].cells[0].id = 'foreign',
    t => t.rows[0].cells[0].colSpan = 2, t => t.columns[0].headerCellIds = [],
    t => t.columns[0].header = 'invented', t => t.rows[2].index = 0, t => t.source.page = 3,
    t => t.source.locator = 'page 4', t => t.source.bbox = [0, 0, 1, 1],
    t => t.imagePath = 'other.png', t => t.assetId = 'invented']) {
    const t = table(); mutate(t);
    assert.throws(() => schema.assertPaperTableBlock({...block(), table: t}));
  }
});
