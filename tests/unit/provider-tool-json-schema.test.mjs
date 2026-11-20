import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {getEventListeners, once} from 'node:events';
import {tool} from '@langchain/core/tools';
import {HumanMessage} from '@langchain/core/messages';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const schemaApi = await importTypeScriptModule('src/main/services/provider-tool-json-schema.ts');
const {LangChainModelFactory} = await importTypeScriptModule('src/main/services/langchain-model-factory.ts', {
  platform: 'node', external: ['@langchain/*', 'p-retry'], tempDir: '.runtime/test-bundles'
});
const {createReviewTools} = await importTypeScriptModule('src/main/plugins/agent/review-tools.ts', {
  platform: 'node', external: ['langchain', 'zod'], tempDir: '.runtime/test-bundles'
});
const factory = new LangChainModelFactory({}, {getProviderSecret: async () => 'fixture-key'});
const rootError = error => error.message === 'provider_tool_schema_root_unsupported';
const shape = {type: 'object', properties: {score: {type: 'number', maximum: 1}},
  required: ['score'], additionalProperties: false};
const referenceRoots = ['$ref', 'anyOf', 'oneOf', 'allOf'].map(key => ({
  key,
  schema: {...(key === '$ref' ? {$ref: '#/$defs/shape'} : {[key]: [{$ref: '#/$defs/shape'}]}),
    $defs: {shape}}
}));
const supportedSchema = {type: 'object', properties: {
  score: {$ref: '#/$defs/score', maximum: .5},
  note: {anyOf: [{type: 'string', minLength: 1}, {type: 'null'}]}
}, required: ['score', 'note'], additionalProperties: false,
$defs: {score: {type: 'number', minimum: 0, maximum: 1}}};

function openAiTool(parameters) {
  return {type: 'function', function: {name: 'inspect_score', description: 'Inspect a score.', parameters}};
}

function anthropicTool(input_schema) {
  return {name: 'inspect_score', description: 'Inspect a score.', input_schema};
}

function messageText(content) {
  if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content));
  return content.map(block => {
    assert.equal(block.type, 'text');
    return block.text;
  }).join('');
}

for (const {key, schema} of referenceRoots) {
  test(`provider wrappers reject the retained ${key} root counterexample without mutating the source`, () => {
    const original = structuredClone(schema);
    assert.deepEqual(schemaApi.sanitizeProviderToolJsonSchema(schema), original,
      'The recursive sanitizer must retain the complete reference contract');
    assert.throws(() => schemaApi.sanitizeOpenAiCompatibleTool(openAiTool(schema)), rootError);
    assert.throws(() => schemaApi.sanitizeAnthropicCompatibleTool(anthropicTool(schema)), rootError);
    assert.deepEqual(schema, original);
  });
}

test('provider wrappers reject scalar, nullable and unspecified roots instead of emitting an empty object', () => {
  for (const schema of [{type: 'string'}, {type: 'array', items: {type: 'string'}},
    {type: ['object', 'null'], properties: {}}, {anyOf: [shape, {type: 'null'}]},
    {oneOf: [shape, {type: 'string'}]}, {}]) {
    assert.throws(() => schemaApi.sanitizeOpenAiCompatibleTools([openAiTool(shape), openAiTool(schema)]), rootError);
    assert.throws(() => schemaApi.sanitizeAnthropicCompatibleTools([anthropicTool(shape), anthropicTool(schema)]), rootError);
  }
});

test('supported object roots retain nested references, nullable constraints and repeated sanitization', () => {
  for (const schema of [supportedSchema, shape, {type: 'object', properties: {}, additionalProperties: false},
    {properties: {score: {type: 'number'}}, required: ['score']}]) {
    const original = structuredClone(schema);
    const expected = schemaApi.sanitizeProviderToolJsonSchema(schema);
    const openai = schemaApi.sanitizeOpenAiCompatibleTool(openAiTool(schema));
    const anthropic = schemaApi.sanitizeAnthropicCompatibleTool(anthropicTool(schema));
    assert.deepEqual(openai.function.parameters, expected);
    assert.deepEqual(anthropic.input_schema, expected);
    assert.deepEqual(schemaApi.sanitizeOpenAiCompatibleTool(openai), openai);
    assert.deepEqual(schemaApi.sanitizeAnthropicCompatibleTool(anthropic), anthropic);
    assert.deepEqual(schema, original);
  }
  assert.deepEqual(schemaApi.sanitizeOpenAiCompatibleTool(openAiTool(supportedSchema)).function.parameters, supportedSchema);
});

test('streaming root rejection leaves no caller abort listener or cancellation side effect', async () => {
  const config = {id: 'fixture', name: 'Fixture', type: 'openai_compatible', enabled: true,
    endpoint: 'http://127.0.0.1:1/v1', credentialRef: 'secret:fixture',
    models: [{id: 'fixture-model', enabled: true, options: {}}]};
  const {model} = await factory.createModelForProvider(config, 'fixture-model', {streaming: true});
  const controller = new AbortController();
  const chunks = model._streamResponseChunks([new HumanMessage('Inspect the schema.')],
    {tools: [openAiTool(referenceRoots[0].schema)], signal: controller.signal});
  await assert.rejects(() => chunks.next(), rootError);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
  assert.equal(controller.signal.aborted, false);
});

function respond(res, request, anthropic) {
  if (anthropic) {
    const message = {id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{type: 'text', text: 'done'}], stop_reason: 'end_turn', stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1}};
    if (request.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const events = [
        {type: 'message_start', message: {...message, content: [], stop_reason: null}},
        {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
        {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'done'}},
        {type: 'content_block_stop', index: 0},
        {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 1}},
        {type: 'message_stop'}
      ];
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(message));
    }
  } else if (request.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model',
      choices: [{index: 0, delta: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]}) +
      '\n\ndata: [DONE]\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({id: 'fixture', object: 'chat.completion', model: 'fixture-model',
      choices: [{index: 0, message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]}));
  }
}

for (const type of ['anthropic_compatible', 'openai_compatible']) {
  test(`${type} streams with the project review tools and retains their flat input contract`, async () => {
    const anthropic = type === 'anthropic_compatible';
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      respond(res, request, anthropic);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const config = {id: 'fixture', name: 'Fixture', type, enabled: true,
        endpoint: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: 'secret:fixture',
        models: [{id: 'fixture-model', enabled: true, options: {}}]};
      const {model} = await factory.createModelForProvider(config, 'fixture-model', {streaming: true});
      const calls = [];
      const tools = createReviewTools({
        capabilities: {invoke: async (name, input) => {calls.push({name, input}); return [];}},
        projectId: 'fixture-project',
        signal: new AbortController().signal
      });
      const read = tools.find(tool => tool.name === 'research_review_read');
      let result = '';
      for await (const chunk of await model.bindTools(tools).stream('Hello.', {signal: AbortSignal.timeout(5000)})) {
        result += messageText(chunk.content);
      }
      assert.equal(result, 'done');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].tools.length, tools.length);
      const wireTool = requests[0].tools.find(tool => (anthropic ? tool.name : tool.function.name) === read.name);
      const schema = anthropic ? wireTool.input_schema : wireTool.function.parameters;
      assert.equal(schema.type, 'object');
      assert.deepEqual(schema.required, ['kind']);
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.kind.enum.length, 20);
      assert.ok(schema.properties.kind.enum.includes('fulltext_content'));
      assert.equal(schema.properties.expectedBindingHash.pattern, '^[a-f0-9]{64}$');
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) assert.equal(key in schema, false);

      assert.deepEqual(await read.invoke({kind: 'protocols', limit: 100}), {limit: 100, capped: false, items: []});
      assert.deepEqual(calls, [{name: 'research.reviewProtocol.list', input: {limit: 100, projectId: 'fixture-project'}}]);
      for (const args of [
        {kind: 'protocols'},
        {kind: 'protocols', limit: 1, corpusId: 'wrong-kind'},
        {kind: 'search_pool', reviewSearchId: 'fixture-query', offset: 0, limit: 31}
      ]) {
        await assert.rejects(() => read.invoke(args), /Received tool input did not match expected schema/);
      }
      assert.equal(calls.length, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const type of ['openai_compatible', 'openrouter', 'nvidia', 'llama_cpp', 'anthropic_compatible']) {
  for (const mode of ['invoke', 'streaming-invoke', 'stream']) {
    test(`${type} ${mode} rejects unsupported roots before HTTP and sends the supported contract intact`, async () => {
      const requests = [], anthropic = type === 'anthropic_compatible';
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        requests.push(request);
        respond(res, request, anthropic);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const config = {id: 'fixture', name: 'Fixture', type, enabled: true,
          endpoint: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: 'secret:fixture',
          models: [{id: 'fixture-model', enabled: true, options: {}}]};
        const {model} = await factory.createModelForProvider(config, 'fixture-model',
          {streaming: mode !== 'invoke'});
        const entry = schema => anthropic ? anthropicTool(schema) : openAiTool(schema);
        async function run(schema, binding = 'bindTools', format = 'native') {
          const tools = [format === 'openai' ? openAiTool(schema) : format === 'structured'
            ? tool(() => 'unused', {name: 'inspect_score', description: 'Inspect a score.', schema}) : entry(schema)];
          const target = binding === 'bindTools' ? model.bindTools(tools)
            : binding === 'withConfig' ? model.withConfig({tools}) : model;
          const options = {signal: AbortSignal.timeout(5000), ...(binding === 'options' ? {tools} : {})};
          if (mode === 'stream') {
            let text = '';
            for await (const chunk of await target.stream('Inspect the schema.', options)) text += messageText(chunk.content);
            return text;
          }
          return messageText((await target.invoke('Inspect the schema.', options)).content);
        }
        for (const {key, schema} of referenceRoots) {
          for (const binding of ['bindTools', 'withConfig', 'options']) {
            for (const format of anthropic ? ['native', 'openai', 'structured'] : ['native', 'structured']) {
              await assert.rejects(() => run(schema, binding, format), rootError, `${key}/${binding}/${format}`);
              assert.equal(requests.length, 0);
            }
          }
        }
        assert.equal(await run(supportedSchema), 'done');
        assert.equal(await run(supportedSchema, 'options', 'structured'), 'done');
        assert.equal(requests.length, 2, 'Each positive control must reach this same HTTP endpoint once');
        for (const request of requests) {
          assert.equal(request.stream, mode !== 'invoke' || type === 'llama_cpp');
          assert.deepEqual(anthropic ? request.tools[0].input_schema : request.tools[0].function.parameters, supportedSchema);
        }
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
