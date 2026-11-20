import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {
  api = await importTypeScriptModule('src/main/plugins/research/scientific-fact-wire.ts',
    {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'});
});
const fields = ['datasetId', 'datasetVersion', 'split', 'metricId', 'baselineId', 'budget'];
const idFields = ['datasetId', 'metricId', 'baselineId'];
const source = {kind: 'text_span', textId: 'text-0'};
const base = () => ({
  id: 'fact', factType: 'method_component', subjectEntityId: null, objectEntityId: null,
  predicate: 'Original method uses the supplied configuration', value: null, table: null,
  conditions: {datasetId: null, datasetVersion: 'unknown', split: 'unknown',
    metricId: null, baselineId: null, budget: 'unknown', other: {}},
  conditionEvidence: [], evidence: [source], confidence: .5,
});
const quote = 'Original method uses dataset version 2 and the train split. metric baseline SGD 100 Unknown sentinel dataset.';
const entities = [['dataset', 'Dataset', 'dataset'], ['metric', 'Metric', 'metric'],
  ['baseline', 'Baseline', 'baseline'], ['unknown', 'Dataset', 'sentinel dataset']]
  .map(([id, entityType, canonicalName]) => ({id, entityType, canonicalName}));
const schema = () => api.scientificFactWireSchema({tables: []},
  {id: 'batch', blocks: [{blockId: 'block', start: 0, end: quote.length, text: quote}], objects: []},
  [], {cellHandle: (_table, cell) => cell}, entities.map(e => e.id), {entities,
    sources: [{quote, proposal: {kind: 'text', blockId: 'block', start: 0, end: quote.length, quote}}]});
const item = (field, key = null) => ({field, key, evidence: [source]});
const parsed = fact => schema().safeParse({facts: [fact]});
const known = field => idFields.includes(field) ? field.replace('Id', '') : 'version 2';

test('unknown strings and null IDs cannot carry fixed condition evidence', () => {
  for (const field of fields) {
    const fact = base(); fact.conditionEvidence = [item(field)];
    const result = parsed(fact);
    assert.equal(result.success, false, field);
    assert.ok(result.error.issues.some(issue =>
      issue.path.join('.') === 'facts.0.conditionEvidence.0'), field);
  }
});
test('each known condition needs one matching evidence entry', () => {
  for (const field of fields) {
    const fact = base(); fact.conditions[field] = known(field);
    assert.equal(parsed(fact).success, false, `${field} missing evidence`);
    fact.conditionEvidence = [item(field)];
    const result = parsed(fact);
    assert.ok(result.success, field);
    assert.deepEqual(result.data.facts[0], fact, 'Valid wire selections are never repaired or discarded');
  }
});
test('fixed condition evidence requires null keys and rejects duplicate entries', () => {
  const fact = base(); fact.conditions.split = 'train';
  fact.conditionEvidence = [item('split'), item('split')];
  assert.equal(parsed(fact).success, false);
  fact.conditionEvidence = [item('split', 'split')];
  assert.equal(parsed(fact).success, false);
  fact.conditionEvidence = [item('split')];
  assert.ok(parsed(fact).success);
});
test('other evidence needs an existing nonnull key and known value', () => {
  const fact = base();
  for (const evidence of [item('other'), item('other', 'missing')]) {
    fact.conditionEvidence = [evidence];
    assert.equal(parsed(fact).success, false);
  }
  fact.conditions.other = {optimizer: 'unknown'}; fact.conditionEvidence = [item('other', 'optimizer')];
  assert.equal(parsed(fact).success, false);
  fact.conditionEvidence = [];
  assert.equal(parsed(fact).success, false, 'Unknown other values must be omitted');
  fact.conditions.other = {optimizer: 'SGD'};
  assert.equal(parsed(fact).success, false, 'A known other key needs its evidence');
  fact.conditionEvidence = [item('other', 'optimizer')];
  assert.ok(parsed(fact).success);
  fact.conditionEvidence.push(item('other', 'optimizer'));
  assert.equal(parsed(fact).success, false);
});
test('all known fields and distinct other keys retain their exact original selections', () => {
  const fact = base();
  for (const field of fields) {
    fact.conditions[field] = known(field); fact.conditionEvidence.push(item(field));
  }
  fact.conditions.other = {optimizer: 'SGD', iterations: '100'};
  fact.conditionEvidence.push(item('other', 'optimizer'), item('other', 'iterations'));
  const result = parsed(fact);
  assert.ok(result.success);
  assert.deepEqual(result.data.facts[0], fact);
  assert.ok(parsed(base()).success, 'All unknown/null conditions without evidence remain valid');
});
test('raw sentinel handling remains exact while unsupported known strings fail at the wire boundary', () => {
  const fact = base();
  fact.conditions.datasetId = 'unknown';
  assert.ok(parsed(fact).success, 'Supplied ID literal retains the existing raw coverage exemption');
  fact.conditions.split = 'Unknown'; fact.conditionEvidence = [item('split')];
  assert.ok(parsed(fact).success, 'Only exact lowercase unknown is the string sentinel');
  fact.conditions.split = 'not present in source';
  assert.equal(parsed(fact).success, false, 'Known conditions must be mentioned by selected original evidence');
  fact.conditionEvidence = [];
  assert.equal(parsed(fact).success, false);
});
test('JSON own keys discarded by record parsing fail before the original selections can be lost', () => {
  for (const value of ['SGD', 'unknown']) {
    for (const evidence of [[], [item('other', '__proto__')]]) {
      const fact = base();
      fact.conditions.other = JSON.parse(`{"__proto__":${JSON.stringify(value)}}`);
      fact.conditionEvidence = evidence;
      const before = JSON.stringify(fact), result = parsed(fact);
      assert.equal(result.success, false, `Reject unrepresentable own key with ${value}`);
      assert.ok(result.error.issues.some(issue =>
        issue.path.join('.') === 'facts.0.conditions.other.__proto__'));
      assert.equal(JSON.stringify(fact), before, 'Incoming JSON selection must not be repaired');
      assert.ok(Object.hasOwn(fact.conditions.other, '__proto__'));
    }
  }
  const fact = base();
  fact.conditions.other = JSON.parse('{"constructor":"SGD","prototype":"100"}');
  fact.conditionEvidence = [item('other', 'constructor'), item('other', 'prototype')];
  const result = parsed(fact);
  assert.ok(result.success);
  assert.deepEqual(result.data.facts[0], fact, 'Other representable own keys retain their exact values');
});
