import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import { z } from 'zod';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const packages = JSON.parse(readFileSync('package.json', 'utf8'));
const { readDeepAgentsExecutionIdentity, readCurrentDeepAgentsExecutionIdentity } = await importTypeScriptModule(
  'src/main/services/deep-agent/deep-agents-execution-identity-adapter.ts', {
    platform: 'node', tempDir: testArtifacts('langgraph-execution-identity'),
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)]
  }
);

test('public LangGraph executionInfo supplies stable checkpoint keys and explicit scope', () => {
  const executionInfo = { checkpointId: 'checkpoint-1', checkpointNs: 'research:1|tools:2',
    taskId: 'tool-task-1', threadId: 'thread-1', nodeAttempt: 1 };
  assert.deepEqual(readDeepAgentsExecutionIdentity(executionInfo, 'main'), {
    executionPath: 'main', checkpointId: 'checkpoint-1'
  });
  assert.deepEqual(readDeepAgentsExecutionIdentity(executionInfo, 'subagent'), {
    executionPath: 'subagent/research:1|tools:2', checkpointId: 'checkpoint-1'
  });
  assert.deepEqual(readDeepAgentsExecutionIdentity({ ...executionInfo, nodeAttempt: 2 }, 'subagent'),
    readDeepAgentsExecutionIdentity(executionInfo, 'subagent'), 'retry must retain the operation identity');
  assert.notDeepEqual(readDeepAgentsExecutionIdentity({ ...executionInfo, checkpointNs: 'research:3|tools:2' }, 'subagent'),
    readDeepAgentsExecutionIdentity(executionInfo, 'subagent'), 'concurrent subagent namespaces must not collide');
});

test('missing public execution identity always fails closed, even with legacy private config fields', () => {
  for (const value of [null, undefined, {}, { checkpointId: 'c', checkpointNs: 'tools:x' },
    { checkpointId: '', checkpointNs: 'tools:x', taskId: 't' },
    { checkpointId: 'c', checkpointNs: null, taskId: 't' },
    { checkpoint_ns: 'tools:x', checkpoint_map: { '': 'c' }, ls_agent_type: 'root' }]) {
    assert.equal(readDeepAgentsExecutionIdentity(value, 'main'), null);
  }
});

test('public LangGraph executionInfo remains readable inside ToolNode middleware', async () => {
  const observed = [];
  let requests = 0;
  const model = new ChatOpenAI({
    model: 'fixture-execution-info', apiKey: 'test-only', streaming: false, maxRetries: 0,
    configuration: { baseURL: 'http://fixture.invalid/v1', fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      requests++;
      return new Response(JSON.stringify({
        id: `fixture-${requests}`, object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, finish_reason: requests === 1 ? 'tool_calls' : 'stop', message: requests === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function',
              function: { name: 'probe', arguments: '{}' } }] }
          : { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
      }), { headers: { 'content-type': 'application/json' } });
    } }
  });
  const agent = createAgent({
    model, checkpointer: new MemorySaver(),
    tools: [tool(async () => 'ok', { name: 'probe', description: 'Probe the runtime.', schema: z.object({}) })],
    middleware: [createMiddleware({ name: 'ObserveExecutionInfo', wrapToolCall: async (request, handler) => {
      observed.push(readCurrentDeepAgentsExecutionIdentity(request.runtime, 'main'));
      return handler(request);
    } })]
  });
  const result = await agent.invoke({ messages: [new HumanMessage('Call probe once.')] },
    { configurable: { thread_id: 'execution-info-fixture' } });
  assert.equal(requests, 2);
  assert.equal(result.messages.at(-1)?.content, 'done');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.executionPath, 'main');
  assert.ok(observed[0]?.checkpointId);
});
