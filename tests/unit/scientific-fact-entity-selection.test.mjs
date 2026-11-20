import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/scientific-fact-wire.ts',
  {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'});});
const supplied = ['method', 'dataset', 'metric', 'baseline', 'equation-entity', 'other-row'];
const fields = ['subjectEntityId', 'objectEntityId', 'datasetId', 'metricId', 'baselineId'];
const build = (ids = supplied) => {
  const table = {id: 'table', cells: [{id: 'cell', originalId: 'original', row: 1, column: 0, text: '90'}],
    data: {rows: [{index: 1, cells: [{id: 'original', column: 0, text: '90', header: false}]}],
      columns: [{index: 0, headerCellIds: [], unit: null}]}};
  const batch = {id: 'batch', blocks: [], objects: [{objectType: 'Table', objectId: 'table'},
    {objectType: 'Equation', objectId: 'equation:original'}]};
  const scopes = [{tableId: 'table', metricHeaders: [], linkedTextRanges: [],
    rows: [{row: 1, conditionCellIds: ['cell'], subjects: [
      ...(ids.includes('method') ? [{entityId: 'method', cellIds: ['cell']}] : []),
      {entityId: 'orphan-row-subject', cellIds: ['cell']}
    ]}]}];
  const entityTypes = {method: 'Method', dataset: 'Dataset', metric: 'Metric', baseline: 'Baseline',
    'equation-entity': 'Equation', 'other-row': 'Method'};
  const schema = api.scientificFactWireSchema({tables: [table]}, batch, scopes, {cellHandle: (_table, id) => id},
    ids, {entities: ids.map(id => ({id, entityType: entityTypes[id], canonicalName: '90'})),
      sources: [{quote: '90', proposal: {kind: 'table_cell', tableId: 'table', cellId: 'cell', raw: '90'}}]});
  const fact = {id: 'fact', factType: 'experimental_result', subjectEntityId: null, objectEntityId: null,
    predicate: 'Original proposal', value: {raw: '90', unit: null, unitEvidence: []},
    table: {tableId: 'table', cellId: 'cell', row: 1},
    conditions: {datasetId: null, metricId: null, baselineId: null, datasetVersion: 'unknown',
      split: 'unknown', budget: 'unknown', other: {}}, conditionEvidence: [],
    evidence: [{kind: 'table_cell', tableId: 'table', cellId: 'cell', raw: '90'}], confidence: .5};
  return {schema, fact, nonnumeric: {...fact, factType: 'method_component', value: null, table: null}};
};
const set = (fact, field, value) => ['subjectEntityId', 'objectEntityId'].includes(field) ?
  {...fact, [field]: value} : {...fact, conditions: {...fact.conditions, [field]: value},
    conditionEvidence: value === null ? [] : [{field, key: null, evidence: fact.evidence}]};
test('all five Entity reference fields reject foreign IDs in numeric and nonnumeric branches', () => {
  const {schema, fact, nonnumeric} = build();
  for (const candidate of [fact, nonnumeric]) for (const field of fields) {
    assert.ok(!schema.safeParse({facts: [set(candidate, field, 'foreign-entity')]}).success,
      `${candidate.factType}.${field} must select a supplied Entity ID`);
  }
});
test('typed condition IDs and nulls remain available while numerical subjects keep stricter own-row permissions', () => {
  const {schema, fact, nonnumeric} = build();
  for (const candidate of [fact, nonnumeric]) for (const field of fields) {
    const allowed = field === 'datasetId' ? ['dataset'] : field === 'metricId' ? ['metric'] :
      field === 'baselineId' ? ['baseline'] : candidate === fact && field === 'subjectEntityId' ? ['method'] : supplied;
    for (const id of [null, ...allowed]) assert.ok(schema.safeParse({facts: [set(candidate, field, id)]}).success,
      `${candidate.factType}.${field} retains ${id}`);
  }
  assert.ok(!schema.safeParse({facts: [set(fact, 'subjectEntityId', 'other-row')]}).success);
  assert.ok(!schema.safeParse({facts: [set(fact, 'subjectEntityId', 'orphan-row-subject')]}).success,
    'Row permissions cannot authorize an ID absent from the supplied Entity domain');
  assert.ok(!schema.safeParse({facts: [fact, fact]}).success, 'Original unique proposal IDs refinement retained');
  assert.ok(!schema.safeParse({facts: [{...nonnumeric, conditions: {...nonnumeric.conditions, unsupported: true}}]}).success);
});
test('empty supplied Entity domain allows nulls and rejects all nonnull Entity references', () => {
  const {schema, fact, nonnumeric} = build([]);
  for (const candidate of [fact, nonnumeric]) {
    assert.ok(schema.safeParse({facts: [candidate]}).success);
    for (const field of fields) assert.ok(!schema.safeParse({facts: [set(candidate, field, 'method')]}).success, field);
  }
});
test('original Equation object remains evidence but cannot replace a supplied Entity reference', () => {
  const {schema, nonnumeric} = build();
  const source = {kind: 'object', objectType: 'Equation', objectId: 'equation:original'};
  const proposal = {...nonnumeric, evidence: [source]};
  assert.ok(schema.safeParse({facts: [proposal]}).success);
  assert.ok(schema.safeParse({facts: [set(proposal, 'objectEntityId', 'equation-entity')]}).success);
  assert.ok(!schema.safeParse({facts: [set(proposal, 'objectEntityId', 'equation:original')]}).success);
});
