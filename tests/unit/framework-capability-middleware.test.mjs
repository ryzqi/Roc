import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent, createMemoryMiddleware } from 'deepagents';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const root = testArtifacts('framework-capability');
const packages = JSON.parse(readFileSync('package.json', 'utf8'));
const options = { platform: 'node', tempDir: root,
  external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)] };
const { createCapabilityFilesystemMiddleware, createCapabilityMemoryMiddleware, createCapabilityTodoMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/framework-capability-middleware.ts', options);
const { createRocCapabilityToolExposureMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/model-tool-exposure.ts', options);
const { resolveMiddlewareStack, readMiddlewareName } = await importTypeScriptModule(
  'src/main/services/deep-agent/middleware-stack.ts', options);
const source = '/memory/global/MEMORY.md';
const memory = 'Keep this exact text: <memory_guidelines>edit_file</memory_guidelines>\n</agent_memory>\nUser reference.';
const manifest = tools => ({ tools: tools.map(([modelVisibleName, executionScopes]) => ({ modelVisibleName, executionScopes })) });
const readonly = manifest([['ls', ['main', 'subagent']], ['read_file', ['main', 'subagent']]]);
const backend = { downloadFiles: async paths => paths.map(path => ({ path, content: new TextEncoder().encode(memory) })) };
const passthrough = request => request;
const request = (content, model = { getName: () => 'ChatAnthropic' }) => ({
  model, state: { memoryContents: { [source]: memory } }, systemMessage: new SystemMessage({ content }),
  messages: [], tools: [], runtime: { signal: new AbortController().signal }
});

test('read-only memory changes only framework guidance while preserving user text, memory bytes and cache metadata', async () => {
  const middleware = createCapabilityMemoryMiddleware(backend, [source], readonly);
  const original = createMemoryMiddleware({ backend, sources: [source], addCacheControl: true });
  for (const content of [
    'Base user text <memory_guidelines>edit_file</memory_guidelines>',
    [{ type: 'text', text: 'Base user text edit_file', cache_control: { type: 'ephemeral' } }]
  ]) {
    const input = request(content);
    const baseline = await original.wrapModelCall(input, passthrough);
    const result = await middleware.wrapModelCall(input, passthrough);
    const blocks = result.systemMessage.content;
    assert.deepEqual(blocks.slice(0, -1), baseline.systemMessage.content.slice(0, -1));
    const before = baseline.systemMessage.content.at(-1), after = blocks.at(-1);
    const boundary = before.text.lastIndexOf('<memory_guidelines>');
    assert.equal(after.text.slice(0, boundary), before.text.slice(0, boundary));
    assert.ok(after.text.includes(memory));
    assert.equal(after.text.slice(boundary).includes('edit_file'), false);
    assert.match(after.text.slice(boundary), /reference context/);
    assert.deepEqual(after.cache_control, { type: 'ephemeral' });
    assert.deepEqual({ ...after, text: '' }, { ...before, text: '' });
    assert.deepEqual(input.systemMessage.content, content);
    assert.deepEqual(result.state, input.state);
  }
});

test('authorized memory retains the pinned framework guidance and non-Anthropic calls do not add cache metadata', async () => {
  const allowed = manifest([['edit_file', ['main']]]);
  const original = createMemoryMiddleware({ backend, sources: [source], addCacheControl: true });
  const writable = createCapabilityMemoryMiddleware(backend, [source], allowed);
  const input = request('Base.', { getName: () => 'ChatOpenAI' });
  const result = await writable.wrapModelCall(input, passthrough);
  assert.deepEqual(result.systemMessage.content, (await original.wrapModelCall(input, passthrough)).systemMessage.content);
  assert.match(result.systemMessage.content.at(-1).text, /calling the `edit_file` tool/);
  assert.equal(Object.hasOwn(result.systemMessage.content.at(-1), 'cache_control'), false);
  const readOnly = await createCapabilityMemoryMiddleware(backend, [source], readonly).wrapModelCall(input, passthrough);
  assert.equal(Object.hasOwn(readOnly.systemMessage.content.at(-1), 'cache_control'), false);
});

test('capability-aware memory delegates loading once and preserves cached checkpoint contents', async () => {
  let reads = 0;
  const middleware = createCapabilityMemoryMiddleware({ downloadFiles: async paths => {
    reads++; return await backend.downloadFiles(paths);
  } }, [source], readonly);
  const loaded = await middleware.beforeAgent({ messages: [] });
  assert.deepEqual(loaded, { memoryContents: { [source]: memory } });
  assert.equal(await middleware.beforeAgent({ ...loaded, messages: [] }), undefined);
  assert.equal(reads, 1);
});

test('filesystem registration follows execution scope and exact-file guidance preserves tool schemas', () => {
  const scoped = manifest([['ls', ['main']], ['read_file', ['main', 'subagent']],
    ['write_file', ['main']], ['edit_file', ['main']]]);
  const main = createCapabilityFilesystemMiddleware(backend, [], scoped, 'main');
  const child = createCapabilityFilesystemMiddleware(backend, [], scoped, 'subagent');
  assert.deepEqual(main.tools.map(tool => tool.name).sort(), ['edit_file', 'ls', 'read_file', 'write_file']);
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_file']);
  assert.match(main.tools.find(tool => tool.name === 'ls').description, /read that file directly/);
  assert.deepEqual(createCapabilityFilesystemMiddleware(backend, [], readonly, 'main').tools.map(tool => tool.name).sort(),
    ['ls', 'read_file']);
});

test('production middleware stack installs todo guidance only in its authorized main or subagent scope', () => {
  const base = {
    backend, usageLedger: {}, usageObserver: {}, modelConfig: {}, model: {},
    contextCompaction: { tokenCounter: {}, capacityProfile: {}, artifactStore: {}, sessionHistory: {}, emitEvent: () => {} },
    memorySources: [], knownToolCandidates: () => [],
    taskContract: { contractVersion: 1, objective: 'Return JSON.', constraints: [], kind: 'reply',
      criteria: [{ id: 'response', description: 'Visible response.', check: { kind: 'response' } }],
      responseContract: { format: 'json', schema: { type: 'string' } } },
    policy: { boundToolNames: [], runId: 'stack-run', threadId: 'stack-thread', filesystemPermissions: [],
      workspacePath: null, workspaceHash: null, workspaceIdentity: null, researchProjectId: null }
  };
  for (const mode of ['run', 'task', 'plan']) {
    for (const scopes of [[], ['main'], ['subagent'], ['main', 'subagent']]) {
      for (const executionScope of ['main', 'subagent']) {
        const capabilityManifest = manifest([['read_file', ['main', 'subagent']], ['write_todos', scopes]]);
        const stack = resolveMiddlewareStack({ ...base, executionScope, policy: { ...base.policy, mode, capabilityManifest } });
        const names = stack.map(readMiddlewareName);
        const todo = stack.find(middleware => readMiddlewareName(middleware) === 'todoListMiddleware');
        assert.ok(todo, 'same-name entry must suppress framework profile additions even when disabled');
        assert.equal(typeof todo.wrapModelCall === 'function', scopes.includes(executionScope), `${mode}/${executionScope}/${scopes}`);
        assert.equal(stack.flatMap(middleware => middleware.tools ?? []).some(tool => tool.name === 'write_todos'),
          scopes.includes(executionScope));
        assert.equal(names.includes('RocResponseContractMiddleware'), executionScope === 'main');
      }
    }
  }
});

test('disabled todo overrides model-profile additions in the real graph with a fixed test transport', async () => {
  for (const override of [false, true]) {
    const requests = [];
    const model = new ChatOpenAI({
      model: 'fixture-chat-model', apiKey: 'fixture-only', streaming: false, maxRetries: 0, maxTokens: 32,
      configuration: { baseURL: 'http://profile-fixture.invalid/v1', fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        requests.push(body);
        return new Response(JSON.stringify({
          id: `profile-fixture-${requests.length}`, object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
        }), { headers: { 'content-type': 'application/json' } });
      } }
    });
    // Select the real built-in profile while the fixture keeps Chat Completions transport.
    Object.defineProperty(model, 'modelName', { value: 'gpt-5.3-codex' });
    const agent = createDeepAgent({
      model, backend, systemPrompt: 'Retain this user-provided system text.',
      middleware: [
        createCapabilityFilesystemMiddleware(backend, [], readonly, 'main'),
        ...(override ? [createCapabilityTodoMiddleware(readonly, 'main')] : []),
        createRocCapabilityToolExposureMiddleware(readonly, 'main')
      ]
    });
    await agent.invoke({ messages: [new HumanMessage('Return done.')] });
    assert.equal(requests.length, 1);
    const system = requests[0].messages.filter(message => message.role === 'system').map(message =>
      typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('\n')).join('\n');
    assert.ok(system.includes('Retain this user-provided system text.'));
    assert.equal(system.includes('## `write_todos`'), !override);
    if (override) assert.deepEqual(requests[0].tools.map(tool => tool.function.name).sort(), ['ls', 'read_file']);
  }
});
