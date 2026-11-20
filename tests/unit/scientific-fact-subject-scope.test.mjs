import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {z} from 'zod';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, extraction;
before(async () => {
  api = await loadScientificSearchApi();
  extraction = Object.assign({}, ...await Promise.all([
    'src/main/services/langchain-model-factory.ts',
    ...['scientific-extraction-model', 'scientific-extraction-batches', 'scientific-extraction-input',
      'scientific-fact-extractor', 'scientific-fact-validator', 'scientific-entity-resolution'].map(name =>
      `src/main/plugins/research/${name}.ts`)
  ].map(path => importTypeScriptModule(path, {platform: 'node',
    external: ['@langchain/*', 'p-retry', '@napi-rs/canvas', 'zod'], tempDir: '.runtime/tmp'}))));
});
after(() => api?.dispose());
const unknown = () => ({datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
  baselineId: null, budget: 'unknown', other: {}});
const cell = (ir, raw) => {
  const table = ir.tables[0], original = table.cells.find(cell => cell.text === raw);
  assert.ok(original);
  return {kind: 'table_cell', tableId: table.id, cellId: original.id, raw};
};
const entities = f => [
  {id: 'baseline', entityType: 'Baseline', canonicalName: 'Original baseline', aliases: [],
    attributes: {version: null}, evidence: [cell(f.ir, 'Original baseline')]},
  {id: 'global-method', entityType: 'Method', canonicalName: 'Original method', aliases: [],
    attributes: {description: null}, evidence: [{kind: 'text', blockId: 'body', start: 0, end: 15,
      quote: 'Original method'}]},
  {id: 'substring', entityType: 'Method', canonicalName: 'Original base', aliases: [],
    attributes: {description: null}, evidence: [cell(f.ir, 'Original baseline')]},
  {id: 'metric', entityType: 'Metric', canonicalName: 'F1', aliases: [],
    attributes: {definition: null, direction: 'unknown', unit: '%'}, evidence: [cell(f.ir, 'F1 (%)')]}
];

function expandReferences(schema) {
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    const {$ref, $defs, $schema, ...siblings} = node;
    if ($ref !== undefined) {
      assert.match($ref, /^#\/\$defs\//u);
      const target = $ref.slice(2).split('/').reduce((value, key) =>
        value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
      assert.ok(target, `Missing reference ${$ref}`);
      return {...expand(target), ...expand(siblings)};
    }
    return Object.fromEntries(Object.entries(siblings).map(([key, value]) => [key, expand(value)]));
  }
  return expand(schema);
}

test('row subject permissions require an exact named own-row or merged anchor and retain full input', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const config = {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'revision/1'},
      inputTokens: 64000, batchTokens: 8000};
    const batch = extraction.buildScientificExtractionBatches(f.ir, config).find(b =>
      b.objects.some(object => object.objectType === 'Table'));
    const supplied = entities(f), before = f.db.serialize();
    await extraction.extractScientificFacts({config, invoke: async call => {
      const input = JSON.parse(call.messages[1].content), table = input.batch.objects.find(o => o.objectType === 'Table');
      const scope = input.resultEvidenceScopes.find(s => s.tableId === table.objectId);
      const anchor = table.content.cells.find(c => c.text === 'Original baseline').id;
      assert.deepEqual(scope.rows.find(r => r.row === 0).subjects, []);
      for (const row of [1, 2]) {
        assert.deepEqual(scope.rows.find(r => r.row === row).subjects, [{entityId: 'baseline', cellIds: [anchor]}]);
      }
      assert.deepEqual(input.resultSubjectEntityIds, ['baseline'],
        'Global type eligibility, another row and partial printed tokens cannot authorize subjects');
      const codec = extraction.scientificExtractionInput(batch, {textSelections: true});
      const decoded = codec.decode(input);
      assert.deepEqual(decoded.batch, batch);
      assert.deepEqual(decoded.entities, supplied, 'Keep the complete original identity evidence');
      assert.equal(input.batch.blocks[0].textId, 'text-0');
      assert.ok(!('nameTokens' in table.content.cells[0]), 'Fact names remain explicit original identity data');
      assert.match(call.messages[0].content, /Entity evidence is identity data/u);
      const value = table.content.cells.find(cell => cell.text === '91');
      const proposal = {id: 'reported', factType: 'experimental_result', subjectEntityId: 'baseline',
        predicate: 'Reported value', objectEntityId: null, value: {raw: '91', unit: null, unitEvidence: []},
        table: {tableId: table.objectId, cellId: value.id, row: 2}, conditions: unknown(),
        conditionEvidence: [], evidence: [{kind: 'table_cell', tableId: table.objectId,
          cellId: value.id, raw: '91'}], confidence: .8};
      assert.ok(call.schema.safeParse({facts: [proposal]}).success);
      assert.ok(!call.schema.safeParse({facts: [proposal, proposal]}).success, 'Keep unique local IDs');
      assert.ok(!call.schema.safeParse({facts: [{...proposal, subjectEntityId: 'global-method'}]}).success);
      const header = table.content.cells.find(cell => cell.text === 'Method');
      const headerProposal = {...proposal, table: {tableId: table.objectId, cellId: header.id, row: 0},
        value: {raw: 'Method', unit: null, unitEvidence: []},
        evidence: [{kind: 'table_cell', tableId: table.objectId, cellId: header.id, raw: 'Method'}]};
      assert.ok(!call.schema.safeParse({facts: [headerProposal]}).success, 'Empty row permissions require null');
      assert.ok(!call.schema.safeParse({facts: [{...headerProposal, subjectEntityId: null}]}).success,
        'Declared headers and labels cannot be numeric values even with a null subject');
      assert.ok(call.schema.safeParse({facts: [{...headerProposal, subjectEntityId: null,
        factType: 'method_component', value: null, table: null}]}).success,
      'Original header text remains nonnumeric evidence');
      return {facts: []};
    }}, batch, f.ir, supplied, AbortSignal.timeout(5000));
    const noObjects = {...batch, objects: []};
    await extraction.extractScientificFacts({config, invoke: async call => {
      const input = JSON.parse(call.messages[1].content);
      assert.deepEqual(input.resultSubjectEntityIds, []);
      assert.deepEqual(input.resultEvidenceScopes, []);
      const proposal = {id: 'title', factType: 'contribution', subjectEntityId: null,
        predicate: 'Paper title', objectEntityId: null, value: null, table: null, conditions: unknown(),
        conditionEvidence: [], evidence: [{kind: 'metadata', field: 'title', raw: f.ir.metadata.title}], confidence: .8};
      assert.ok(call.schema.safeParse({facts: [proposal]}).success);
      assert.ok(!call.schema.safeParse({facts: [{...proposal, factType: 'experimental_result'}]}).success,
        'No supplied tables cannot authorize numeric results');
      return {facts: []};
    }}, noObjects, f.ir, supplied, AbortSignal.timeout(5000));
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('actual Fact transport preserves row schema, null subjects and strict row/batch rejections', async () => {
  const f = await scientificSearchFixture(api, {embedded: false}), requests = [];
  let mode = 'valid', expectedSchema;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const input = JSON.parse(request.messages.find(message => message.role === 'user').content);
    const table = input.batch.objects.find(object => object.objectType === 'Table'),
      source = raw => ({kind: 'table_cell', tableId: table.objectId,
        cellId: table.content.cells.find(cell => cell.text === raw).id, raw});
    const value = source('91'), anchor = source('Original baseline');
    const tokenSelection = evidence => {
      const choice = input.conditionTokenChoices.sources.find(choice =>
        JSON.stringify(choice.evidence) === JSON.stringify(evidence));
      return {sourceId: choice.sourceId, firstToken: 0, lastToken: choice.tokenCount - 1};
    };
    const fact = {id: 'reported', factType: 'experimental_result',
      subjectEntityId: mode === 'null-subject' ? null : mode === 'global-subject' ? 'global-method' : 'baseline',
      predicate: 'Reported value', objectEntityId: null, value: {raw: '91', unit: null, unitEvidence: []},
      table: {tableId: table.objectId, cellId: value.cellId, row: 2},
      conditions: unknown(), conditionEvidence: [], evidence: mode === 'no-anchor' ? [value] : [value, anchor],
      confidence: .8};
    if (mode === 'outside-batch') fact.evidence.push(input.entities.find(e => e.id === 'global-method').evidence[0]);
    if (mode === 'wrong-row') fact.table.row = 1;
    if (mode === 'wrong-cell') fact.table.cellId = source('90').cellId;
    if (mode === 'foreign-table') fact.table.tableId = 'not-supplied-table';
    if (mode === 'foreign-evidence-table') fact.evidence[0].tableId = 'not-supplied-table';
    if (mode === 'foreign-evidence-row') fact.evidence.push(source('90'));
    if (mode === 'foreign-unit-row') {
      fact.value.unit = '%';
      fact.value.unitEvidence = [source('90')];
    }
    if (mode === 'foreign-condition-row') {
      const choice = input.conditionTokenChoices.sources.find(choice => choice.evidence.cellId === source('90').cellId);
      fact.conditions.budget = {sourceId: choice.sourceId, firstToken: 0, lastToken: 0};
      fact.conditionEvidence = [{field: 'budget', key: null, evidence: [source('90')]}];
    }
    if (mode === 'wrong-raw') fact.value.raw = '92';
    if (mode === 'same-row-wrong-raw') {
      fact.table = {tableId: table.objectId, cellId: source('90').cellId, row: 1};
      fact.value.raw = 'Original baseline';
      fact.evidence = [source('90'), anchor];
    }
    if (mode === 'numeric-label' || mode === 'numeric-label-cell') {
      fact.subjectEntityId = null;
      fact.table = {tableId: table.objectId, cellId: anchor.cellId, row: 1};
      fact.value.raw = mode === 'numeric-label' ? anchor.raw : '90';
      fact.evidence = [anchor];
    }
    if (mode === 'numeric-header') {
      const header = source('Method');
      fact.subjectEntityId = null;
      fact.table = {tableId: table.objectId, cellId: header.cellId, row: 0};
      fact.value.raw = header.raw;
      fact.evidence = [header];
    }
    if (mode === 'unknown-evidence') {
      fact.conditionEvidence = [{field: 'budget', key: null, evidence: [anchor]}];
    }
    if (mode.startsWith('nonnumeric-')) {
      fact.factType = 'dataset_usage';
      fact.subjectEntityId = null;
      fact.table = null;
      fact.value = null;
      fact.evidence = [value, {kind: 'object', objectType: 'Table', objectId: table.objectId}];
      if (mode === 'nonnumeric-label') fact.evidence = [anchor];
      const outside = input.entities.find(e => e.id === 'global-method').evidence[0];
      if (mode === 'nonnumeric-outside') fact.evidence.push(outside);
      if (mode === 'nonnumeric-foreign-cell') fact.evidence[0].cellId = 'foreign-cell';
      if (mode === 'nonnumeric-foreign-table') fact.evidence[0].tableId = 'foreign-table';
      if (mode === 'nonnumeric-foreign-object') fact.evidence[1].objectId = 'foreign-object';
      if (mode === 'nonnumeric-object-kind') fact.evidence[1].objectType = 'Figure';
      if (mode === 'nonnumeric-condition-outside') {
        fact.conditionEvidence = [{field: 'budget', key: null, evidence: [outside]}];
      }
    }
    if (mode === 'outside-batch-unit') {
      fact.value.unitEvidence = [input.entities.find(e => e.id === 'global-method').evidence[0]];
    }
    const selectedBlock = input.batch.blocks.find(block => block.text);
    const selectedText = {kind: 'text_span', textId: selectedBlock.textId};
    if (['selected-text', 'foreign-text-id', 'rewritten-text'].includes(mode)) {
      fact.factType = 'dataset_usage'; fact.subjectEntityId = null; fact.table = null; fact.value = null;
      fact.evidence = [selectedText];
      if (mode === 'foreign-text-id') selectedText.textId = 'foreign';
      if (mode === 'rewritten-text') selectedText.quote = 'rewritten';
    }
    if (mode === 'selected-unit') fact.value.unitEvidence = [selectedText];
    if (mode === 'selected-condition' || mode === 'selected-condition-supported') {
      const choice = input.conditionTokenChoices.sources.find(choice => choice.evidence.textId === selectedBlock.textId);
      fact.conditions.budget = mode === 'selected-condition' ?
        'configuration absent from original source' :
        {sourceId: choice.sourceId, firstToken: 0, lastToken: choice.tokenCount - 1};
      fact.conditionEvidence = [{field: 'budget', key: null, evidence: [selectedText]}];
    }
    const conditionMode = mode.match(/^condition-(unknown|missing)-(datasetId|datasetVersion|split|metricId|baselineId|budget)$/u);
    if (conditionMode) {
      const field = conditionMode[2];
      if (conditionMode[1] === 'unknown') fact.conditionEvidence = [{field, key: null, evidence: [value]}];
      else fact.conditions[field] = field.endsWith('Id') ? 'baseline' : tokenSelection(value);
    }
    if (['condition-duplicate', 'condition-fixed-key', 'condition-valid'].includes(mode)) {
      fact.conditions.budget = tokenSelection(value);
      const entry = {field: 'budget', key: mode === 'condition-fixed-key' ? 'budget' : null, evidence: [value]};
      fact.conditionEvidence = mode === 'condition-duplicate' ? [entry, entry] : [entry];
    }
    if (mode.startsWith('condition-other-')) {
      fact.conditions.other = mode === 'condition-other-orphan' ? {} :
        {iterations: mode === 'condition-other-unknown' ? 'unknown' : tokenSelection(value)};
      fact.conditionEvidence = mode === 'condition-other-missing' ? [] :
        [{field: 'other', key: mode === 'condition-other-null-key' ? null : 'iterations', evidence: [value]}];
    }
    if (mode.startsWith('condition-discarded-key-')) {
      fact.conditions.other = JSON.parse(`{"__proto__":${JSON.stringify(mode.endsWith('unknown') ? 'unknown' : 'SGD')}}`);
    }
    const referenceMode = mode.match(/^(numeric|nonnumeric|empty-numeric|empty-nonnumeric)-entity-(subjectEntityId|objectEntityId|datasetId|metricId|baselineId)$/u);
    if (mode.startsWith('empty-')) {
      fact.subjectEntityId = null;
      if (mode.startsWith('empty-nonnumeric-')) {
        fact.factType = 'method_component'; fact.value = null; fact.table = null;
      }
    }
    if (referenceMode) {
      const field = referenceMode[2], invalidId = field === 'objectEntityId' ? table.objectId : 'foreign-entity';
      if (field === 'subjectEntityId' || field === 'objectEntityId') fact[field] = invalidId;
      else fact.conditions[field] = invalidId;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({id: 'fixture', object: 'chat.completion', model: 'group/deepseek',
      choices: [{index: 0, finish_reason: 'tool_calls', message: {role: 'assistant', content: null,
        tool_calls: [{id: 'fixture-call', type: 'function', function: {name: 'scientific_facts',
          arguments: JSON.stringify({facts: mode === 'duplicate-id' ? [fact, fact] : [fact]})}}]}}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = {id: 'fixture', name: 'Fixture', type: 'openai_compatible', enabled: true,
      endpoint: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: 'secret:fixture',
      models: [{id: 'group/deepseek', enabled: true, options: {temperature: 0}}]};
    const factory = new extraction.LangChainModelFactory({
      getProviders: () => ({providers: [provider], defaultModelId: 'fixture:group/deepseek'}),
      getDefaultModelState: () => ({status: 'ready', providerId: 'fixture', modelId: 'group/deepseek'})
    }, {getProviderSecret: async () => 'fixture-local-key'});
    const session = await extraction.createScientificExtractionSessionFactory(factory)(),
      complete = extraction.buildScientificExtractionBatches(f.ir, session.config).find(b =>
        b.objects.some(object => object.objectType === 'Table'));
    const batch = {...complete, blocks: complete.blocks.filter(block => block.blockId !== 'body')};
    // The global entity is valid in the paper, but its identity source is outside this Fact batch.
    const supplied = entities(f).filter(entity => entity.id !== 'substring');
    const basis = {ir: f.ir, projectId: f.project.id, generationId: 'fact-wire-generation'},
      resolved = supplied.map(entity => extraction.resolveScientificEntity(entity, basis));
    const before = f.db.serialize(), invoke = () => extraction.extractScientificFacts({
      ...session, invoke: async (call, signal) => {
        const inline = z.toJSONSchema(call.schema);
        expectedSchema = extraction.scientificExtractionToolSchema(call.name, call.schema);
        assert.ok(Object.keys(expectedSchema.$defs).length > 0);
        assert.deepEqual(expandReferences(expectedSchema), expandReferences(inline),
          'Every original row, null, condition and source constraint remains on the compact wire');
        return session.invoke(call, signal);
      }
    }, batch, f.ir, mode.startsWith('empty-') ? [] : supplied, AbortSignal.timeout(5000));
    let valid;
    for (mode of ['valid', 'null-subject']) {
      const facts = await invoke();
      if (mode === 'valid') valid = facts[0];
      const validated = extraction.validateScientificFact(facts[0], basis, resolved);
      assert.equal(validated.value.raw, '91');
      assert.equal(validated.subjectEntityId, mode === 'null-subject' ? null : resolved[0].id);
      assert.equal(validated.scientificApproval, 'unreviewed');
      const request = requests.at(-1), {$schema, ...actual} = request.tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema);
      assert.equal(request.max_tokens, 6000);
      assert.deepEqual(request.tool_choice, {type: 'function', function: {name: 'scientific_facts'}});
      assert.equal(request.response_format, undefined);
      assert.equal(request.thinking, undefined);
      const kinds = new Set();
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.properties?.kind?.const) kinds.add(value.properties.kind.const);
        for (const child of Object.values(value)) visit(child);
      };
      visit(actual);
      assert.deepEqual([...kinds].sort(), ['metadata', 'object', 'table_cell', 'text_span']);
    }
    assert.throws(() => extraction.validateScientificFact({...valid, subjectEntityId: 'global-method'}, basis, resolved),
      /fact_result_subject_invalid/u, 'Shared business validation must still reject a globally eligible wrong-row subject');
    assert.throws(() => extraction.validateScientificFact({...valid, value: {...valid.value, raw: '92'}}, basis, resolved),
      /fact_value_invalid/u, 'The original raw-to-exact-cell guard remains authoritative');
    mode = 'no-anchor';
    const unanchored = await invoke();
    assert.throws(() => extraction.validateScientificFact(unanchored[0], basis, resolved), /fact_result_subject_invalid/u);
    for (mode of ['unknown-evidence', 'global-subject', 'wrong-row', 'wrong-cell', 'foreign-table',
      'foreign-evidence-table', 'foreign-evidence-row', 'foreign-unit-row', 'foreign-condition-row', 'duplicate-id', 'wrong-raw',
      'outside-batch', 'outside-batch-unit', 'nonnumeric-outside', 'nonnumeric-foreign-cell', 'nonnumeric-foreign-table',
      'nonnumeric-foreign-object', 'nonnumeric-object-kind', 'nonnumeric-condition-outside',
      'foreign-text-id', 'rewritten-text', 'selected-condition', 'same-row-wrong-raw',
      'numeric-label', 'numeric-label-cell', 'numeric-header']) {
      await assert.rejects(invoke, /extraction_output_invalid/u, `Reject ${mode} at actual model output boundary`);
      const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema, `All source constraints must reach HTTP in ${mode}`);
    }
    for (mode of ['nonnumeric-valid', 'nonnumeric-label']) {
      const nonnumeric = await invoke();
      assert.equal(extraction.validateScientificFact(nonnumeric[0], basis, resolved).value, null);
      const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema);
      if (mode === 'nonnumeric-label') assert.equal(nonnumeric[0].evidence[0].raw, 'Original baseline');
    }
    for (mode of ['selected-text', 'selected-unit', 'selected-condition-supported']) {
      const facts = await invoke();
      const input = JSON.parse(requests.at(-1).messages.find(message => message.role === 'user').content);
      const block = input.batch.blocks.find(block => block.text);
      const source = mode === 'selected-unit' ? facts[0].value.unitEvidence[0] :
        mode === 'selected-condition-supported' ? facts[0].conditionEvidence[0].evidence[0] : facts[0].evidence[0];
      assert.deepEqual(source, {kind: 'text', blockId: block.blockId, start: block.start, end: block.end, quote: block.text});
      assert.equal(f.ir.blocks.find(original => original.blockId === block.blockId).text.slice(source.start, source.end), source.quote);
      const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema);
      if (mode === 'selected-text') assert.equal(extraction.validateScientificFact(facts[0], basis, resolved).value, null);
      if (mode === 'selected-condition-supported') {
        assert.equal(facts[0].conditions.budget, block.text);
        assert.throws(() => extraction.validateScientificFact({...facts[0],
          conditions: {...facts[0].conditions, budget: 'configuration absent from original source'}},
        basis, resolved), /fact_condition_invalid/u, 'Shared native source support remains authoritative');
      }
    }
    const fixedFields = ['datasetId', 'datasetVersion', 'split', 'metricId', 'baselineId', 'budget'];
    for (mode of [
      ...fixedFields.flatMap(field => [`condition-unknown-${field}`, `condition-missing-${field}`]),
      'condition-duplicate', 'condition-fixed-key', 'condition-other-null-key',
      'condition-other-orphan', 'condition-other-unknown', 'condition-other-missing',
      'condition-discarded-key-known', 'condition-discarded-key-unknown'
    ]) {
      await assert.rejects(invoke, /extraction_output_invalid/u, `Reject ${mode} before decoding`);
      const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema, `Host-only refinement keeps the complete HTTP Schema in ${mode}`);
    }
    for (mode of ['condition-valid', 'condition-other-valid']) {
      const facts = await invoke();
      assert.equal(extraction.validateScientificFact(facts[0], basis, resolved).value.raw, '91');
      const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
      assert.deepEqual(actual, expectedSchema);
      assert.equal(facts[0].conditionEvidence.length, 1);
    }
    for (const kind of ['numeric', 'nonnumeric', 'empty-numeric', 'empty-nonnumeric']) {
      if (kind.startsWith('empty-')) {
        mode = `${kind}-valid`;
        const facts = await invoke();
        assert.equal(facts[0].subjectEntityId, null);
        const input = JSON.parse(requests.at(-1).messages.find(message => message.role === 'user').content);
        assert.deepEqual(input.entities, [], 'Empty supplied domain is explicit at actual HTTP');
        const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
        assert.deepEqual(actual, expectedSchema);
      }
      for (const field of ['subjectEntityId', 'objectEntityId', 'datasetId', 'metricId', 'baselineId']) {
        mode = `${kind}-entity-${field}`;
        await assert.rejects(invoke, /extraction_output_invalid/u, `Reject ${mode} at actual HTTP output boundary`);
        const {$schema, ...actual} = requests.at(-1).tools[0].function.parameters;
        assert.deepEqual(actual, expectedSchema, `Entire Schema reaches HTTP in ${mode}`);
      }
    }
    assert.equal(requests.length, 78);
    assert.deepEqual(f.db.serialize(), before, 'Transport/source validation cannot publish Facts');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});

test('Fact text selections restore exact supplied intervals and retain original source validation', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const body = f.ir.blocks.find(block => block.blockId === 'body');
    const batch = {id: 'partial-text', objects: [], blocks: [{
      blockId: body.blockId, kind: body.kind, start: 9, end: 15, text: body.text.slice(9, 15), sections: []
    }]};
    const config = {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'revision/1'},
      inputTokens: 64000, batchTokens: 8000};
    const source = {kind: 'text', blockId: 'body', start: 9, end: 15, quote: body.text.slice(9, 15)};
    const fact = {id: 'text', factType: 'contribution', subjectEntityId: null, objectEntityId: null,
      predicate: 'Original excerpt', value: null, table: null, conditions: unknown(), conditionEvidence: [],
      evidence: [{kind: 'text_span', textId: 'text-0'}], confidence: .8};
    let schema;
    const invoke = candidate => extraction.extractScientificFacts({config, invoke: async call => {
      schema = call.schema;
      assert.deepEqual(extraction.scientificExtractionInput(batch, {textSelections: true})
        .decode(JSON.parse(call.messages[1].content)).batch, batch);
      return {facts: [candidate]};
    }}, batch, f.ir, [], AbortSignal.timeout(5000));
    const accepted = await invoke(fact);
    assert.deepEqual(accepted[0].evidence[0], source);
    for (const evidence of [{kind: 'text_span', textId: 'foreign'},
      {kind: 'text_span', textId: 'text-0', quote: 'rewritten'},
      {kind: 'text_span', textId: 'text-0', start: 0}, source]) {
      await assert.rejects(() => invoke({...fact, evidence: [evidence]}), error => error.name === 'ZodError');
    }
    for (const evidence of [{kind: 'table_cell', tableId: f.ir.tables[0].id, cellId: 'foreign', raw: ''},
      {kind: 'object', objectType: 'Table', objectId: f.ir.tables[0].id}]) {
      assert.ok(!schema.safeParse({facts: [{...fact, evidence: [evidence]}]}).success);
    }
    assert.throws(() => extraction.assertScientificBatchSources(batch,
      [{...source, quote: 'wrong'}], f.ir), /fact_quote_invalid/u);
    const empty = {id: 'empty-text', objects: [], blocks: []};
    await extraction.extractScientificFacts({config, invoke: async call => {
      assert.ok(!call.schema.safeParse({facts: [fact]}).success);
      return {facts: []};
    }}, empty, f.ir, [], AbortSignal.timeout(5000));
    // The shared source guard still rejects the original, exact whole-block quote outside this interval.
    assert.throws(() => extraction.assertScientificBatchSources(batch,
      [{...source, start: 0, quote: body.text.slice(0, 15)}], f.ir), /source_not_supplied/u);
  } finally {await f.close();}
});
