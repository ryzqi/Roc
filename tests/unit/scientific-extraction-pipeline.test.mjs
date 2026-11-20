import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, pipeline;
before(async () => {
  api = await loadScientificSearchApi();
  pipeline = Object.assign({}, ...await Promise.all(['scientific-extraction-pipeline', 'scientific-extraction-batches',
    'scientific-extraction-model', 'scientific-extraction-input', 'scientific-entity-extractor', 'scientific-extraction-repository', 'scientific-search-snapshot',
    'scientific-fact-validator', 'paper-ir-builder']
    .map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))));
});
after(() => api?.dispose());
const extractionConfig = () => ({extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
  model: {provider: 'fixture', modelId: 'fixture-model', model: 'fixture-model', revision: 'revision/1'},
  inputTokens: 32_000, batchTokens: 8000});
const cell = (table, value) => {
  const original = table.content.cells.find(cell => cell.text === value);
  assert.ok(original);
  return {kind: 'table_cell', tableId: table.objectId, cellId: original.id, raw: original.text};
};
const entity = (id, entityType, canonicalName, evidence, attributes) =>
  ({id, entityType, canonicalName: {evidenceIndex: 0, firstToken: 0,
    lastToken: canonicalName.match(/\S+/gu).length - 1}, evidence, attributes, aliases: []});
const unknown = () => ({datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
  baselineId: null, budget: 'unknown', other: {}});

/** Deterministic proposals test engineering/source contracts, not model accuracy or scientific gold. */
function proposals(call) {
  const input = JSON.parse(call.messages[1].content), {batch} = input;
  const table = batch.objects.find(object => object.objectType === 'Table');
  if (call.name === 'scientific_entities') {
    const entities = [];
    if (table) entities.push(
      entity('local-method', 'Method', 'Original baseline', [cell(table, 'Original baseline')], {description: null}),
      entity('local-metric', 'Metric', 'F1', [cell(table, 'F1 (%)')], {definition: null, direction: 'unknown', unit: '%'}),
      {id: 'local-table', entityType: 'Table', objectId: table.objectId});
    for (const object of batch.objects.filter(object => object.objectType === 'Equation')) {
      entities.push({id: 'local-equation', entityType: 'Equation', objectId: object.objectId});
    }
    return {entities};
  }
  if (call.name === 'scientific_facts') {
    if (!table) return {facts: []};
    const method = input.entities.find(entity => entity.entityType === 'Method'),
      metric = input.entities.find(entity => entity.entityType === 'Metric');
    const value = cell(table, '90');
    return {facts: [{id: 'local-result', factType: 'experimental_result', subjectEntityId: method.id,
      predicate: 'Reported F1 value', objectEntityId: null, value: {raw: '90', unit: null, unitEvidence: []},
      conditions: {...unknown(), metricId: metric.id},
      conditionEvidence: [{field: 'metricId', key: null, evidence: [cell(table, 'F1 (%)')]}],
      table: {tableId: table.objectId, cellId: value.cellId, row: 1},
      evidence: [value, cell(table, 'Original baseline')], confidence: .8}]};
  }
  assert.equal(call.name, 'scientific_relations');
  if (!table) return {relations: []};
  return {relations: [{id: 'local-relation', type: 'PROPOSES',
    fromEntityId: input.entities.find(entity => entity.entityType === 'Paper').id,
    toEntityId: input.entities.find(entity => entity.entityType === 'Method').id,
    factIds: input.facts.map(fact => fact.id), evidence: [cell(table, 'Original baseline')]}]};
}
async function captured(f, config = extractionConfig()) {
  const snapshots = new pipeline.ScientificSearchSnapshots(f.repository, {library: f.root, index: null});
  const papers = await snapshots.capture(f.project.id, snapshots.catalog(f.project.id, [f.document.id]),
    new AbortController().signal);
  const paper = papers.find(paper => paper.ir.identity.documentId === f.document.id), resolution = {aliases: [], targets: []};
  return {paper, snapshot: {projectId: f.project.id, source: paper.receipt, config, resolution,
    aliasesHash: pipeline.scientificResolutionHash(resolution)}};
}
const run = (capture, invoke = async call => proposals(call), extra = {}) => pipeline.runScientificExtraction({
  ...capture, ir: capture.paper.ir, generationId: 'pipeline-generation',
  session: {config: capture.snapshot.config, invoke}, signal: new AbortController().signal, ...extra
});

test('entity text selections retain exact supplied intervals and reject foreign handles or rewritten quotes', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const config = extractionConfig(), body = f.ir.blocks.find(block => block.blockId === 'body');
    const start = 1, end = body.text.length, originalText = body.text.slice(start, end);
    const batch = {id: 'selection-batch', objects: [], blocks: [
      {blockId: body.blockId, kind: body.kind, start, end, text: originalText, sections: []}
    ]}, before = f.db.serialize();
    const invoke = change => async call => {
      const input = JSON.parse(call.messages[1].content);
      assert.equal(input.batch.blocks[0].textId, 'text-0');
      assert.equal(input.batch.blocks[0].text, originalText);
      return {entities: [entity('selected-text', 'Method', originalText.split(' ')[0],
        [change({kind: 'text_span', textId: 'text-0'})], {description: null})]};
    };
    const extracted = await pipeline.extractScientificEntities({config, invoke: invoke(value => value)},
      batch, f.ir, AbortSignal.timeout(5000));
    assert.deepEqual(extracted[0].evidence, [{kind: 'text', blockId: body.blockId, start, end, quote: originalText}]);
    for (const change of [value => ({...value, textId: 'foreign'}),
      value => ({...value, quote: 'rewritten'}), value => ({...value, start: 0}),
      () => ({kind: 'text', blockId: body.blockId, start, end, quote: originalText})]) {
      await assert.rejects(() => pipeline.extractScientificEntities({config, invoke: invoke(change)},
        batch, f.ir, AbortSignal.timeout(5000)));
    }
    const unicode = {blocks: [{blockId: 'unicode', kind: 'paragraph', start: 3, end: 9,
      text: '😀x\n y', sections: []}], objects: []};
    const codec = pipeline.scientificExtractionInput(unicode, {textSelections: true});
    assert.deepEqual(codec.decode(codec.encode(unicode)), unicode);
    assert.deepEqual(codec.decode({kind: 'text_span', textId: 'text-0'}),
      {kind: 'text', blockId: 'unicode', start: 3, end: 9, quote: '😀x\n y'});
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('result evidence scopes retain empty table objects and reject invalid nonempty text intervals', async () => {
  const f = await scientificSearchFixture(api, {embedded: false, emptyTableText: true});
  try {
    const capture = await captured(f), ir = capture.paper.ir, table = ir.tables[0];
    const block = ir.blocks.find(block => block.blockId === table.blockId);
    assert.equal(block.text, '');
    const before = f.db.serialize(), result = await run(capture);
    assert.equal(result.knowledge.facts[0].value.raw, '90');
    const scope = pipeline.scientificResultEvidenceScope(ir, table.id, [{blockId: block.blockId, start: 0, end: 0}]);
    assert.deepEqual(scope.linkedTextRanges, [], 'Empty object text supplies no condition evidence');
    const body = ir.blocks.find(block => block.blockId === 'body');
    for (const [start, end] of [[0, 0], [-1, 1], [0, body.text.length + 1], [.5, 1], [0, NaN]]) {
      assert.throws(() => pipeline.scientificResultEvidenceScope(ir, table.id, [{blockId: body.blockId, start, end}]),
        /research_scientific_fact_quote_invalid/u);
    }
    const caption = table.visual.captions.find(caption => caption.status === 'linked'), span = caption.evidence.textSpan;
    const captionScope = pipeline.scientificResultEvidenceScope(ir, table.id, [{
      blockId: caption.evidence.blockId, start: span.start + 1, end: span.end - 1
    }]);
    assert.deepEqual(captionScope.linkedTextRanges, [{
      blockId: caption.evidence.blockId, start: span.start + 1, end: span.end - 1
    }], 'Caption permissions stay within the supplied original interval');
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('independent named structured calls retain full objects, real cells and program-owned cross-stage IDs', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), calls = [], observed = [], before = f.db.serialize();
    const result = await run(capture, async call => {calls.push(call); return proposals(call);}, {
      observe: async (stage, batch, operation) => {observed.push({stage, id: batch.id}); await operation();}
    });
    assert.equal(result.calls, result.batches * 3);
    assert.equal(calls.length, result.calls); assert.equal(observed.length, result.calls);
    assert.ok(calls.slice(0, result.batches).every(call => call.name === 'scientific_entities'));
    assert.ok(calls.slice(result.batches, result.batches * 2).every(call => call.name === 'scientific_facts'));
    assert.ok(calls.slice(result.batches * 2).every(call => call.name === 'scientific_relations'));
    assert.equal(result.knowledge.facts.length, 1);
    const fact = result.knowledge.facts[0];
    assert.equal(fact.value.raw, '90'); assert.equal(fact.value.normalized, '0.9');
    assert.equal(fact.value.unit, 'ratio'); assert.equal(fact.conditions.split, 'unknown');
    assert.equal(fact.table.cellId, f.ir.tables[0].cells.find(cell => cell.text === '90').id);
    assert.ok([...result.candidates.entities, ...result.candidates.facts, ...result.candidates.relations]
      .every(candidate => candidate.id.startsWith('scientific-') && !candidate.id.startsWith('local-')));
    assert.equal(result.knowledge.relations[0].factIds[0], fact.id);
    assert.ok([...result.knowledge.entities, ...result.knowledge.facts, ...result.knowledge.relations]
      .every(item => item.scientificApproval === 'unreviewed'));
    const tableInput = calls.map(call => JSON.parse(call.messages[1].content)).find(input =>
      input.batch.objects.some(object => object.objectType === 'Table')).batch;
    const table = tableInput.objects[0];
    assert.deepEqual(table.content.cells.map(cell => cell.text), f.ir.tables[0].cells.map(cell => cell.text));
    assert.equal(table.content.cells.find(cell => cell.text === 'Original baseline').rowSpan, 2);
    assert.ok(tableInput.blocks.some(block => block.text === 'Table 3: Dataset C results.'));
    const equation = calls.map(call => JSON.parse(call.messages[1].content)).flatMap(input => input.batch.objects)
      .find(object => object.objectType === 'Equation');
    assert.equal(equation.content.rawLatex, f.ir.equations[0].data.rawLatex);
    assert.deepEqual(equation.content.contexts, f.ir.equations[0].data.contexts);
    assert.deepEqual(f.db.serialize(), before, 'pure extraction does not write claims, evidence or generations');
    const repeat = await run(capture);
    assert.deepEqual(repeat.candidates, result.candidates);
  } finally {await f.close();}
});

test('structural entity selections resolve complete originals and reject changed identity or attributes', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), before = f.db.serialize();
    const selected = (input, change = selection => selection) => ({entities: input.objectEntities.map((original, index) =>
      change({id: `selected-${index}`, entityType: original.entityType, objectId: original.attributes.objectId}))});
    const result = await run(capture, async call => call.name === 'scientific_entities' ?
      selected(JSON.parse(call.messages[1].content)) : {[call.name === 'scientific_facts' ? 'facts' : 'relations']: []});
    const objects = result.candidates.entities.filter(entity => 'objectId' in entity.attributes);
    const ir = capture.paper.ir;
    assert.equal(objects.length, ir.tables.length + ir.equations.length + ir.figures.length + ir.algorithms.length);
    for (const object of objects) {
      assert.deepEqual(object.evidence, [{kind: 'object', objectType: object.entityType, objectId: object.attributes.objectId}]);
      if (object.entityType === 'Equation') {
        const original = ir.equations.find(eq => eq.id === object.attributes.objectId);
        assert.equal(object.attributes.latex, original.data.rawLatex);
        assert.equal(object.attributes.number, original.data.equationNumber);
      }
    }
    assert.deepEqual(f.db.serialize(), before);
    for (const change of [selection => ({...selection, objectId: 'foreign-object'}),
      selection => ({...selection, attributes: {number: 'invented'}}),
      selection => ({...selection, canonicalName: 'invented'})]) {
      await assert.rejects(() => run(capture, async call => call.name === 'scientific_entities' ?
        selected(JSON.parse(call.messages[1].content), change) :
        {[call.name === 'scientific_facts' ? 'facts' : 'relations']: []}));
    }
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('wrong values and unseen sources fail at their stage before any later stage or publication', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), calls = [];
    await assert.rejects(() => run(capture, async call => {
      calls.push(call.name); const output = proposals(call);
      if (output.facts?.length) output.facts[0].value.raw = '99';
      return output;
    }), error => error.name === 'ZodError' && JSON.stringify(error.issues).includes('"raw"'));
    assert.ok(!calls.includes('scientific_relations'));
    await assert.rejects(() => run(capture, async call => {
      const output = proposals(call), input = JSON.parse(call.messages[1].content);
      if (input.batch.objects.some(object => object.objectType === 'Table') && output.entities) {
        output.entities[0].evidence = [{kind: 'text_span', textId: 'foreign'}];
      }
      return output;
    }), /text_not_supplied/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_facts').pluck().get(), 0);
  } finally {await f.close();}
});

test('original object identities guide proposals while cell-only evidence and invented names still stop the pipeline', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), before = f.db.serialize();
    const result = await run(capture, async call => {
      if (call.name !== 'scientific_entities') return {[call.name === 'scientific_facts' ? 'facts' : 'relations']: []};
      const input = JSON.parse(call.messages[1].content);
      assert.equal(input.objectEntities.length, input.batch.objects.length);
      return {entities: input.objectEntities.map((constraint, index) => {
        const object = input.batch.objects.find(object => object.objectId === constraint.attributes.objectId);
        assert.ok(object);
        if (object.objectType === 'Table') {
          assert.equal(constraint.canonicalName, 'Table 3');
          assert.equal(constraint.attributes.number, '3');
        }
        if (object.objectType === 'Equation') {
          assert.equal(constraint.canonicalName, 'Equation 7');
          assert.equal(constraint.attributes.latex, f.ir.equations[0].data.rawLatex);
        }
        assert.deepEqual(constraint.requiredEvidence, {kind: 'object', objectType: object.objectType, objectId: object.objectId});
        return {id: `object-${index}`, entityType: constraint.entityType, objectId: constraint.attributes.objectId};
      })};
    });
    assert.ok(result.knowledge.entities.some(entity => entity.entityType === 'Table' && entity.resolutionStatus === 'exact'));
    for (const corruption of ['cell-only', 'invented-name']) {
      const calls = [];
      await assert.rejects(() => run(capture, async call => {
        calls.push(call.name);
        const output = proposals(call);
        if (call.name === 'scientific_entities') {
          const table = JSON.parse(call.messages[1].content).batch.objects.find(object => object.objectType === 'Table');
          const candidate = output.entities.find(entity => entity.entityType === 'Table');
          if (candidate) {
            if (corruption === 'cell-only') candidate.evidence = [cell(table, 'Original baseline')];
            else candidate.canonicalName = 'Table 1';
          }
        }
        return output;
      }), error => error.name === 'ZodError');
      assert.ok(calls.every(name => name === 'scientific_entities'));
    }
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('numeric result guidance retains exact rows and typed subjects while three independent corruptions stop relations', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), before = f.db.serialize();
    const inspect = call => {
      if (call.name !== 'scientific_facts') return;
      const input = JSON.parse(call.messages[1].content);
      assert.deepEqual(input.resultSubjectEntityIds, [...new Set(input.resultEvidenceScopes.flatMap(scope =>
        scope.rows.flatMap(row => row.subjects.map(subject => subject.entityId))))]);
      const table = input.batch.objects.find(object => object.objectType === 'Table');
      if (table) {
        const scope = input.resultEvidenceScopes.find(scope => scope.tableId === table.objectId);
        const method = cell(table, 'Original baseline'), header = cell(table, 'F1 (%)');
        assert.ok(scope.rows.find(row => row.row === 1).conditionCellIds.includes(method.cellId));
        assert.ok(scope.rows.find(row => row.row === 2).conditionCellIds.includes(method.cellId),
          'Original merged anchor spans the second result row');
        assert.ok(!scope.rows.find(row => row.row === 1).conditionCellIds.includes(header.cellId),
          'Column heading cannot support arbitrary conditions outside its own row');
        assert.ok(scope.metricHeaders.find(column => column.column === 1).cellIds.includes(header.cellId));
        assert.match(call.messages[0].content, /resultEvidenceScopes enumerates the only allowed condition evidence/u);
      }
      assert.match(call.messages[0].content, /table\.row must equal the cited value cell's zero-based row/u);
      assert.match(call.messages[0].content, /Only metricId may use the result column's declared headerCellIds/u);
      assert.match(call.messages[0].content, /Never use Table, Figure, Equation, Paper, Dataset or Metric as a numeric result subject/u);
    };
    const valid = await run(capture, async call => {inspect(call); return proposals(call);});
    assert.equal(valid.knowledge.facts.length, 1);
    const missing = await run(capture, async call => {
      inspect(call);
      const output = proposals(call);
      if (output.facts?.length) output.facts[0].subjectEntityId = null;
      return output;
    });
    assert.equal(missing.knowledge.facts[0].subjectEntityId, null);
    const wireRejects = field => error => error.name === 'ZodError' &&
      JSON.stringify(error.issues).includes(`"${field}"`);
    const table = capture.paper.ir.tables[0], native = structuredClone(valid.candidates.facts[0]);
    native.conditions.other.column = 'F1 (%)';
    native.conditionEvidence.push({field: 'other', key: 'column',
      evidence: [{kind: 'table_cell', tableId: table.id,
        cellId: table.cells.find(cell => cell.text === 'F1 (%)').id, raw: 'F1 (%)'}]});
    assert.throws(() => pipeline.validateScientificFact(native, {ir: capture.paper.ir,
      projectId: capture.snapshot.projectId, generationId: 'pipeline-generation'}, valid.knowledge.entities),
    /fact_condition_scope_invalid/u, 'The unchanged native validator independently rejects column conditions');
    for (const [corruption, error] of [['table-subject', wireRejects('subjectEntityId')],
      ['other-column', wireRejects('other')], ['wrong-row', wireRejects('row')]]) {
      const names = [];
      await assert.rejects(() => run(capture, async call => {
        names.push(call.name); inspect(call);
        const output = proposals(call);
        if (output.facts?.length) {
          const input = JSON.parse(call.messages[1].content), fact = output.facts[0];
          if (corruption === 'table-subject') fact.subjectEntityId = input.entities.find(entity => entity.entityType === 'Table').id;
          if (corruption === 'other-column') {
            const table = input.batch.objects.find(object => object.objectType === 'Table');
            const evidence = cell(table, 'F1 (%)'), choice = input.conditionTokenChoices.sources.find(choice =>
              JSON.stringify(choice.evidence) === JSON.stringify(evidence));
            fact.conditions.other.column = {sourceId: choice.sourceId, firstToken: 0, lastToken: choice.tokenCount - 1};
            fact.conditionEvidence.push({field: 'other', key: 'column', evidence: [evidence]});
          }
          if (corruption === 'wrong-row') fact.table.row = 2;
        }
        return output;
      }), error);
      assert.ok(!names.includes('scientific_relations'));
    }
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('condition contradictions stop custom and production invokers before relations or publication', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), before = f.db.serialize();
    for (const adapter of ['custom', 'production']) {
      const names = [], originals = [];
      const contradictory = call => {
        names.push(call.name);
        const output = proposals(call);
        if (output.facts?.length) {
          output.facts[0].conditionEvidence.push({
            field: 'datasetVersion', key: null, evidence: output.facts[0].evidence
          });
          originals.push(structuredClone(output));
        }
        return output;
      };
      const handle = {
        provider: {id: 'fixture', type: 'openai_compatible', endpoint: 'https://fixture.invalid',
          options: {}, models: [{id: 'fixture-model', options: {}}]},
        modelId: 'fixture-model', runtime: {contextWindowTokens: 64000, maxOutputTokens: 6000},
        model: {withStructuredOutput: (_schema, options) => ({invoke: async messages => ({
          raw: {response_metadata: {}}, parsed: contradictory({name: options.name, messages})
        })})}
      };
      const session = adapter === 'production' ?
        await pipeline.createScientificExtractionSessionFactory({createDefaultChatModel: async () => handle})() :
        {invoke: async call => contradictory(call)};
      await assert.rejects(() => run(capture, session.invoke), error => adapter === 'production' ?
        error.message === 'research_scientific_extraction_output_invalid' :
        error.name === 'ZodError' && error.issues.some(issue =>
          issue.path.join('.') === 'facts.0.conditionEvidence.1'));
      assert.equal(originals.length, 1);
      assert.equal(originals[0].facts[0].conditions.datasetVersion, 'unknown');
      assert.equal(originals[0].facts[0].conditionEvidence.length, 2,
        'The original contradiction is rejected without removing its evidence');
      assert.ok(!names.includes('scientific_relations'));
      assert.deepEqual(f.db.serialize(), before, 'No knowledge, evidence or generation is published');
    }
  } finally {await f.close();}
});

test('table-local handles and declared defaults round-trip complete sources without rewriting raw strings', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const batches = pipeline.buildScientificExtractionBatches(f.ir, extractionConfig());
    const batch = batches.find(batch => batch.objects.some(object => object.objectType === 'Table'));
    const original = structuredClone(batch), codec = pipeline.scientificExtractionInput(batch);
    const encoded = codec.encode(batch), table = encoded.objects[0], canonical = batch.objects[0];
    assert.deepEqual(codec.decode(encoded), original);
    assert.deepEqual(batch, original);
    assert.ok(table.content.cells.every(cell => /^cell-\d+$/u.test(cell.id)));
    assert.ok(table.content.rows.every(row => row.cells.every(id => /^cell-\d+$/u.test(id))));
    assert.deepEqual(table.content.cellDefaults, {rowSpan: 1, colSpan: 1, header: false});
    const source = {kind: 'table_cell', tableId: canonical.objectId, cellId: canonical.content.cells[0].id,
      raw: canonical.content.cells[0].id};
    const projected = codec.encode(source);
    assert.equal(projected.raw, source.raw, 'quoted text is never an identifier substitution target');
    assert.equal(projected.cellId, 'cell-0');
    assert.deepEqual(codec.decode(projected), source);
    assert.throws(() => codec.decode({...projected, cellId: 'cell-999999'}), /cell_not_supplied/u);
    const foreign = {...projected, tableId: 'foreign-table'};
    assert.throws(() => pipeline.assertScientificBatchSources(batch, [codec.decode(foreign)], f.ir), /source_not_supplied/u);
    const changed = {...projected, raw: 'invented value'};
    assert.throws(() => pipeline.assertScientificBatchSources(batch, [codec.decode(changed)], f.ir), /cell_invalid/u);
    const badDefaults = structuredClone(encoded); badDefaults.objects[0].content.cellDefaults.rowSpan = 2;
    assert.throws(() => codec.decode(badDefaults), /table_input_invalid/u);
    const extra = codec.decode(JSON.parse('{"__proto__":{"invented":true},"entities":[]}'));
    assert.ok(Object.hasOwn(extra, '__proto__'), 'unknown output keys survive decoding for strict schema rejection');
    assert.equal(extra.invented, undefined);
    const second = structuredClone(canonical); second.objectId = 'second-table';
    second.content.cells = second.content.cells.map(cell => ({...cell, id: `second-${cell.id}`}));
    second.content.rows = second.content.rows.map(row => ({...row, cells: row.cells.map(id => `second-${id}`)}));
    second.content.columns = second.content.columns.map(column =>
      ({...column, headerCellIds: column.headerCellIds.map(id => `second-${id}`)}));
    const pair = {...batch, objects: [canonical, second]}, pairedCodec = pipeline.scientificExtractionInput(pair);
    assert.deepEqual(pairedCodec.decode(pairedCodec.encode(pair)), pair);
    assert.equal(pairedCodec.decode({...projected, tableId: second.objectId}).cellId, second.content.cells[0].id);
    assert.deepEqual(f.db.prepare('SELECT count(*) FROM research_paper_facts').pluck().get(), 0);
  } finally {await f.close();}
});

test('model authority, missing references and duplicate local IDs are rejected instead of remapped into success', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f);
    for (const change of [
      output => {output.entities[0].projectId = 'foreign';},
      output => {output.entities.push(output.entities[0]);}
    ]) {
      await assert.rejects(() => run(capture, async call => {
        const output = proposals(call); if (output.entities?.length) change(output); return output;
      }));
    }
    await assert.rejects(() => run(capture, async call => {
      const output = proposals(call);
      if (output.facts?.length) output.facts[0].objectEntityId = 'local-method';
      return output;
    }), error => error.name === 'ZodError' && JSON.stringify(error.issues).includes('"objectEntityId"'),
    'Foreign Entity reference is rejected at the wire boundary before later extraction stages');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_facts').pluck().get(), 0);
  } finally {await f.close();}
});

test('abort and a changed source/config fence stop the pipeline at the async boundary', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f), controller = new AbortController();
    let calls = 0;
    await assert.rejects(() => run(capture, async call => {
      calls++; controller.abort(new Error('extraction_cancelled')); return proposals(call);
    }, {signal: controller.signal}), /extraction_cancelled/u);
    assert.equal(calls, 1);
    let checks = 0; calls = 0;
    await assert.rejects(() => run(capture, async call => {calls++; return proposals(call);}, {
      assertCurrent: async () => {if (++checks === 2) throw new Error('original_source_changed');}
    }), /original_source_changed/u);
    assert.equal(calls, 1);
    const changed = {...capture.snapshot.config, promptVersion: 'changed'};
    await assert.rejects(() => run(capture, async call => proposals(call),
      {session: {config: changed, invoke: async call => proposals(call)}}), /input_changed/u);
  } finally {await f.close();}
});

test('complete objects and combined prompt/schema context exceed budgets explicitly with no truncated calls', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const capture = await captured(f, {...extractionConfig(), inputTokens: 1000, batchTokens: 500});
    const tableBlock = capture.paper.ir.blocks.find(block => block.blockId === capture.paper.ir.tables[0].blockId);
    tableBlock.text += '\nUnchanged original table context. '.repeat(300);
    // Rebuild identities from source objects; the complete linked table context must exceed even compact encoding.
    const {parseHash, ...identity} = f.ir.identity;
    const original = f.data.content.blocks.find(block => block.id === tableBlock.blockId);
    capture.paper.ir = pipeline.buildPaperIR({identity, content: {...f.data.content,
      blocks: f.data.content.blocks.map(block => block === original ? {...block, text: tableBlock.text} : block)},
      metadata: f.ir.metadata});
    let calls = 0;
    await assert.rejects(() => run(capture, async () => {calls++; return {entities: []};}), /object_budget_exceeded/u);
    assert.equal(calls, 0);
    const small = await captured(f, {...extractionConfig(), inputTokens: 1000});
    await assert.rejects(() => run(small, async () => {calls++; return {entities: []};}), /call_budget_exceeded/u);
    assert.equal(calls, 0);
    const batches = pipeline.buildScientificExtractionBatches(f.ir, extractionConfig());
    const table = batches.find(batch => batch.objects.some(object => object.objectType === 'Table'));
    assert.deepEqual(table.objects[0].content.footnotes, f.ir.tables[0].data.footnotes);
    assert.equal(table.objects.length, 1);
  } finally {await f.close();}
});

test('ordinary Unicode prose batches preserve all absolute intervals without splitting surrogate pairs', async () => {
  const f = await scientificSearchFixture(api, {objects: false, embedded: false});
  try {
    const original = f.data.content.blocks.find(block => block.kind === 'paragraph' && block.reading?.role === 'body'),
      long = 'Original 文本 🧪 e\u0301. '.repeat(900);
    assert.ok(original, 'the Unicode coverage fixture must use ordinary prose rather than a section heading');
    const {parseHash, ...identity} = f.ir.identity;
    const ir = pipeline.buildPaperIR({identity, content: {...f.data.content,
      blocks: [{...original, text: long}]}, metadata: f.ir.metadata});
    const batches = pipeline.buildScientificExtractionBatches(ir, {...extractionConfig(), batchTokens: 1000});
    const spans = batches.flatMap(batch => batch.blocks).filter(block => block.blockId === original.id);
    assert.ok(spans.length > 1);
    assert.equal(spans[0].start, 0); assert.equal(spans.at(-1).end, long.length);
    assert.equal(spans.map(span => span.text).join(''), long);
    for (const [index, span] of spans.entries()) {
      if (index) assert.equal(spans[index - 1].end, span.start);
      assert.equal(span.text, long.slice(span.start, span.end));
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(span.text));
    }
    const oversizedHeading = pipeline.buildPaperIR({identity, content: {...f.data.content,
      blocks: [{...original, kind: 'heading', text: long}]}, metadata: f.ir.metadata});
    assert.throws(() => pipeline.buildScientificExtractionBatches(oversizedHeading,
      {...extractionConfig(), batchTokens: 1000}), /research_scientific_extraction_text_budget_exceeded/);
  } finally {await f.close();}
});

test('production structured adapter hashes effective model settings without persisting secrets and forwards cancellation', async () => {
  const adapterCalls = [];
  const handle = {provider: {id: 'provider', type: 'openai_compatible', endpoint: 'https://private.invalid',
    credentialRef: 'private-credential', options: {defaultHeaders: {Authorization: 'private-header'}},
    models: [{id: 'model', options: {temperature: .1}}]},
    modelId: 'model', runtime: {providerType: 'openai_compatible', baseUrl: 'https://private.invalid',
      contextWindowTokens: 32_000, maxOutputTokens: 6000, streaming: false, modelKwargs: {}},
    model: {withStructuredOutput: (schema, options) => ({invoke: async (messages, options2) => {
      adapterCalls.push({schema, options, messages, options2});
      return {raw: {response_metadata: {}}, parsed: options.name === 'scientific_entities' ? {entities: []} :
        options.name === 'scientific_facts' ? {facts: []} : {relations: []}};
    }})}};
  const session = await pipeline.createScientificExtractionSessionFactory({createDefaultChatModel: async () => handle})();
  assert.ok(!JSON.stringify(session.config).includes('private'));
  const changed = structuredClone({...handle, model: null}); changed.model = handle.model;
  changed.provider.models[0].options.temperature = .2;
  assert.notEqual(pipeline.scientificExtractionModelConfig(changed).model.revision, session.config.model.revision);
  const f = await scientificSearchFixture(api, {objects: false, embedded: false});
  try {
    const source = await captured(f, session.config);
    await run(source, session.invoke);
    assert.equal(adapterCalls[0].options.name, 'scientific_entities');
    assert.ok(adapterCalls.every(call => call.options.method === 'functionCalling'));
    assert.ok(adapterCalls.every(call => call.options.includeRaw === true));
    assert.ok(adapterCalls[0].options2.signal instanceof AbortSignal);
    const anthropic = await pipeline.createScientificExtractionSessionFactory({createDefaultChatModel: async () =>
      ({...handle, provider: {...handle.provider, type: 'anthropic_compatible'}})})();
    const entityCall = {name: adapterCalls[0].options.name, schema: adapterCalls[0].schema, messages: adapterCalls[0].messages};
    await anthropic.invoke(entityCall, new AbortController().signal);
    assert.equal(adapterCalls.at(-1).options.method, undefined, 'Anthropic retains its provider default method');
    assert.equal(adapterCalls.at(-1).options.includeRaw, true);
    const exhausted = await pipeline.createScientificExtractionSessionFactory({createDefaultChatModel: async () =>
      ({...handle, provider: {...handle.provider, type: 'anthropic_compatible'},
        model: {withStructuredOutput: () => ({invoke: async () =>
          ({raw: {response_metadata: {stop_reason: 'max_tokens'}}, parsed: {entities: []}})})}})})();
    await assert.rejects(() => exhausted.invoke(entityCall, new AbortController().signal),
      /research_scientific_extraction_output_budget_exceeded/u);
  } finally {await f.close();}
});
