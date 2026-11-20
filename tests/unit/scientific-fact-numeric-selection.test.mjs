import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/scientific-fact-wire.ts',
  {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'});});
const conditions = {datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
  baselineId: null, budget: 'unknown', other: {}};
const build = entries => {
  const cells = entries.map(({raw, header = false, declaredHeader = header, unit = null}, column) =>
    ({id: `cell-${column}`, originalId: `original-${column}`, row: 1, column, text: raw, header, declaredHeader, unit}));
  const table = {id: 'table', cells, data: {
    rows: [{index: 1, cells: cells.map(c => ({id: c.originalId, column: c.column, text: c.text, header: c.header}))}],
    columns: cells.map(c => ({index: c.column, headerCellIds: c.declaredHeader ? [c.originalId] : [], unit: c.unit}))}};
  const scope = {tableId: table.id, metricHeaders: [], linkedTextRanges: [],
    rows: [{row: 1, conditionCellIds: cells.map(c => c.id), subjects: []}]};
  const batch = {id: 'batch', blocks: [], objects: [{objectType: 'Table', objectId: table.id}]};
  const schema = api.scientificFactWireSchema({tables: [table]}, batch, [scope], {cellHandle: (_table, id) => id},
    [], {entities: [], sources: []});
  const candidate = c => ({id: 'fact', factType: 'experimental_result', subjectEntityId: null, objectEntityId: null,
    predicate: 'Original numerical candidate', value: {raw: c.text, unit: null, unitEvidence: []},
    table: {tableId: table.id, row: 1, cellId: c.id}, conditions, conditionEvidence: [],
    evidence: [{kind: 'table_cell', tableId: table.id, cellId: c.id, raw: c.text}], confidence: .5});
  return {schema, cells, candidate};
};
test('numerical wire excludes row labels and declared headers but retains full raw composite choices', () => {
  const accepted = ['0.623', '  1.20  ', '-.5', '−.5', '1.2e-3', '1e9999', '90%',
    '0.615 0.927', '0.817 0.915 0.667', '90 ± 1', '90 +/- 1', '1,234',
    '[0.1, 0.2]', '(0.1, 0.2)', '90 (1)', '0.1–0.2', '0.1 / 0.2', '≤ 0.05', '90†'];
  const rejected = ['movie', '20 newsgroups', 'GE-FL', 'model-123', '', 'N/A', '1.2e',
    'Accuracy 90%', 'version 2', '20 ms', '0.623 rewritten'];
  const entries = [...accepted.map(raw => ({raw})), ...rejected.map(raw => ({raw})),
    {raw: '2026', header: true}, {raw: '95%', header: true}, {raw: '20 ms', unit: 'ms'}];
  const {schema, cells, candidate} = build(entries);
  for (let i = 0; i < cells.length; i++) {
    const expected = i < accepted.length || i === cells.length - 1;
    assert.equal(schema.safeParse({facts: [candidate(cells[i])]}).success, expected, JSON.stringify(entries[i]));
  }
  const label = candidate(cells[accepted.length]);
  assert.ok(schema.safeParse({facts: [{...label, factType: 'dataset_usage', value: null, table: null}]}).success,
    'Original labels remain available as nonnumeric evidence');
  const wrongRaw = candidate(cells[0]); wrongRaw.value.raw = 'movie';
  assert.ok(!schema.safeParse({facts: [wrongRaw]}).success, 'Numeric cell cannot select a label raw');
  const wrongCell = candidate(cells[0]); wrongCell.table.cellId = cells[accepted.length].id;
  assert.ok(!schema.safeParse({facts: [wrongCell]}).success, 'Numeric raw cannot select a label value cell');
});
test('label-only rows cannot select experimental results and keep their evidence', () => {
  const {schema, cells, candidate} = build([{raw: 'movie'}, {raw: '20 newsgroups'}]);
  assert.ok(!schema.safeParse({facts: [candidate(cells[0])]}).success);
  assert.ok(schema.safeParse({facts: [{...candidate(cells[0]), factType: 'dataset_usage', value: null, table: null}]}).success);
});
test('unit suffixes retain exact scalar/composite raw with markers and reject mismatched units', () => {
  const accepted = ['20 ms', '20 ms†', '20 ms *', '20 ms†‡', '20 ± 1 ms†',
    '20 +/- 1 ms‡', '20 21 ms*', '[20, 21] ms†', '20† ms', '20† ms‡'];
  const rejected = [{raw: '20 ms†', unit: null}, {raw: '20 ms†', unit: 's'},
    {raw: '20 ms†', unit: 'MS'}, {raw: '20 MS†', unit: 'ms'},
    {raw: '20 ms label', unit: 'ms'}, {raw: '20 milliseconds†', unit: 'ms'},
    {raw: '20 ms† 21', unit: 'ms'}];
  const entries = [...accepted.map(raw => ({raw, unit: 'ms'})), ...rejected];
  const {schema, cells, candidate} = build(entries);
  for (let i = 0; i < cells.length; i++) {
    const parsed = schema.safeParse({facts: [candidate(cells[i])]});
    assert.equal(parsed.success, i < accepted.length, JSON.stringify(entries[i]));
    if (parsed.success) assert.equal(parsed.data.facts[0].value.raw, entries[i].raw);
  }
});
test('original header flag and declared header IDs each independently exclude numerical values', () => {
  const entries = [{raw: '2026', header: true, declaredHeader: false},
    {raw: '95%', header: false, declaredHeader: true},
    {raw: '20 ms†', header: true, declaredHeader: false, unit: 'ms'},
    {raw: '21', header: false, declaredHeader: false}];
  const {schema, cells, candidate} = build(entries);
  for (let i = 0; i < cells.length; i++) {
    const numeric = candidate(cells[i]);
    assert.equal(schema.safeParse({facts: [numeric]}).success, i === 3, JSON.stringify(entries[i]));
    assert.ok(schema.safeParse({facts: [{...numeric, factType: 'dataset_usage', value: null, table: null}]}).success,
      'Header remains original nonnumeric evidence');
  }
});
