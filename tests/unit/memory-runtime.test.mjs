import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MemorySaver, Command, InMemoryStore } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDeepAgent } from 'deepagents';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const packages = JSON.parse(readFileSync('package.json', 'utf8'));
const options = {platform: 'node', tempDir: testArtifacts('memory-runtime'),
  external: Object.keys(packages.dependencies)};
const { createCapabilityMemoryMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/framework-capability-middleware.ts', options);
const { MemoryStoreRepository } = await importTypeScriptModule('src/main/plugins/memory/memory-store-repository.ts', options);
const applicability = 'a'.repeat(64);
const source = '/memory/global/USER.md';

function graphFixture(interrupt = false) {
  let memory = 'MEMORY_OLD', reads = 0, executed = 0;
  const requests = [], checkpointer = new MemorySaver();
  const backend = { downloadFiles: async paths => {
    reads++;
    return paths.map(path => ({path, content: memory === null ? null : new TextEncoder().encode(memory),
      error: memory === null ? 'file_not_found' : null}));
  }};
  const model = new ChatOpenAI({model: 'fixture', apiKey: 'fixture', streaming: false, maxRetries: 0,
    configuration: {baseURL: 'http://fixture.invalid/v1', fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      const call = interrupt && requests.length === 1;
      return new Response(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call
          ? {role: 'assistant', content: '', tool_calls: [{id: 'call-1', type: 'function', function: {name: 'confirm_fixture', arguments: '{}'}}]}
          : {role: 'assistant', content: 'done'}}], usage: {prompt_tokens: 10, completion_tokens: 1, total_tokens: 11}
      }), {headers: {'content-type': 'application/json'}});
    }}});
  const newAgent = () => createDeepAgent({model, checkpointer, backend, memory: [source],
    tools: [tool(() => {executed++; return 'confirmed';}, {name: 'confirm_fixture', description: 'fixture', schema: z.object({})})],
    ...(interrupt ? {interruptOn: {confirm_fixture: true}} : {}),
    middleware: [createCapabilityMemoryMiddleware(backend, [source], {tools: [{modelVisibleName: 'edit_file', executionScopes: ['main']}]})]});
  const config = {configurable: {thread_id: 'same-thread'}};
  return {newAgent, config, requests, setMemory: value => {memory = value;}, reads: () => reads, executed: () => executed};
}

test('new invocations refresh edits and deletion on the same persisted thread', async () => {
  const f = graphFixture();
  for (const value of ['MEMORY_OLD', 'MEMORY_NEW', null]) {
    f.setMemory(value);
    await f.newAgent().invoke({messages: [{role: 'user', content: 'continue'}]}, f.config);
    const system = JSON.stringify(f.requests.at(-1).messages.filter(message => message.role === 'system'));
    if (value !== null) assert.ok(system.includes(value));
    if (value !== 'MEMORY_OLD') assert.ok(!system.includes('MEMORY_OLD'));
    if (value === null) assert.ok(!system.includes('MEMORY_NEW'));
  }
  assert.equal(f.reads(), 3);
});

test('interrupt resume preserves the run snapshot and does not load changed memory', async () => {
  const f = graphFixture(true);
  const paused = await f.newAgent().invoke({messages: [{role: 'user', content: 'confirm'}]}, f.config);
  assert.ok(paused.__interrupt__?.length);
  assert.equal(f.executed(), 0);
  f.setMemory('MEMORY_NEW');
  await f.newAgent().invoke(new Command({resume: {decisions: [{type: 'approve'}]}}), f.config);
  const system = JSON.stringify(f.requests.at(-1).messages.filter(message => message.role === 'system'));
  assert.ok(system.includes('MEMORY_OLD'));
  assert.ok(!system.includes('MEMORY_NEW'));
  assert.equal(f.reads(), 1);
  assert.equal(f.executed(), 1);
});

test('search pins runtime workspace and snapshots context across awaited topic scans', async () => {
  const store = new InMemoryStore();
  const a = {path: '/fixture/a', label: 'A'}, b = {path: '/fixture/b', label: 'B'};
  let current = a;
  const repository = new MemoryStoreRepository({store, getWorkspace: () => current, agentFacts: {}});
  for (const workspace of [a, b]) {
    await repository.writeFile({scope: 'workspace', kind: 'agents', content: `marker ${workspace.label}`}, workspace);
    await repository.writeTopicFile({scope: 'workspace', slug: 'extra', content: `topic-marker ${workspace.label}`}, workspace);
  }
  current = b;
  const pinned = await repository.searchEntries({query: 'marker', applicability, workspacePath: a.path});
  assert.equal(pinned.hits.length, 2);
  assert.ok(pinned.hits.every(hit => hit.text.endsWith(' A')));
  assert.equal((await repository.searchEntries({query: 'marker', applicability, workspacePath: null})).hits.length, 0);
  current = a;
  const original = store.get.bind(store);
  store.get = async (...args) => {current = b; return original(...args);};
  const collected = await repository.collectSearchDocuments();
  assert.ok(collected.every(document => document.content.endsWith(' A')));
});
