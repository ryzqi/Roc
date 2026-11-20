import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, extraction;
before(async () => {
  api = await loadScientificSearchApi();
  extraction = Object.assign({}, ...await Promise.all([
    'scientific-entity-extractor', 'scientific-extraction-input', 'scientific-extraction-batches',
    'scientific-extraction-pipeline', 'scientific-entity-resolution', 'scientific-extraction-repository',
    'scientific-search-snapshot', 'paper-ir-builder'
  ].map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
    {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))));
});
after(() => api?.dispose());
const config = {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
  model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'fixture'},
  inputTokens: 64000, batchTokens: 8000};
const selection = (firstToken, lastToken, evidenceIndex = 0) => ({evidenceIndex, firstToken, lastToken});
const proposal = (canonicalName, evidence, aliases = []) => ({id: 'selected-name', entityType: 'Method',
  canonicalName, aliases, attributes: {description: null}, evidence});
const extract = (ir, batch, output) => extraction.extractScientificEntities(
  {config, invoke: async () => ({entities: [output]})}, batch, ir, AbortSignal.timeout(5000));

test('entity name selections preserve original Unicode, punctuation, whitespace and split words in validated evidence', async () => {
  const f = await scientificSearchFixture(api, {embedded: false, objects: false});
  try {
    const text = 'Intro 😀\u2003Generalized expectation (GE) crite-\n ria; αβ e\u0301 终点';
    const {parseHash, ...identity} = f.ir.identity;
    const original = f.data.content.blocks.find(block => block.kind === 'paragraph' && block.reading?.role === 'body');
    assert.ok(original);
    const ir = extraction.buildPaperIR({identity, metadata: f.ir.metadata, content: {...f.data.content,
      blocks: [{...original, text}]}});
    const block = ir.blocks.find(block => block.blockId === original.id);
    const start = 'Intro '.length, quote = block.text.slice(start);
    const batch = {id: 'name-original', objects: [], blocks: [
      {blockId: block.blockId, kind: block.kind, start, end: block.text.length, text: quote, sections: []}
    ]}, before = f.db.serialize();
    const output = proposal(selection(1, 5), [{kind: 'text_span', textId: 'text-0'}], [selection(6, 7)]);
    const entities = await extract(ir, batch, output);
    assert.equal(entities[0].canonicalName, 'Generalized expectation (GE) crite-\n ria;');
    assert.deepEqual(entities[0].aliases, ['αβ e\u0301']);
    assert.deepEqual(entities[0].evidence, [{kind: 'text', blockId: block.blockId, start,
      end: block.text.length, quote}]);
    assert.equal(typeof entities[0].canonicalName, 'string', 'persisted proposal contract remains strings');
    const resolved = extraction.resolveScientificEntity(entities[0],
      {projectId: f.project.id, generationId: 'names', ir});
    assert.equal(resolved.scientificApproval, 'unreviewed');
    assert.equal(resolved.canonicalName, entities[0].canonicalName);
    assert.deepEqual(f.db.serialize(), before, 'name resolution cannot publish candidates');
  } finally {await f.close();}
});

test('all six semantic entity branches bind names and aliases to their own evidence without granting scientific approval', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const batch = extraction.buildScientificExtractionBatches(f.ir, config)
      .find(batch => batch.objects.some(object => object.objectType === 'Table'));
    const encoded = extraction.scientificExtractionInput(batch, {textSelections: true, nameSelections: true}).encode(batch);
    const table = encoded.objects.find(object => object.objectType === 'Table');
    const source = text => {
      const cell = table.content.cells.find(cell => cell.text === text);
      return {kind: 'table_cell', tableId: table.objectId, cellId: cell.id, raw: cell.text};
    };
    const before = f.db.serialize();
    for (const [entityType, attributes] of [
      ['Method', {description: null}], ['Model', {architecture: null, version: null, components: []}],
      ['Dataset', {version: null, task: null}], ['Metric', {definition: null, direction: 'unknown', unit: null}],
      ['Experiment', {configuration: null, conditions: {}}], ['Baseline', {version: null}]
    ]) {
      const [entity] = await extract(f.ir, batch, {...proposal(selection(0, 1, 1),
        [source('F1 (%)'), source('Original baseline')], [selection(0, 0)]), entityType, attributes});
      assert.equal(entity.entityType, entityType);
      assert.deepEqual(entity.attributes, attributes);
      assert.equal(entity.canonicalName, 'Original baseline');
      assert.deepEqual(entity.aliases, ['F1']);
      const resolved = extraction.resolveScientificEntity(entity, {projectId: f.project.id, generationId: 'names', ir: f.ir});
      assert.equal(resolved.scientificApproval, 'unreviewed',
        'a type and source word match cannot establish scientific meaning');
    }
    const [metadataOnly] = await extract(f.ir, batch, proposal(selection(0, 0),
      [{kind: 'metadata', field: 'title', raw: f.ir.metadata.title}]));
    assert.throws(() => extraction.resolveScientificEntity(metadataOnly,
      {projectId: f.project.id, generationId: 'names', ir: f.ir}), /name_source_required/u);
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('entity name selections reject invalid indices, strings, injected fields and wrong original evidence before later stages', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const batch = extraction.buildScientificExtractionBatches(f.ir, config)
      .find(batch => batch.objects.some(object => object.objectType === 'Table'));
    const table = batch.objects.find(object => object.objectType === 'Table');
    const codec = extraction.scientificExtractionInput(batch, {textSelections: true, nameSelections: true});
    const input = codec.encode(batch), cell = input.objects.find(object => object.objectId === table.objectId)
      .content.cells.find(cell => cell.text === 'Original baseline');
    const evidence = [{kind: 'table_cell', tableId: table.objectId, cellId: cell.id, raw: cell.text}];
    const before = f.db.serialize(), valid = proposal(selection(0, 1), evidence, [selection(1, 1)]);
    const entities = await extract(f.ir, batch, valid);
    assert.equal(entities[0].canonicalName, 'Original baseline');
    assert.deepEqual(entities[0].aliases, ['baseline']);
    for (const canonicalName of [
      'Original baseline', selection(-1, 1), selection(.5, 1), selection(0, Infinity),
      selection(1, 0), selection(0, 2), selection(0, 1, -1), selection(0, 1, .5), selection(0, 1, 1),
      {...selection(0, 1), raw: 'invented'}, {...selection(0, 1), __proto__: null, quote: 'invented'}
    ]) {
      await assert.rejects(() => extract(f.ir, batch, {...valid, canonicalName}));
    }
    await assert.rejects(() => extract(f.ir, batch, {...valid, aliases: ['invented']}));
    await assert.rejects(() => extract(f.ir, batch, {...valid, aliases: [selection(0, 99)]}));
    await assert.rejects(() => extract(f.ir, batch, {...valid, evidence: [{...evidence[0], raw: 'invented'}]}),
      /cell_invalid/u);
    const calls = [];
    const snapshots = new extraction.ScientificSearchSnapshots(f.repository, {library: f.root, index: null});
    const [paper] = await snapshots.capture(f.project.id, snapshots.catalog(f.project.id, [f.document.id]),
      AbortSignal.timeout(5000));
    const resolution = {aliases: [], targets: []};
    await assert.rejects(() => extraction.runScientificExtraction({
      ir: paper.ir, generationId: 'names-invalid', snapshot: {config, projectId: f.project.id,
        source: paper.receipt, resolution, aliasesHash: extraction.scientificResolutionHash(resolution)},
      session: {config, invoke: async call => {
        calls.push(call.name); return {entities: [{...valid, canonicalName: selection(0, 1, 99)}]};
      }}, signal: AbortSignal.timeout(5000)
    }), /(?:name_selection_invalid|too_big)/u);
    assert.deepEqual(calls, ['scientific_entities']);
    assert.ok(!calls.includes('scientific_facts') && !calls.includes('scientific_relations'));
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('entity name token inventories roundtrip complete objects and enforce whole-call budgets before dispatch', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const batch = extraction.buildScientificExtractionBatches(f.ir, config)
      .find(batch => batch.objects.some(object => object.objectType === 'Table'));
    const original = structuredClone(batch);
    const codec = extraction.scientificExtractionInput(batch, {textSelections: true, nameSelections: true});
    const encoded = codec.encode(batch);
    assert.deepEqual(encoded.blocks[0].nameTokens,
      [...batch.blocks[0].text.matchAll(/\S+/gu)].map((match, index) => [index, match[0]]));
    const table = encoded.objects.find(object => object.objectType === 'Table');
    const cell = table.content.cells.find(cell => cell.text === 'Original baseline');
    assert.deepEqual(cell.nameTokens, [[0, 'Original'], [1, 'baseline']]);
    assert.deepEqual(codec.decode(encoded), original);
    assert.deepEqual(batch, original);
    for (const change of [
      input => {input.blocks[0].nameTokens[0][1] = 'invented';},
      input => {input.objects.find(object => object.objectType === 'Table').content.cells[0].nameTokens = [];}
    ]) {
      const changed = structuredClone(encoded); change(changed);
      assert.throws(() => codec.decode(changed), /name_input_invalid/u);
    }
    let calls = 0;
    await assert.rejects(() => extraction.extractScientificEntities({config: {...config, inputTokens: 1000},
      invoke: async () => {calls++; return {entities: []};}}, batch, f.ir, AbortSignal.timeout(5000)),
    /call_budget_exceeded/u);
    assert.equal(calls, 0);
  } finally {await f.close();}
});
