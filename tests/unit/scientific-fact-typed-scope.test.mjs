import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {z} from 'zod';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {
  api = Object.assign({}, ...await Promise.all(['scientific-fact-extractor', 'scientific-extraction-input',
    'scientific-extraction-batches', 'scientific-fact-wire', 'paper-ir-builder', 'pdf-table-extractor'].map(name =>
    importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
      {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'}))));
});
const fields = [['datasetId', 'Dataset'], ['baselineId', 'Baseline'], ['metricId', 'Metric']];
const names = ['GE-FL', 'Dataset-A', 'accuracy', 'External'];
const entities = fields.flatMap(([field, entityType]) => names.map((canonicalName, index) =>
  ({id: `${field}-${index}`, entityType, canonicalName})));
const text = index => ({kind: 'text_span', textId: `text-${index}`});
const base = () => ({
  id: 'fact', factType: 'method_component', subjectEntityId: null, objectEntityId: null,
  predicate: 'Original reported observation', value: null, table: null,
  conditions: {datasetId: null, datasetVersion: 'unknown', split: 'unknown',
    metricId: null, baselineId: null, budget: 'unknown', other: {}},
  conditionEvidence: [], evidence: [text(0)], confidence: .5
});

function fixture({linked = false, partial = false, merged = false} = {}) {
  const identity = {paperId: 'paper', documentId: 'document', parseId: 'parse', knowledgeDocumentId: 'knowledge',
    sourceHash: 'a'.repeat(64), parserFingerprint: 'b'.repeat(64)};
  const html = merged ?
    '<table><tr><th>Method</th><th>accuracy</th><th>Value</th></tr>' +
      '<tr><td rowspan="2">GE-FL Dataset-A</td><td>train</td><td>0.625</td></tr>' +
      '<tr><td>test</td><td>0.750</td></tr></table>' :
    '<table><tr><th>GE-FL Dataset-A</th><th>accuracy</th></tr>' +
      '<tr><td>test</td><td>0.625</td></tr><tr><td>GE-FL Dataset-A</td><td>0.750</td></tr></table>';
  const quotes = merged ? ['Method accuracy Value GE-FL Dataset-A train 0.625 test 0.750',
    'External GE-FL Dataset-A accuracy'] :
    ['GE-FL Dataset-A accuracy test 0.625 GE-FL Dataset-A 0.750', 'External GE-FL Dataset-A accuracy'];
  const blocks = quotes.map((quote, index) => ({id: `original-${index}`,
    kind: index ? 'paragraph' : 'table', text: quote, label: index ? 'paragraph' : 'table',
    locator: 'page 1', imagePath: null,
    locations: [{page: 1, bbox: [10, 10 + 40 * index, 300, 30 + 40 * index], coordinateOrigin: 'TOPLEFT'}]}));
  blocks[0].table = api.extractPaperTable(blocks[0], {id: blocks[0].id, rawHtml: html});
  if (linked) {
    const start = partial ? quotes[1].indexOf('GE-FL') : 0;
    blocks[0].visual = {version: 'roc-paper-visual/2', id: `table:${blocks[0].id}`, blockId: blocks[0].id,
      kind: 'table', objectNumber: null, source: {...blocks[0].locations[0], locator: blocks[0].locator},
      imagePath: null, assetId: null, references: [], warnings: [],
      captions: [{status: 'linked', number: null, crossPage: false, ruleScore: 1, signals: [],
        evidence: {blockId: blocks[1].id, locator: blocks[1].locator, text: quotes[1].slice(start),
          textSpan: {start, end: quotes[1].length}, locations: blocks[1].locations}}]};
  }
  const ir = api.buildPaperIR({identity, content: {sourceHash: identity.sourceHash,
    parserFingerprint: identity.parserFingerprint, blocks, quality: {version: 'roc-paper-quality/1',
      coverageDefinition: 'clipped-rectangle-union/measured-page-area', pages: [], status: 'good', failure: null}},
    metadata: {title: 'External GE-FL Dataset-A accuracy', authors: [], doi: null, year: null, origin: 'library'}});
  const objects = api.buildScientificExtractionBatches(ir, {
    extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
    model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'fixture/1'},
    inputTokens: 64000, batchTokens: 8000}).flatMap(batch => batch.objects);
  const batch = {id: 'batch', blocks: ir.blocks.map(block => ({blockId: block.blockId, kind: block.kind,
    start: 0, end: block.text.length, text: block.text, sections: []})),
    objects};
  return {ir, batch};
}
const extract = (f, invoke) => api.extractScientificFacts({config: {inputTokens: 64000}, invoke},
  f.batch, f.ir, entities, new AbortController().signal);
const conditioned = (fact, field, index, evidence) => ({...structuredClone(fact),
  conditions: {...fact.conditions, [field]: `${field}-${index}`},
  conditionEvidence: [{field, key: null, evidence}]});
const numeric = (input, raw = '0.625') => {
  const table = input.batch.objects[0], cell = table.content.cells.find(cell => cell.text === raw);
  assert.ok(cell);
  const evidence = {kind: 'table_cell', tableId: table.objectId, cellId: cell.id, raw: cell.text};
  return {...base(), factType: 'experimental_result', table: {tableId: table.objectId, row: cell.row, cellId: cell.id},
    value: {raw, unit: null, unitEvidence: []}, evidence: [evidence]};
};
const choice = (input, raw, row) => {
  const cells = row === undefined ? null : input.resultEvidenceScopes[0].rows.find(item => item.row === row).conditionCellIds;
  return input.conditionTokenChoices.sources.find(source =>
    source.evidence.kind === 'table_cell' && source.evidence.raw === raw &&
    (!cells || cells.includes(source.evidence.cellId))).evidence;
};
const numericBranch = (json, row) => json.properties.facts.items.anyOf.find(branch =>
  branch.properties.table?.properties?.row?.const === row);

test('Full17 pattern rejects whole-table, metadata and unlinked prose at the actual extractor wire', async () => {
  const f = fixture(), before = structuredClone(f);
  const output = await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content), fact = numeric(input);
    const whole = {kind: 'object', objectType: 'Table', objectId: fact.table.tableId};
    for (const [field] of fields) for (const evidence of [[whole], [text(0)], [text(1)],
      [{kind: 'metadata', field: 'title', raw: f.ir.metadata.title}]]) {
      const invalid = conditioned(fact, field, 0, evidence), saved = structuredClone(invalid);
      assert.equal(call.schema.safeParse({facts: [invalid]}).success, false, `${field}/${evidence[0].kind}`);
      assert.deepEqual(invalid, saved, 'Denied selections are never repaired');
    }
    return {facts: [fact]};
  });
  assert.equal(output[0].conditions.baselineId, null);
  assert.deepEqual(f, before);
});

test('provider schema narrows typed IDs per row and reserves declared headers for Metric', async () => {
  const f = fixture();
  await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content), fact = numeric(input);
    const branch = numericBranch(z.toJSONSchema(call.schema), fact.table.row);
    assert.ok(branch);
    for (const field of ['datasetId', 'baselineId']) {
      assert.deepEqual(branch.properties.conditions.properties[field], {type: 'null'});
      assert.ok(!branch.properties.conditionEvidence.items.anyOf.some(item => item.properties.field.const === field));
      const candidate = conditioned(fact, field, 2, [choice(input, 'accuracy')]);
      assert.equal(call.schema.safeParse({facts: [candidate]}).success, false, 'Dataset/Baseline cannot borrow metric headers');
    }
    const metric = branch.properties.conditions.properties.metricId;
    assert.deepEqual(metric.anyOf[0].enum, ['metricId-0', 'metricId-1', 'metricId-2'],
      'Metric keeps the declared table-header union; native validation still checks the actual value column');
    const valid = conditioned(fact, 'metricId', 2, [choice(input, 'accuracy')]);
    assert.deepEqual(call.schema.parse({facts: [valid]}).facts[0], valid);
    for (const field of ['datasetId', 'baselineId']) {
      const ownFact = numeric(input, '0.750');
      const own = conditioned(ownFact, field, 0, [choice(input, 'GE-FL Dataset-A', ownFact.table.row)]);
      assert.ok(call.schema.safeParse({facts: [own]}).success, 'The same name remains selectable in its actual row');
    }
    return {facts: [valid]};
  });
});

test('typed evidence retains own-row/merged anchors and rejects any extra unlinked source', async () => {
  const f = fixture({merged: true}), before = structuredClone(f);
  const result = await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content), fact = numeric(input, '0.750');
    const anchor = choice(input, 'GE-FL Dataset-A');
    const value = f.ir.tables[0].cells.find(cell => cell.text === '0.750');
    const originalAnchor = f.ir.tables[0].cells.find(cell => cell.text === anchor.raw);
    assert.ok(originalAnchor.row < value.row, 'This exercises an actual spanning anchor');
    const facts = [];
    for (const [field] of fields.slice(0, 2)) {
      const valid = conditioned(fact, field, 0, [anchor]);
      assert.ok(call.schema.safeParse({facts: [valid]}).success);
      const extra = conditioned(fact, field, 0, [anchor, text(1)]);
      assert.equal(call.schema.safeParse({facts: [extra]}).success, false, 'Every retained source needs permission');
      const orphan = structuredClone(valid); orphan.conditions[field] = null;
      assert.equal(call.schema.safeParse({facts: [orphan]}).success, false);
      const missing = structuredClone(valid); missing.conditionEvidence = [];
      assert.equal(call.schema.safeParse({facts: [missing]}).success, false);
      facts.push({...valid, id: field});
    }
    return {facts};
  });
  assert.equal(result.length, 2);
  assert.deepEqual(f, before);
});

test('typed numeric scope is enforced when no string-token contract is supplied', async () => {
  const f = fixture();
  await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content);
    const codec = api.scientificExtractionInput(f.batch, {textSelections: true});
    const scopes = codec.decode({resultEvidenceScopes: input.resultEvidenceScopes}).resultEvidenceScopes;
    const schema = api.scientificFactWireSchema(f.ir, f.batch, scopes, codec, entities.map(entity => entity.id),
      {entities, sources: api.scientificFactConditionSources(f.ir, f.batch)});
    const fact = numeric(input);
    assert.equal(schema.safeParse({facts: [conditioned(fact, 'baselineId', 0, [text(0)])]}).success, false);
    const ownFact = numeric(input, '0.750');
    assert.equal(schema.safeParse({facts: [conditioned(ownFact, 'baselineId', 0,
      [choice(input, 'GE-FL Dataset-A', ownFact.table.row)])]}).success, true);
    return {facts: []};
  });
});

test('linked complete text remains typed evidence while a partially linked interval cannot authorize the whole text', async () => {
  for (const partial of [false, true]) {
    const f = fixture({linked: true, partial});
    const facts = await extract(f, async call => {
      const input = JSON.parse(call.messages[1].content), fact = numeric(input);
      const scope = input.resultEvidenceScopes[0];
      assert.ok(scope.linkedTextRanges.some(range => range.blockId === f.batch.blocks[1].blockId));
      for (const [field] of fields) {
        const candidate = conditioned(fact, field, 3, [text(1)]);
        assert.equal(call.schema.safeParse({facts: [candidate]}).success, !partial, field);
      }
      return {facts: [partial ? fact : conditioned(fact, 'baselineId', 3, [text(1)])]};
    });
    assert.equal(facts[0].conditions.baselineId, partial ? null : 'baselineId-3');
  }
});

test('nonnumeric typed sources remain selectable and complete user payloads are preserved', async () => {
  const f = fixture(), before = structuredClone(f);
  const output = await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content);
    const {conditionTokenChoices, ...complete} = input;
    assert.ok(conditionTokenChoices);
    const decoded = api.scientificExtractionInput(f.batch, {textSelections: true}).decode(complete);
    const eligible = entities.filter(entity => ['Method', 'Model', 'Baseline', 'Experiment'].includes(entity.entityType));
    const expectedSubjects = [...new Set(f.ir.tables.flatMap(table => {
      const cells = table.cells;
      return eligible.filter(entity => cells.some(cell => cell.text.split(/\s+/u).includes(entity.canonicalName)))
        .map(entity => entity.id);
    }))];
    assert.deepEqual(decoded.resultSubjectEntityIds, expectedSubjects);
    assert.deepEqual(decoded.metadata, f.ir.metadata);
    assert.deepEqual(decoded.batch, f.batch);
    assert.deepEqual(decoded.entities, entities);
    assert.deepEqual(Object.keys(decoded).sort(),
      ['batch', 'entities', 'metadata', 'resultEvidenceScopes', 'resultSubjectEntityIds']);
    const fact = conditioned(base(), 'baselineId', 3, [text(1)]);
    assert.deepEqual(call.schema.parse({facts: [fact]}).facts[0], fact);
    return {facts: [fact]};
  });
  assert.equal(output[0].conditions.baselineId, 'baselineId-3');
  assert.deepEqual(f, before);
});
