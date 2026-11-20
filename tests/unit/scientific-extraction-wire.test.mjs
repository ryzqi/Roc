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
    'src/main/plugins/research/scientific-extraction-model.ts',
    'src/main/plugins/research/scientific-extraction-batches.ts',
    'src/main/plugins/research/scientific-entity-extractor.ts',
    'src/main/plugins/research/scientific-fact-extractor.ts',
    'src/main/services/provider-tool-json-schema.ts',
    'src/main/plugins/research/knowledge-chunks.ts',
    'src/shared/schemas/research-scientific-entities.ts'
  ].map(path => importTypeScriptModule(path, {platform: 'node',
    external: ['@langchain/*', 'p-retry', '@napi-rs/canvas', 'zod'], tempDir: '.runtime/tmp'}))));
});
after(() => api?.dispose());

async function wire(operation, mode = 'valid', type = 'openai_compatible') {
  const requests = [], f = await scientificSearchFixture(api, {embedded: false});
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    if (request.response_format || mode === 'http-error') {
      res.statusCode = 500;
      res.end(JSON.stringify({error: {message: 'fixture_json_schema_unsupported', type: 'server_error'}}));
      return;
    }
    const input = JSON.parse(request.messages.find(message => message.role === 'user').content);
    const batch = input.batch;
    const table = batch.objects.find(object => object.objectType === 'Table');
    const cell = table.content.cells.find(cell => cell.text === 'Original baseline');
    const proposal = {id: 'method-local', entityType: 'Method',
      canonicalName: {evidenceIndex: 0, firstToken: 0, lastToken: 1}, aliases: [],
      attributes: {description: null}, evidence: [{kind: 'table_cell', tableId: table.objectId,
        cellId: cell.id, raw: mode === 'wrong-source' ? 'invented value' : cell.text}]};
    if (mode === 'selected-text') {
      const block = batch.blocks.find(block => block.text.includes(cell.text));
      proposal.evidence = [{kind: 'text_span', textId: block.textId}];
      const firstToken = block.nameTokens.find(([index, token]) =>
        token === 'Original' && block.nameTokens[index + 1]?.[1] === 'baseline')[0];
      proposal.canonicalName = {evidenceIndex: 0, firstToken, lastToken: firstToken + 1};
    }
    let output = ['truncated-empty', 'malformed'].includes(mode) ? {} : {entities: [
      mode === 'selected-object' ? {id: 'table-local', entityType: 'Table', objectId: table.objectId} : proposal
    ]};
    if (mode.startsWith('fact-')) {
      const evidence = {kind: 'table_cell', tableId: table.objectId, cellId: cell.id, raw: cell.text};
      const choice = input.conditionTokenChoices.sources.find(source =>
        JSON.stringify(source.evidence) === JSON.stringify(evidence));
      output = {facts: [{id: 'fact-local', factType: 'method_component',
        subjectEntityId: mode === 'fact-invalid' ? 'foreign' : null, objectEntityId: null,
        predicate: 'Original configuration', value: null, table: null,
        conditions: {datasetId: null, datasetVersion: 'unknown',
          split: {sourceId: choice.sourceId, firstToken: 0, lastToken: 1},
          metricId: null, baselineId: null, budget: 'unknown', other: {}},
        conditionEvidence: [{field: 'split', key: null, evidence: [evidence]}], evidence: [evidence], confidence: .5}]};
      if (mode === 'fact-null') output = null;
      if (mode === 'fact-truncated-empty') output = {};
    }
    const truncated = mode.startsWith('truncated-') || mode.startsWith('fact-truncated-');
    if (type === 'anthropic_compatible') {
      res.end(JSON.stringify({id: 'fixture', type: 'message', role: 'assistant', model: 'group/deepseek',
        content: [{type: 'tool_use', id: 'call-fixture', name: request.tools[0].name, input: output}],
        stop_reason: truncated ? 'max_tokens' : 'tool_use', stop_sequence: null,
        usage: {input_tokens: 1, output_tokens: truncated ? 6000 : 1}}));
      return;
    }
    res.end(JSON.stringify({id: 'fixture', object: 'chat.completion', model: 'group/deepseek',
      choices: [{index: 0, finish_reason: truncated ? 'length' : 'tool_calls', message: {role: 'assistant', content: null,
        tool_calls: [{id: 'call-fixture', type: 'function', function: {name: request.tools[0].function.name,
          arguments: JSON.stringify(output)}}]}}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = {id: 'fixture', name: 'Fixture', type, enabled: true,
      endpoint: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: 'secret:fixture',
      models: [{id: 'group/deepseek', enabled: true, options: {temperature: 0}}]};
    const factory = new extraction.LangChainModelFactory({
      getProviders: () => ({providers: [provider], defaultModelId: 'fixture:group/deepseek'}),
      getDefaultModelState: () => ({status: 'ready', providerId: 'fixture', modelId: 'group/deepseek'})
    }, {getProviderSecret: async () => 'fixture-local-key'});
    const session = await extraction.createScientificExtractionSessionFactory(factory)();
    const batch = extraction.buildScientificExtractionBatches(f.ir, session.config)
      .find(batch => batch.objects.some(object => object.objectType === 'Table'));
    await operation({session, batch, f, requests});
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_entities').pluck().get(), 0,
      'bounded extraction cannot publish model proposals');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_facts').pluck().get(), 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
}

test('actual compatible extraction uses a forced tool with no Paper branch and restores complete cell IDs', async () => {
  await wire(async ({session, batch, f, requests}) => {
    const entities = await extraction.extractScientificEntities(session, batch, f.ir, AbortSignal.timeout(5000));
    assert.equal(entities.length, 1);
    const request = requests[0];
    assert.equal(requests.length, 1);
    assert.equal(request.stream, false);
    assert.equal(request.response_format, undefined);
    assert.deepEqual(request.tool_choice, {type: 'function', function: {name: 'scientific_entities'}});
    const parameters = request.tools[0].function.parameters;
    assert.deepEqual(parameters.properties.entities.items.oneOf.map(option => option.properties.entityType.const),
      ['Method', 'Model', 'Dataset', 'Metric', 'Experiment', 'Baseline', 'Equation', 'Figure', 'Table', 'Algorithm']);
    assert.deepEqual(parameters.properties.entities.items.oneOf[0].properties.evidence.items.oneOf
      .map(option => option.properties.kind.const), ['text_span', 'table_cell', 'object', 'metadata']);
    assert.ok(!JSON.stringify(parameters).includes('"const":"Paper"'));
    assert.match(JSON.stringify(parameters), /"const":"Method"/u);
    const canonical = batch.objects[0].content.cells.find(cell => cell.text === 'Original baseline');
    assert.equal(entities[0].evidence[0].cellId, canonical.id);
    assert.equal(entities[0].evidence[0].raw, canonical.text);
    assert.equal(entities[0].canonicalName, canonical.text);
    assert.notEqual(entities[0].id, 'method-local');
  });
});

test('actual compatible transport preserves every JSON Schema constraint including empty object choices and record keys', async () => {
  await wire(async ({session, batch, f, requests}) => {
    let expected;
    const wrapped = {...session, invoke: async (call, signal) => {
      const {$schema, ...schema} = z.toJSONSchema(call.schema);
      expected = schema;
      return session.invoke(call, signal);
    }};
    await extraction.extractScientificEntities(wrapped, batch, f.ir, AbortSignal.timeout(5000));
    const {$schema, ...actual} = requests[0].tools[0].function.parameters;
    assert.deepEqual(actual, expected);
    assert.equal(requests.length, 1);
    for (const branch of actual.properties.entities.items.oneOf.slice(6)) {
      const ids = batch.objects.filter(object => object.objectType === branch.properties.entityType.const)
        .map(object => object.objectId);
      assert.deepEqual(branch.properties.objectId, ids.length ? {type: 'string', enum: ids} : {not: {}});
    }
  });
});

test('actual compatible extraction rejects exhausted output even when truncated candidates satisfy the schema', async () => {
  for (const mode of ['truncated-empty', 'truncated-shaped']) {
    await wire(async ({session, batch, f, requests}) => {
      await assert.rejects(() => extraction.extractScientificEntities(session, batch, f.ir, AbortSignal.timeout(5000)),
        /research_scientific_extraction_output_budget_exceeded/u);
      assert.equal(requests.length, 1, 'Output exhaustion cannot trigger a silent retry');
      assert.equal(requests[0].max_tokens, 6000, 'Do not expand the configured output budget');
    }, mode);
  }
});

test('actual compatible malformed output fails explicitly without model response content in the error', async () => {
  await wire(async ({session, batch, f, requests}) => {
    await assert.rejects(() => extraction.extractScientificEntities(session, batch, f.ir, AbortSignal.timeout(5000)),
      error => error.message === 'research_scientific_extraction_output_invalid');
    assert.equal(requests.length, 1);
  }, 'malformed');
});

test('actual compatible object selections resolve original fields through the complete tool union', async () => {
  await wire(async ({session, batch, f, requests}) => {
    const entities = await extraction.extractScientificEntities(session, batch, f.ir, AbortSignal.timeout(5000));
    assert.equal(entities.length, 1);
    const table = batch.objects.find(object => object.objectType === 'Table'), original = f.ir.tables.find(t => t.id === table.objectId);
    assert.equal(entities[0].entityType, 'Table');
    assert.equal(entities[0].attributes.objectId, original.id);
    assert.equal(entities[0].attributes.number, original.visual?.objectNumber ?? original.data.tableNumber);
    assert.deepEqual(entities[0].evidence, [{kind: 'object', objectType: 'Table', objectId: original.id}]);
    const branches = requests[0].tools[0].function.parameters.properties.entities.items.oneOf;
    assert.equal(branches.length, 10);
    for (const branch of branches.slice(6)) {
      assert.deepEqual(Object.keys(branch.properties), ['id', 'entityType', 'objectId']);
      assert.deepEqual(branch.required, ['id', 'entityType', 'objectId']);
      assert.equal(branch.additionalProperties, false);
    }
  }, 'selected-object');
});

test('actual compatible text selections resolve exact quotes with a strict model-visible source union', async () => {
  await wire(async ({session, batch, f, requests}) => {
    const entities = await extraction.extractScientificEntities(session, batch, f.ir, AbortSignal.timeout(5000));
    const input = JSON.parse(requests[0].messages.find(message => message.role === 'user').content);
    const selected = input.batch.blocks.find(block => block.text.includes('Original baseline'));
    assert.deepEqual(entities[0].evidence, [{kind: 'text', blockId: selected.blockId,
      start: selected.start, end: selected.end, quote: selected.text}]);
    assert.equal(f.ir.blocks.find(block => block.blockId === selected.blockId).text.slice(selected.start, selected.end),
      entities[0].evidence[0].quote);
    const method = requests[0].tools[0].function.parameters.properties.entities.items.oneOf[0];
    const branches = method.properties.evidence.items.oneOf;
    assert.deepEqual(branches.map(branch => branch.properties.kind.const), ['text_span', 'table_cell', 'object', 'metadata']);
    assert.deepEqual(Object.keys(branches[0].properties), ['kind', 'textId']);
    assert.equal(branches[0].additionalProperties, false);
  }, 'selected-text');
});

test('model-visible entity schema rejects Paper, duplicate IDs and extra authority while retained metadata remains valid', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const config = {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'fixture/1'},
      inputTokens: 64000, batchTokens: 8000};
    const batch = extraction.buildScientificExtractionBatches(f.ir, config)[0];
    const paper = extraction.scientificMetadataEntity(f.ir);
    assert.ok(extraction.scientificEntityProposalSchema.safeParse(paper).success);
    await extraction.extractScientificEntities({config, invoke: async call => {
      assert.deepEqual(call.schema.shape.entities.element.options.map(option => option.shape.entityType.value),
        ['Method', 'Model', 'Dataset', 'Metric', 'Experiment', 'Baseline', 'Equation', 'Figure', 'Table', 'Algorithm']);
      assert.equal(call.schema.safeParse({entities: [paper]}).success, false);
      const entity = {id: 'local', entityType: 'Method',
        canonicalName: {evidenceIndex: 0, firstToken: 0, lastToken: 1},
        aliases: [], attributes: {description: null},
        evidence: [{kind: 'object', objectType: batch.objects[0].objectType, objectId: batch.objects[0].objectId}]};
      assert.ok(call.schema.safeParse({entities: [entity]}).success);
      assert.equal(call.schema.safeParse({entities: [entity, entity]}).success, false);
      assert.equal(call.schema.safeParse({entities: [{...entity, projectId: 'foreign'}]}).success, false);
      assert.equal(call.schema.safeParse({entities: [], scientificApproval: 'approved'}).success, false);
      return {entities: []};
    }}, batch, f.ir, AbortSignal.timeout(5000));
    await assert.rejects(() => extraction.extractScientificEntities({config, invoke: async () =>
      ({entities: [paper]})}, batch, f.ir, AbortSignal.timeout(5000)), error => error.name === 'ZodError');
  } finally {await f.close();}
});

test('compatible wire success cannot authorize a changed original table value', async () => {
  await wire(async ({session, batch, f, requests}) => {
    await assert.rejects(() => extraction.extractScientificEntities(session, batch, f.ir,
      AbortSignal.timeout(5000)), /cell_invalid/u);
    assert.equal(requests.length, 1);
  }, 'wrong-source');
});

test('compatible HTTP failures remain failures with one request and no fallback or publication', async () => {
  await wire(async ({session, batch, f, requests}) => {
    await assert.rejects(() => extraction.extractScientificEntities(session, batch, f.ir,
      AbortSignal.timeout(5000)), /fixture_json_schema_unsupported/u);
    assert.equal(requests.length, 1);
  }, 'http-error');
});

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

test('actual Fact HTTP parameters use compact references with every inline constraint and exact original ranges', async () => {
  await wire(async ({session, batch, f, requests}) => {
    let original, parameters, messages;
    const wrapped = {...session, invoke: async (call, signal) => {
      original = z.toJSONSchema(call.schema);
      parameters = extraction.scientificExtractionToolSchema(call.name, call.schema);
      messages = structuredClone(call.messages);
      assert.ok(call.schema.safeParse({facts: []}).success, 'The runtime contract remains strict Zod');
      return session.invoke(call, signal);
    }};
    const facts = await extraction.extractScientificFacts(wrapped, batch, f.ir, [], AbortSignal.timeout(5000));
    assert.equal(requests.length, 1);
    const request = requests[0], actual = request.tools[0].function.parameters;
    assert.deepEqual(actual, parameters, 'Budget and HTTP must use the same compact schema');
    assert.deepEqual(expandReferences(actual), expandReferences(original));
    assert.ok(Object.keys(actual.$defs).length > 0);
    assert.ok(JSON.stringify(actual).length < JSON.stringify(original).length);
    assert.deepEqual(request.messages, messages);
    assert.equal(request.max_tokens, 6000);
    assert.equal(request.response_format, undefined);
    assert.deepEqual(request.tool_choice, {type: 'function', function: {name: 'scientific_facts'}});
    assert.equal(facts[0].subjectEntityId, null);
    assert.equal(facts[0].conditions.split, 'Original baseline');
    assert.equal(facts[0].conditions.metricId, null);
    assert.equal(facts[0].evidence[0].cellId,
      batch.objects[0].content.cells.find(cell => cell.text === 'Original baseline').id);
  }, 'fact-valid');
});

test('compact Fact transport rejects invalid and null proposals and preserves native length failure without retry', async () => {
  for (const mode of ['fact-invalid', 'fact-null', 'fact-truncated-empty', 'fact-truncated-shaped']) {
    await wire(async ({session, batch, f, requests}) => {
      await assert.rejects(() => extraction.extractScientificFacts(session, batch, f.ir, [], AbortSignal.timeout(5000)),
        error => error.message === (mode.startsWith('fact-truncated-') ?
          'research_scientific_extraction_output_budget_exceeded' : 'research_scientific_extraction_output_invalid'));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].max_tokens, 6000);
    }, mode);
  }
});

test('Fact budget admits the exact compact call and rejects one token less before dispatch', async () => {
  const leaf = z.string().min(1).max(2000);
  const schema = z.strictObject({facts: z.array(z.strictObject({first: leaf, second: leaf}))});
  const input = {batch: {id: 'fixture', blocks: [], objects: []}};
  let call, dispatches = 0;
  await extraction.invokeScientificExtraction({config: {inputTokens: 64000}, invoke: async value => {
    call = value;
    return {facts: []};
  }}, 'scientific_facts', schema, 'Return facts.', input, new AbortController().signal);
  const tokens = extraction.chunkTokenCount(JSON.stringify({messages: call.messages,
    schema: extraction.scientificExtractionToolSchema(call.name, call.schema), name: call.name})) + 256;
  const invoke = async () => {dispatches++; return {facts: []};};
  await extraction.invokeScientificExtraction({config: {inputTokens: tokens}, invoke},
    call.name, schema, 'Return facts.', input, new AbortController().signal);
  await assert.rejects(() => extraction.invokeScientificExtraction({config: {inputTokens: tokens - 1}, invoke},
    call.name, schema, 'Return facts.', input, new AbortController().signal),
  /research_scientific_extraction_call_budget_exceeded/u);
  assert.equal(dispatches, 1);
  for (const name of ['scientific_entities', 'scientific_relations']) {
    assert.deepEqual(extraction.scientificExtractionToolSchema(name, schema), z.toJSONSchema(schema));
  }
});

test('actual Anthropic Fact adapter preserves references, strict proposals and native max_tokens failure', async () => {
  for (const mode of ['fact-valid', 'fact-invalid', 'fact-truncated-shaped']) {
    await wire(async ({session, batch, f, requests}) => {
      let parameters;
      const wrapped = {...session, invoke: (call, signal) => {
        parameters = extraction.scientificExtractionToolSchema(call.name, call.schema);
        return session.invoke(call, signal);
      }};
      const operation = () => extraction.extractScientificFacts(wrapped, batch, f.ir, [], AbortSignal.timeout(5000));
      if (mode === 'fact-valid') {
        const facts = await operation();
        assert.equal(facts[0].conditions.split, 'Original baseline');
        assert.equal(facts[0].subjectEntityId, null);
      } else {
        await assert.rejects(operation, error => error.message === (mode === 'fact-invalid' ?
          'research_scientific_extraction_output_invalid' : 'research_scientific_extraction_output_budget_exceeded'));
      }
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].tools[0].input_schema, parameters);
      assert.ok(Object.keys(parameters.$defs).length > 0);
      assert.equal(requests[0].max_tokens, 6000);
      assert.deepEqual(requests[0].tool_choice, {type: 'tool', name: 'scientific_facts'});
    }, mode, 'anthropic_compatible');
  }
});

test('both provider sanitizers retain reference definitions, siblings and reference compositions', () => {
  const parameters = {type: 'object', properties: {
    score: {$ref: '#/$defs/score', maximum: 1},
    legacy: {$ref: '#/definitions/name'},
    combined: {allOf: [{$ref: '#/$defs/score'}, {maximum: .5}]},
    only: {maximum: .25, anyOf: [{$ref: '#/$defs/score'}]},
    sibling: {$ref: '#/$defs/score', allOf: [{maximum: .75}]}
  }, required: ['score', 'legacy', 'combined'], additionalProperties: false,
  $defs: {score: {type: 'number', minimum: 0}},
  definitions: {name: {type: 'string', minLength: 1}}};
  const openai = extraction.sanitizeOpenAiCompatibleTool({type: 'function', function: {name: 'fixture', parameters}});
  const anthropic = extraction.sanitizeAnthropicCompatibleTool({name: 'fixture', input_schema: parameters});
  assert.deepEqual(openai.function.parameters, parameters);
  assert.deepEqual(anthropic.input_schema, parameters);
});
