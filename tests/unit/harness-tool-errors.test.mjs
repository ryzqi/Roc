import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool, ToolInputParsingException } from '@langchain/core/tools';
import { GraphBubbleUp, GraphInterrupt } from '@langchain/langgraph';
import { createAgent, MiddlewareError, ToolInvocationError, toolRetryMiddleware } from 'langchain';
import { z } from 'zod';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

// One bundle preserves class identity between the middleware and its errors.
const root = testArtifacts('harness-tool-errors');
const outfile = join(root, 'api.mjs');
await build({
  stdin: { contents: `
    export * from './src/main/services/forge-guardrails/middleware/tool-resolution';
    export * from './src/main/services/forge-guardrails/middleware/tool-runtime-errors';
    export * from './src/main/services/forge-guardrails/middleware/forge-tiered-compaction';
    export * from './src/main/services/forge-guardrails/errors';
    export * from './src/main/services/forge-guardrails/message-tags';
    export * from './src/main/services/forge-guardrails/state-schema';
    export { RocDomainError } from './src/main/services/errors';
    export { createRunUsageMiddleware } from './src/main/services/deep-agent/run-usage-middleware';
    export { createToolEffectIdempotencyMiddleware } from './src/main/services/deep-agent/tool-effect-idempotency';
  `, resolveDir: process.cwd(), sourcefile: 'harness-tool-errors-entry.ts' },
  outfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent'
});
const api = await import(outfile);
const runtime = api.createToolRuntimeErrorMiddleware();
const resolution = api.createToolResolutionMiddleware();
const request = (name = 'read_record', id = 'call-1') => ({
  toolCall: { name, id, args: {}, type: 'tool_call' },
  runtime: { signal: new AbortController().signal }
});
const rejectWith = error => async () => { throw error; };
const wrapped = error => MiddlewareError.wrap(MiddlewareError.wrap(error, 'inner'), 'outer');

test('resolution failures preserve call identity and recovery guidance with truthful status and redaction', async () => {
  const error = new api.RocToolResolutionError('Unknown previewId token=fixture-secret. Call propose_background_task first.');
  for (const failure of [error, wrapped(error)]) {
    const result = await runtime.wrapToolCall(request('schedule_background_task'), input =>
      resolution.wrapToolCall(input, rejectWith(failure)));
    assert.equal(result.status, 'error');
    assert.equal(result.tool_call_id, 'call-1');
    assert.equal(result.name, 'schedule_background_task');
    assert.equal(api.readForgeMessageTag(result), 'forge:tool_resolution');
    assert.match(result.content, /^\[ToolResolutionError\].*\[REDACTED\]/);
    assert.match(result.content, /Call propose_background_task first/);
    assert.doesNotMatch(result.content, /fixture-secret/);
  }
});

test('resolution error tags still protect feedback from tiered compaction', async () => {
  const result = await resolution.wrapToolCall(request(), rejectWith(new api.RocToolResolutionError('Correct the record id. '.repeat(30))));
  api.markIterationOnMessage(result, 0);
  const ordinary = api.markIterationOnMessage(new ToolMessage({ content: 'old output'.repeat(40), tool_call_id: 'old' }), 0);
  const messages = [new HumanMessage('Read a record.'), ordinary, result,
    api.markIterationOnMessage(new AIMessage('Continue.'), 3)];
  const original = result.content;
  for (const edit of api.createForgeTieredCompactionEdits({ capacityTokens: 1, keepRecent: 0 })) {
    await edit.apply({ messages, countTokens: async () => 100 });
  }
  assert.ok(messages.includes(result));
  assert.equal(result.content, original);
  assert.equal(result.status, 'error');
  assert.equal(messages.some(message => message.tool_call_id === 'old'), false);
});

test('resolution middleware passes unrelated failures and successful results through unchanged', async () => {
  const error = wrapped(new Error('unexpected'));
  await assert.rejects(resolution.wrapToolCall(request(), rejectWith(error)), actual => actual === error);
  const success = new ToolMessage({ content: 'record found', tool_call_id: 'call-1', status: 'success' });
  for (const middleware of [runtime, resolution]) {
    assert.equal(await middleware.wrapToolCall(request(), async () => success), success);
  }
});

test('both error boundaries keep deterministic fallback ids', async () => {
  for (const [middleware, error] of [[resolution, new api.RocToolResolutionError('missing record')], [runtime, new Error('failed')]]) {
    const input = request();
    delete input.toolCall.id;
    assert.equal((await middleware.wrapToolCall(input, rejectWith(error))).tool_call_id, 'unknown_read_record');
  }
});

test('resolution failure settles usage as failed and keeps idempotency failure non-retryable', async () => {
  const settlements = [], progress = [], effectFailures = [];
  let reservations = 0, starts = 0;
  const ledger = {
    reserve: () => reservations++, settle: (...args) => settlements.push(args),
    recordProgress: (...args) => progress.push(args)
  };
  const usage = api.createRunUsageMiddleware(ledger, 'run', {}, {});
  const effects = api.createToolEffectIdempotencyMiddleware({ runId: 'run', threadId: 'thread',
    capabilityManifest: { tools: [{ modelVisibleName: 'task', canonicalIdentity: 'agent.task', toolVersion: 'v1',
      idempotencyStrategy: 'tool_call', effectClass: 'workspace_mutation', reconcileStrategy: 'retry_safe' }] },
    store: {
      beginOperation: () => ({ kind: 'execute', lease: { operationId: 'operation', idempotencyKey: 'key',
        toolCallId: 'call-1', toolName: 'task', canonicalToolIdentity: 'agent.task', toolVersion: 'v1',
        attemptId: 'attempt', leaseGeneration: 1 } }),
      markStarted: () => starts++, finishError: (...args) => effectFailures.push(args),
      finishSuccess: () => assert.fail('resolution failure must never record success')
    }
  });
  const input = request('task');
  input.toolCall.args = { description: 'Read the record.', subagent_type: 'research' };
  input.runtime.configurable = { checkpoint_ns: 'tools:fixture', checkpoint_map: { '': 'checkpoint' }, ls_agent_type: 'root' };
  const error = new api.RocToolResolutionError('Missing record id.');
  // Match the production nesting: usage > runtime > resolution > idempotency.
  const result = await usage.wrapToolCall(input, a => runtime.wrapToolCall(a, b =>
    resolution.wrapToolCall(b, c => effects.wrapToolCall(c, rejectWith(error)))));
  assert.equal(result.status, 'error');
  assert.equal(reservations, 1);
  assert.equal(starts, 1);
  assert.equal(settlements.length, 1);
  assert.deepEqual(settlements[0][5], { outcomeStatus: 'failed', failureCode: 'child_task_reported_error' });
  assert.equal(progress[0][3].status, 'error');
  assert.equal(effectFailures.length, 1);
  assert.equal(effectFailures[0][1], error);
  assert.equal(effectFailures[0][2], false);
});

test('runtime errors redact Error fields, non-Error strings and domain recovery actions', async () => {
  const failures = [
    new Error('Authorization: Bearer fixture-bearer'),
    Object.assign(new Error('api_key=fixture-key'), { name: 'Error password=fixture-name' }),
    'credential=fixture-string',
    { toString: () => 'token=fixture-object' },
    new api.RocDomainError({ code: 'record_unavailable', category: 'validation', retryable: false,
      message: 'token=fixture-domain', userAction: 'Update credential=fixture-action in settings.' }),
    new api.RocDomainError({ code: 'record_missing', category: 'validation', retryable: false, message: 'password=fixture-domain' })
  ];
  for (const error of failures) {
    const result = await runtime.wrapToolCall(request(), rejectWith(error instanceof Error ? wrapped(error) : error));
    assert.equal(result.status, 'error');
    assert.equal(result.name, 'read_record');
    assert.equal(result.tool_call_id, 'call-1');
    assert.match(result.content, /\[REDACTED\]/);
    assert.doesNotMatch(result.content, /fixture-/);
    if (error.userAction) {
      assert.match(result.content, /\[RocToolError\] record_unavailable/);
      assert.match(result.content, /Update credential=\[REDACTED\] in settings/);
    }
  }
});

test('schema feedback recognizes only parsing exceptions and omits raw invocation arguments and stacks', async () => {
  const parsing = new ToolInputParsingException('Expected integer at limit; token=fixture-schema', 'raw-private-output');
  const invocation = new ToolInvocationError(parsing, { name: 'read_record', args: { private: 'raw-private-argument' } });
  for (const error of [parsing, invocation, wrapped(invocation)]) {
    const result = await runtime.wrapToolCall(request(), rejectWith(error));
    assert.match(result.content, /Invalid tool arguments: Expected integer at limit/);
    assert.match(result.content, /Check the tool schema and correct required fields, value types, and allowed values/);
    assert.match(result.content, /\[REDACTED\]/);
    assert.doesNotMatch(result.content, /fixture-schema|raw-private|kwargs|\n\s+at /);
  }
  for (const error of [new Error('Received tool input did not match expected schema'),
    Object.assign(new Error('implementation failed'), { name: 'ToolInputParsingException' })]) {
    const result = await runtime.wrapToolCall(request(), rejectWith(error));
    assert.doesNotMatch(result.content, /Invalid tool arguments|Check the tool schema/);
  }
});

test('installed agent feeds a redacted schema failure back to the model, then executes only corrected arguments', async () => {
  let modelCalls = 0, toolCalls = 0;
  const readRecord = tool(async ({ limit }) => { toolCalls++; return `read ${limit}`; }, {
    name: 'read_record', description: 'Read records.', schema: z.object({ limit: z.number().int() })
  });
  class Model extends BaseChatModel {
    _llmType() { return 'harness-tool-error-regression'; }
    bindTools() { return this; }
    async _generate(messages) {
      assert.ok(++modelCalls <= 3, 'model must recover in one corrected call');
      if (modelCalls === 2) {
        const result = messages.find(message => message.tool_call_id === 'invalid');
        assert.equal(result?.status, 'error');
        assert.match(result.content, /Invalid tool arguments/);
        assert.match(result.content, /limit/);
        assert.match(result.content, /Check the tool schema/);
        assert.doesNotMatch(result.content, /fixture-secret|raw-private-argument|kwargs|\n\s+at /);
        assert.equal(toolCalls, 0, 'invalid arguments must never reach the tool');
      }
      if (modelCalls === 3) {
        assert.equal(messages.find(message => message.tool_call_id === 'corrected')?.content, 'read 2');
      }
      const message = modelCalls === 3 ? new AIMessage('Done.') : new AIMessage({ content: '', tool_calls: [{
        id: modelCalls === 1 ? 'invalid' : 'corrected', name: 'read_record', type: 'tool_call',
        args: modelCalls === 1 ? { limit: 'token=fixture-secret', private: 'raw-private-argument' } : { limit: 2 }
      }] });
      return { generations: [{ text: '', message }] };
    }
  }
  const agent = createAgent({ model: new Model({ maxRetries: 0 }), tools: [readRecord], middleware: [runtime, resolution] });
  await agent.invoke({ messages: [new HumanMessage('Read two records.')] });
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
});

test('graph control flow and existing cancellation forms propagate unchanged', async () => {
  const failures = [new GraphBubbleUp('bubble'), new GraphInterrupt([{ value: 'approval needed', id: 'approval' }]),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }), new Error('AbortError: cancelled'), new Error('Cancel requested')];
  for (const failure of failures) {
    for (const error of [failure, wrapped(failure)]) {
      for (const middleware of [runtime, resolution]) {
        await assert.rejects(middleware.wrapToolCall(request(), rejectWith(error)), actual => actual === error);
      }
      assert.equal(api.shouldRetryNetworkToolError(error), false);
      assert.throws(() => api.handleNetworkToolRetryFailure(error), actual => actual === error);
    }
  }
});

test('network failures retain retry ownership, attempts and redacted exhaustion feedback', async () => {
  const retry = toolRetryMiddleware({ maxRetries: 2, tools: ['web_read', 'web_search'], initialDelayMs: 0, jitter: false,
    retryOn: api.shouldRetryNetworkToolError, onFailure: api.handleNetworkToolRetryFailure });
  for (const name of ['web_read', 'web_search']) {
    let attempts = 0;
    const error = wrapped(new TypeError('fetch failed Authorization: Bearer fixture-network'));
    await assert.rejects(runtime.wrapToolCall(request(name), rejectWith(error)), actual => actual === error);
    const result = await retry.wrapToolCall(request(name), input => runtime.wrapToolCall(input, async () => {
      attempts++; throw error;
    }));
    assert.equal(attempts, 3);
    assert.equal(result.status, 'error');
    assert.match(result.content, /\[REDACTED\]/);
    assert.doesNotMatch(result.content, /fixture-network/);

    attempts = 0;
    const success = new ToolMessage({ content: 'found', tool_call_id: 'call-1', status: 'success' });
    assert.equal(await retry.wrapToolCall(request(name), input => runtime.wrapToolCall(input, async () => {
      if (++attempts < 3) throw error;
      return success;
    })), success);
    assert.equal(attempts, 3);

    for (const failure of [Object.assign(new Error('unauthorized'), { status: 401 }),
      new ToolInputParsingException('Expected query'), new Error('Cancel requested'), new GraphBubbleUp('bubble')]) {
      attempts = 0;
      const nonRetryable = wrapped(failure);
      await assert.rejects(retry.wrapToolCall(request(name), input => runtime.wrapToolCall(input, async () => {
        attempts++; throw nonRetryable;
      })), actual => actual === nonRetryable);
      assert.equal(attempts, 1);
    }
  }
});
