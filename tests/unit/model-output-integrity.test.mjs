import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import { createDeepAgent, createSubAgent } from 'deepagents';
import { z } from 'zod';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const root = testArtifacts('model-output-integrity');
const options = { platform: 'node', tempDir: root, external: ['@langchain/*', 'langchain', 'zod'] };
const { createModelOutputIntegrityMiddleware } = await importTypeScriptModule(
  'src/main/services/forge-guardrails/middleware/model-output-integrity.ts', options);
const { createRescueParsingMiddleware } = await importTypeScriptModule(
  'src/main/services/forge-guardrails/middleware/rescue-parsing.ts', options);
const { readModelOutputCompletion } = await importTypeScriptModule('src/main/services/model-output-completion.ts');

function response(provider, request, index, { truncated = false, rescue = false, final = false, value = 'complete', partialArgs = false, invalidArgs = false } = {}) {
  const id = `response-${index}`;
  const call = { id: `call-${index}`, name: truncated ? 'blocked_effect' : 'apply_effect', args: { value } };
  const text = final ? 'Done.' : JSON.stringify({ name: call.name, arguments: call.args });
  const native = !rescue && !final;
  const argsText = invalidArgs ? '{"value":bad}' : partialArgs ? JSON.stringify(call.args).slice(0, -1) : JSON.stringify(call.args);
  const reason = provider === 'openai' ? (truncated ? 'length' : final ? 'stop' : 'tool_calls')
    : (truncated ? 'max_tokens' : final ? 'end_turn' : 'tool_use');
  if (!request.stream) {
    const body = provider === 'openai'
      ? { id, object: 'chat.completion', created: 0, model: 'fixture-model',
        choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: native ? null : text,
          ...(native ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: argsText } }] } : {}) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : { id, type: 'message', role: 'assistant', model: 'fixture-model', stop_reason: reason, stop_sequence: null,
        content: native ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }
  let events;
  if (provider === 'openai') {
    const chunk = delta => ({ id, object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: null }] });
    const args = argsText, middle = Math.floor(args.length / 2);
    events = native ? [
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, middle) } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] })
    ] : [chunk({ role: 'assistant', content: text.slice(0, 8) }), chunk({ content: text.slice(8) })];
    events.push({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    events.push({ ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }
  events = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fixture-model',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: native
    ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } }];
  const data = native ? JSON.stringify(call.args) : text, middle = Math.floor(data.length / 2);
  for (const part of [data.slice(0, middle), data.slice(middle)]) events.push({ type: 'content_block_delta', index: 0,
    delta: native ? { type: 'input_json_delta', partial_json: part } : { type: 'text_delta', text: part } });
  events.push({ type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(provider, streaming, steps, name) {
  const requests = [], effects = [], file = join(root, `${name}.txt`);
  writeFileSync(file, 'unchanged');
  const fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    assert.ok(requests.length <= steps.length, 'correction must be bounded');
    return response(provider, body, requests.length, steps[requests.length - 1]);
  };
  const model = provider === 'openai'
    ? new ChatOpenAI({ model: 'fixture-model', apiKey: 'fixture', streaming, maxRetries: 0, maxTokens: 128,
      configuration: { baseURL: 'http://fixture.invalid/v1', fetch } })
    : new ChatAnthropic({ model: 'fixture-model', apiKey: 'fixture', streaming, maxRetries: 0, maxTokens: 128,
      clientOptions: { baseURL: 'http://fixture.invalid', fetch } });
  const tools = ['blocked_effect', 'apply_effect'].map(name => tool(async ({ value }) => {
    effects.push({ name, value }); writeFileSync(file, value); return 'saved';
  }, { name, description: 'Save the supplied value.', schema: z.object({ value: z.string() }) }));
  const middleware = runId => [createModelOutputIntegrityMiddleware(runId),
    createRescueParsingMiddleware({ availableTools: () => ['blocked_effect', 'apply_effect'] })];
  return { model, tools, middleware, requests, effects, file };
}

test('completion classification preserves unknown compatibility and recognizes normalized/provider metadata', () => {
  for (const value of [{ finish_reason: 'length' }, { stop_reason: 'max_tokens' }, { status: 'incomplete' }]) {
    assert.equal(readModelOutputCompletion(value), 'truncated');
  }
  for (const value of [{ finish_reason: 'tool_calls' }, { finish_reason: 'tool_use' }, { stop_reason: 'tool_use' },
    { finish_reason: 'stop' }, { stop_reason: 'end_turn' }, { status: 'completed' }]) assert.equal(readModelOutputCompletion(value), 'complete');
  for (const value of [{}, { finish_reason: null }, { stop_reason: 'provider_specific' }]) assert.equal(readModelOutputCompletion(value), 'unknown');
  assert.equal(readModelOutputCompletion({}, { stop_reason: 'max_tokens' }), 'truncated');
  assert.equal(readModelOutputCompletion({ finish_reason: 'stop' }, { stop_reason: 'max_tokens' }), 'truncated');
});

for (const provider of ['openai', 'anthropic']) for (const streaming of [false, true]) for (const rescue of [false, true]) {
  test(`Deep Agents ${provider} ${streaming ? 'SSE' : 'JSON'} ${rescue ? 'rescue' : 'native'} rejects truncated calls before approval`, async () => {
    const f = fixture(provider, streaming, [{ truncated: true, rescue, value: 'partial' }, {}, { final: true }], `${provider}-${streaming}-${rescue}`);
    const agent = createDeepAgent({ model: f.model, tools: f.tools, middleware: f.middleware('run'),
      interruptOn: { blocked_effect: true }, checkpointer: new MemorySaver() });
    const result = await agent.invoke({ messages: [new HumanMessage('Save the complete value.')] },
      { configurable: { thread_id: 'thread' } });
    assert.equal(result.__interrupt__, undefined, `an incomplete proposal must not request approval: ${JSON.stringify(result.messages.find(message => AIMessage.isInstance(message))?.response_metadata)}`);
    assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
    assert.equal(readFileSync(f.file, 'utf8'), 'complete');
    assert.equal(f.requests.length, 3);
    assert.ok(f.requests.every(request => Boolean(request.stream) === streaming));
    assert.match(JSON.stringify(f.requests[1].messages), /No tools from that response were executed/);
    const rejected = result.messages.find(message => message.tool_call_id === 'call-1');
    if (!rescue) { assert.equal(rejected?.status, 'error'); assert.equal(rejected?.name, 'blocked_effect'); }
    const first = result.messages.find(message => AIMessage.isInstance(message));
    assert.equal(first.usage_metadata.output_tokens, 5);
    assert.equal(readModelOutputCompletion(first.response_metadata, first.additional_kwargs), 'truncated');
    assert.deepEqual(result.rocOutputCorrection, { runId: 'run', attempts: 1 });
  });
}

test('checkpoint state bounds correction after rebuilding the graph and gives a new run its own correction', async () => {
  const f = fixture('openai', false, [{ truncated: true }, { truncated: true }, {}, { final: true }], 'bounded');
  const checkpointer = new MemorySaver(), config = { configurable: { thread_id: 'bounded' } };
  const make = runId => createAgent({ model: f.model, tools: f.tools, middleware: f.middleware(runId), checkpointer });
  await assert.rejects(make('first').invoke({ messages: [new HumanMessage('Save.')] }, config), /模型响应.*输出限制/);
  assert.equal(f.requests.length, 2); assert.equal(f.effects.length, 0);
  assert.equal(readFileSync(f.file, 'utf8'), 'unchanged');
  await assert.rejects(make('first').invoke(null, config), /模型响应.*输出限制/);
  assert.equal(f.requests.length, 2, 'resume must not replenish the correction');
  const result = await make('second').invoke({ messages: [new HumanMessage('Try again with smaller output.')] }, config);
  assert.equal(result.messages.at(-1).content, 'Done.');
  assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
});

test('Deep Agents subagent uses the same integrity boundary without main-only rescue parsing', async () => {
  const f = fixture('anthropic', true, [{ truncated: true }, {}, { final: true }], 'subagent');
  const agent = createSubAgent({ name: 'researcher', description: 'Save research results.', model: f.model, tools: f.tools,
    middleware: [createModelOutputIntegrityMiddleware('child-run')], interruptOn: { blocked_effect: true } });
  const result = await agent.invoke({ messages: [new HumanMessage('Save research results.')] });
  assert.equal(result.__interrupt__, undefined);
  assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
});

test('incomplete SSE arguments parsed by LangChain still cannot execute after length termination', async () => {
  const f = fixture('openai', true, [{ truncated: true, partialArgs: true }, {}, { final: true }], 'partial-json');
  const agent = createAgent({ model: f.model, tools: f.tools, middleware: f.middleware('partial-json') });
  const result = await agent.invoke({ messages: [new HumanMessage('Save the complete value.')] });
  const rejected = result.messages.find(message => AIMessage.isInstance(message));
  assert.deepEqual(rejected.tool_calls[0].args, { value: 'complete' }, 'partial JSON is schema-valid after framework parsing');
  assert.equal(result.messages.find(message => message.tool_call_id === 'call-1').status, 'error');
  assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
});

test('complete rescued output executes normally without spending the correction allowance', async () => {
  const f = fixture('openai', false, [{ rescue: true }, { final: true }], 'complete-rescue');
  const agent = createAgent({ model: f.model, tools: f.tools, middleware: f.middleware('complete-rescue') });
  const result = await agent.invoke({ messages: [new HumanMessage('Save the complete value.')] });
  assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
  assert.equal(result.rocOutputCorrection, undefined);
});

test('unparseable truncated SSE calls retain a matching error result on the next provider request', async () => {
  const f = fixture('openai', true, [{ truncated: true, invalidArgs: true }, {}, { final: true }], 'invalid-json');
  const agent = createAgent({ model: f.model, tools: f.tools, middleware: f.middleware('invalid-json') });
  const result = await agent.invoke({ messages: [new HumanMessage('Save the complete value.')] });
  const rejected = result.messages.find(message => AIMessage.isInstance(message));
  assert.equal(rejected.tool_calls.length, 0);
  assert.equal(rejected.invalid_tool_calls[0].id, 'call-1');
  const request = f.requests[1].messages;
  const rawCalls = request.find(message => message.role === 'assistant').tool_calls;
  assert.deepEqual(rawCalls.map(call => call.id), ['call-1']);
  assert.deepEqual(request.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['call-1']);
  assert.deepEqual(f.effects, [{ name: 'apply_effect', value: 'complete' }]);
});

test('native v1 batch keeps content, usage and invalid calls while pairing every rejected executable call', async () => {
  const calls = [0, 1].map(index => ({ type: 'tool_call', id: `batch-${index}`, name: 'blocked_effect', args: { value: `partial-${index}` } }));
  const original = new AIMessage({ id: 'batch-response', name: 'fixture',
    content: [{ type: 'text', text: 'Saving.' }, ...calls], tool_calls: calls,
    invalid_tool_calls: [{ name: 'blocked_effect', id: 'invalid', args: '{', error: 'Invalid JSON', type: 'invalid_tool_call' }],
    response_metadata: { output_version: 'v1', finish_reason: 'length', provider_tag: 'retained' },
    usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    additional_kwargs: { provider_tag: 'retained' } });
  let modelCalls = 0, effects = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'output-integrity-batch-fixture'; }
    bindTools() { return this; }
    async _generate(messages) {
      assert.ok(++modelCalls <= 2);
      if (modelCalls === 2) {
        assert.equal(effects, 0);
        assert.deepEqual(messages.filter(message => message.tool_call_id).map(message => [message.tool_call_id, message.status]),
          calls.map(call => [call.id, 'error']));
      }
      return { generations: [{ text: '', message: modelCalls === 1 ? original : new AIMessage('Done.') }] };
    }
  }
  const agent = createDeepAgent({ model: new Model({ maxRetries: 0 }), tools: [tool(() => { effects++; return 'saved'; },
    { name: 'blocked_effect', description: 'Save content.', schema: z.object({ value: z.string() }) })],
    middleware: [createModelOutputIntegrityMiddleware('batch')], interruptOn: { blocked_effect: true }, checkpointer: new MemorySaver() });
  const result = await agent.invoke({ messages: [new HumanMessage('Save.')] }, { configurable: { thread_id: 'batch' } });
  assert.equal(result.__interrupt__, undefined);
  assert.equal(effects, 0);
  const rejected = result.messages.find(message => message.id === original.id);
  assert.equal(rejected.name, 'model', 'preserve the graph-assigned model name');
  for (const field of ['content', 'tool_calls', 'invalid_tool_calls', 'usage_metadata', 'response_metadata', 'additional_kwargs']) {
    assert.deepEqual(rejected[field], original[field], `${field} must survive the approval boundary`);
  }
});

test('cancellation after a truncated response prevents correction and tool execution', async () => {
  const f = fixture('openai', false, [{ truncated: true }], 'cancelled');
  const controller = new AbortController();
  const cancelAfterResponse = createMiddleware({ name: 'CancelAfterResponseFixture', wrapModelCall: async (request, handler) => {
    const result = await handler(request);
    controller.abort(new Error('User cancelled'));
    return result;
  } });
  const agent = createAgent({ model: f.model, tools: f.tools, middleware: [...f.middleware('cancelled'), cancelAfterResponse] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('Save.')] }, { signal: controller.signal }), /abort|cancel/i);
  assert.equal(f.requests.length, 1);
  assert.equal(f.effects.length, 0);
  assert.equal(readFileSync(f.file, 'utf8'), 'unchanged');
});
