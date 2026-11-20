import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { MemorySaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const options = { platform: 'node', tempDir: 'tests/unit', external: ['@langchain/*', 'langchain', 'zod'] };
const { createRunCorrectionMiddleware, createRunUsageMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/run-usage-middleware.ts', options);
const { runInputMessageId } = await importTypeScriptModule('src/main/services/deep-agent/run-usage-ledger.ts', options);
const { RunUsageObserver } = await importTypeScriptModule('src/main/services/deep-agent/run-usage-observer.ts', options);
const { createModelOutputIntegrityMiddleware } = await importTypeScriptModule(
  'src/main/services/forge-guardrails/middleware/model-output-integrity.ts', options);
const { createResponseContractMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/response-contract-middleware.ts', options);

const limits = { policyVersion: 1, contextWindowTokens: 10000, maxOutputTokens: 200 };
const failure = () => new Error('provider_failure');
const reply = (id, content = 'done', rest = {}) => new AIMessage({ id, content,
  usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, ...rest });
const original = () => new HumanMessage({ id: 'original', content: 'Perform the task.' });
const correction = (id, content) => new HumanMessage({ id: runInputMessageId('run', id), content });

function fixture(steps, { middleware = [], tools = [] } = {}) {
  const inbox = [], requests = [], checkpointer = new MemorySaver();
  const config = { configurable: { thread_id: 'thread' } };
  const ledger = {
    readRunInputs: runId => inbox.filter(item => item.runId === runId).map(item => ({ ...item })),
    consumeCorrections: (runId, ids) => inbox.forEach(item => {
      if (item.runId === runId && ids.includes(runInputMessageId(runId, item.submissionId))) item.status = 'consumed';
    }),
    ownsLegacyInputMessage: (runId, submissionId) => !inbox.some(item => item.runId !== runId && item.submissionId === submissionId),
    reserve() {}, settle() {}, recordModelObservation() {}, readUsageStatus: () => ({})
  };
  class Model extends BaseChatModel {
    _llmType() { return 'run-input-projection-fixture'; }
    bindTools() { return this; }
    async _generate(messages) {
      requests.push(messages);
      const step = steps[requests.length - 1];
      assert.ok(step, 'unexpected extra model call');
      if (step instanceof Error) throw step;
      return { generations: [{ message: step, text: typeof step.content === 'string' ? step.content : '' }] };
    }
  }
  return {
    inbox, requests, config,
    enqueue(submissionId, kind = 'steer', status = 'queued', runId = 'run') {
      const item = { runId, submissionId, sequence: inbox.length + 1, content: `Input ${submissionId}`, kind, status };
      inbox.push(item);
      return item;
    },
    agent(runId = 'run') {
      const observer = new RunUsageObserver(ledger, runId, limits, 'revision');
      return createAgent({ model: new Model({}), tools, checkpointer, middleware: [
        createRunCorrectionMiddleware(ledger, runId), ...middleware,
        createRunUsageMiddleware(ledger, runId, limits, observer)
      ] });
    }
  };
}

test('a consumed steer without a checkpoint projection survives provider failure and graph rebuild', async () => {
  const f = fixture([failure(), failure(), reply('complete')]);
  await assert.rejects(f.agent().invoke({ messages: [original()] }, f.config), /provider_failure/);
  const input = f.enqueue('late');
  await assert.rejects(f.agent().invoke(null, f.config), /provider_failure/);
  assert.equal(input.status, 'consumed', 'the receipt records provider delivery even when the call fails');
  const failed = await f.agent().getState(f.config);
  assert.deepEqual(failed.values.messages.map(message => message.id), ['original']);
  assert.equal(failed.values.rocRunInputProjection, undefined);

  const result = await f.agent().invoke(null, f.config);
  assert.deepEqual(f.requests[2].map(message => message.id), ['original', runInputMessageId('run', 'late')]);
  assert.deepEqual(result.messages.map(message => message.id), ['original', runInputMessageId('run', 'late'), 'complete']);
  assert.deepEqual(result.rocRunInputProjection, { runId: 'run', submissionIds: ['late'] });
});

test('saved model resume restores a consumed follow-up while leaving queued follow-ups at the turn boundary', async () => {
  const f = fixture([failure(), reply('complete')]);
  await assert.rejects(f.agent().invoke({ messages: [original()] }, f.config), /provider_failure/);
  f.enqueue('delivered-follow-up', 'follow_up', 'consumed');
  const queued = f.enqueue('queued-follow-up', 'follow_up');
  const result = await f.agent().invoke(null, f.config);
  assert.deepEqual(f.requests[1].map(message => message.id), ['original', runInputMessageId('run', 'delivered-follow-up')]);
  assert.deepEqual(result.messages.map(message => message.id), ['original', runInputMessageId('run', 'delivered-follow-up'), 'complete']);
  assert.equal(queued.status, 'queued');
});

test('late input keeps native output-integrity and response-contract hooks on the AI response', async () => {
  let effects = 0;
  const f = fixture([failure(), reply('truncated', '', {
    tool_calls: [{ id: 'partial-call', name: 'write_effect', args: { value: 'partial' } }],
    response_metadata: { finish_reason: 'length' }
  }), reply('invalid', 'Invalid JSON'), reply('valid', '{"ok":true}')], {
    tools: [tool(async () => { effects++; return 'saved'; }, {
      name: 'write_effect', description: 'Write a value.', schema: z.object({ value: z.string() })
    })],
    middleware: [createResponseContractMiddleware('run', { format: 'json', schema: {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false
    } }), createModelOutputIntegrityMiddleware('run')]
  });
  await assert.rejects(f.agent().invoke({ messages: [original()] }, f.config), /provider_failure/);
  f.enqueue('late');
  const result = await f.agent().invoke(null, f.config);
  assert.equal(effects, 0, 'truncated tool proposals must never execute');
  assert.equal(f.requests.length, 4);
  assert.equal(result.messages.at(-1).content, '{"ok":true}');
  assert.deepEqual(result.rocOutputCorrection, { runId: 'run', attempts: 1 });
  assert.deepEqual(result.rocResponseCorrection, { runId: 'run', attempts: 1 });
  assert.equal(result.messages.find(message => message.tool_call_id === 'partial-call')?.status, 'error');
  assert.equal(result.messages.filter(message => message.id === runInputMessageId('run', 'late')).length, 1);
  assert.ok(f.requests[2].some(message => message.tool_call_id === 'partial-call'));
  assert.ok(f.requests[3].some(message => message.id === 'roc-response-correction:run'));
});

test('checkpoint projection prevents reinserting inputs removed by later context compaction', async () => {
  const f = fixture([reply('first'), reply('second')]);
  const input = f.enqueue('projected');
  const first = await f.agent().invoke({ messages: [original()] }, f.config);
  assert.equal(input.status, 'consumed');
  assert.deepEqual(first.rocRunInputProjection, { runId: 'run', submissionIds: ['projected'] });
  await f.agent().updateState(f.config, { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), original(),
    new AIMessage({ id: 'summary', content: 'The delivered input has been incorporated into this context summary.' })] });
  const result = await f.agent().invoke({ messages: [new HumanMessage('Continue.')] }, f.config);
  assert.ok(f.requests[1].every(message => message.id !== runInputMessageId('run', 'projected')));
  assert.ok(result.messages.every(message => message.id !== runInputMessageId('run', 'projected')));
  assert.deepEqual(result.rocRunInputProjection, first.rocRunInputProjection);
});

test('completed-boundary follow-ups gain checkpoint projection and a new run has an independent projection', async () => {
  const f = fixture([reply('first'), reply('second')]);
  const first = f.enqueue('same-id', 'follow_up');
  const result = await f.agent().invoke({ messages: [original(), correction(first.submissionId, first.content)] }, f.config);
  assert.equal(first.status, 'consumed');
  assert.deepEqual(result.rocRunInputProjection, { runId: 'run', submissionIds: ['same-id'] });
  const second = f.enqueue('same-id', 'steer', 'queued', 'next-run');
  second.content = 'A different correction in the next run.';
  const next = await f.agent('next-run').invoke({ messages: [new HumanMessage('New run.')] }, f.config);
  assert.ok(f.requests[1].some(message => message.id === runInputMessageId('run', 'same-id') && message.content === first.content));
  assert.ok(f.requests[1].some(message => message.id === runInputMessageId('next-run', 'same-id') && message.content === second.content));
  assert.equal(second.status, 'consumed');
  assert.equal(next.messages.filter(message => message.id === runInputMessageId('run', 'same-id')).length, 1);
  assert.equal(next.messages.filter(message => message.id === runInputMessageId('next-run', 'same-id')).length, 1);
  assert.deepEqual(next.rocRunInputProjection, { runId: 'next-run', submissionIds: ['same-id'] });
});

test('legacy checkpoint input gains projection without duplication when its run ownership is unambiguous', async () => {
  const f = fixture([reply('complete')]);
  const input = f.enqueue('legacy', 'steer', 'consumed');
  const result = await f.agent().invoke({ messages: [original(),
    new HumanMessage({ id: 'roc-correction:legacy', content: input.content })] }, f.config);
  assert.equal(result.messages.filter(message => message.content === input.content).length, 1);
  assert.deepEqual(result.rocRunInputProjection, { runId: 'run', submissionIds: ['legacy'] });
});

test('a different run cannot inherit a legacy message projection with the same submission ID', async () => {
  const f = fixture([reply('complete')]);
  const old = f.enqueue('legacy', 'steer', 'consumed', 'old-run');
  const current = f.enqueue('legacy');
  current.content = 'A replacement instruction for the current run.';
  const result = await f.agent().invoke({ messages: [original(),
    new HumanMessage({ id: 'roc-correction:legacy', content: old.content })] }, f.config);
  assert.ok(f.requests[0].some(message => message.id === runInputMessageId('run', 'legacy') && message.content === current.content));
  assert.ok(result.messages.some(message => message.id === 'roc-correction:legacy' && message.content === old.content));
  assert.equal(current.status, 'consumed');
});
