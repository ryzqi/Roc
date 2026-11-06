import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatModelStream } from '@langchain/core/language_models/stream';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { adaptDeepAgentRun } = await importTypeScriptModule(
  'src/main/services/deep-agent/deep-agent-stream-adapter.ts',
  { platform: 'node', tempDir: '.artifacts/research-harness/S01/stream-role' }
);

async function* values(items) { yield* items; }
function handle(stream) {
  // LangGraph exposes an Omit<ChatModelStream, "then"> view so for-await
  // does not resolve the handle into its final AIMessage.
  return {
    namespace: [], node: 'model', text: stream.text, reasoning: stream.reasoning,
    toolCalls: stream.toolCalls, usage: stream.usage, output: stream.output,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]()
  };
}
function message(role, text) {
  // Use the installed Core handle: its output always assembles an AIMessage,
  // including when LangGraph supplied human/system input in message-start.
  return handle(new ChatModelStream(values([
    { event: 'message-start', ...(role === undefined ? {} : { role }) },
    { event: 'content-block-start', index: 0, content: { type: 'text', text: '' } },
    { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text } },
    { event: 'content-block-finish', index: 0, content: { type: 'text', text } },
    { event: 'message-finish' }
  ])));
}
function run(messages, subagents = []) {
  return adaptDeepAgentRun({
    messages: values(messages), toolCalls: values([]), subagents: values(subagents),
    output: Promise.resolve({ messages: [{ role: 'assistant', content: 'answer' }] }),
    interrupted: false
  }, { projectToolOutput: ({ output }) => output });
}

test('message-start role excludes input messages even though Core output reports AIMessage', async () => {
  const human = message('human', 'internal context contract');
  assert.equal((await human.output).type, 'ai');
  const adapted = run([
    human, message('system', 'system instruction'), message('user', 'user input'),
    message(undefined, 'answer'), message('assistant', ' explicit assistant')
  ]);
  const events = [];
  for await (const event of adapted.events) events.push(event);
  assert.equal(events.filter(event => event.type === 'assistant_delta').map(event => event.text).join(''),
    'answer explicit assistant');
  assert.equal(await adapted.output, 'answer');
});

test('subagent message-start role uses the same visibility boundary', async () => {
  const adapted = run([], [{
    name: 'researcher', cause: undefined, messages: values([
      message('human', 'private subagent instruction'), message(undefined, 'subagent answer')
    ]), toolCalls: values([]), subagents: values([]),
    output: Promise.resolve({ messages: [{ role: 'assistant', content: 'subagent answer' }] })
  }]);
  const events = [];
  for await (const event of adapted.events) events.push(event);
  const text = events.filter(event => event.type === 'assistant_delta');
  assert.deepEqual(text.map(event => event.text), ['subagent answer']);
  assert.equal(text[0].scope.name, 'researcher');
});

test('assistant text streams before message completion and retains usage', { timeout: 5000 }, async () => {
  const { promise: finished, resolve: finish } = Promise.withResolvers();
  const stream = handle(new ChatModelStream((async function* () {
    yield { event: 'message-start' };
    yield { event: 'content-block-start', index: 0, content: { type: 'text', text: '' } };
    yield { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: 'first token' } };
    await finished;
    yield { event: 'message-finish', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  })()));
  const events = [];
  try {
    for await (const event of run([stream]).events) {
      events.push(event);
      if (event.type === 'assistant_delta') finish();
    }
    assert.equal(events.find(event => event.type === 'assistant_delta').text, 'first token');
    assert.equal(events.find(event => event.type === 'usage').usage.totalTokens, 12);
  } finally { finish(); }
});

test('malformed message role fails before visible output', async () => {
  const adapted = run([message('unexpected-role', 'must not be visible')]);
  const events = [];
  await assert.rejects(async () => {
    for await (const event of adapted.events) events.push(event);
  }, /deep_agents_v3_message_role_invalid/);
  assert.equal(events.some(event => event.type === 'assistant_delta'), false);
});
