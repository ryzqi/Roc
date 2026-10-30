import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';

let directory;
let api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-capability-manifest-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'manifest.mjs');
  await build({
    stdin: { contents: `
      export * from './src/main/plugins/agent/run-capability-manifest';
      export * from './src/main/plugins/agent/capability-preview';
      export * from './src/main/plugins/mcp/mcp-tool-contract';
      export * from './src/main/plugins/mcp/mcp-bounded-fetch';
      export { createLangChainTool, createMcpOutputValidator } from './src/main/plugins/mcp/mcp-client-adapter';
    `, resolveDir: process.cwd() },
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent'
  });
  api = await import(outfile);
  mkdirSync(join(directory, 'skill'));
  writeFileSync(join(directory, 'skill', 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\nRead the fixture.');
});
after(() => rmSync(directory, { recursive: true, force: true }));

const server = {
  id: 'fixture', name: 'Fixture', enabled: true, transport: 'http', status: 'ready', tools: 1,
  preset: false, riskLevel: 'medium', url: 'https://example.test/mcp', allowedTools: ['fixture_lookup']
};
const runtimeStatus = { defaultModelState: { status: 'ready', modelId: 'fixture-model' } };
function input(overrides = {}) {
  return {
    mode: 'chat', deleteFileApprovalMode: 'default', mcpApprovalMode: 'default',
    mcpServers: [server], skills: [], workflowHint: null,
    requestedCapabilities: { mcpServers: ['fixture'], skills: [] }, ...overrides
  };
}

function makeMcpTool({ client, semaphore, timeoutMs } = {}) {
  const inputSchema = {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false
  };
  const outputSchema = {
    type: 'object', properties: { result: { type: 'string' }, count: { type: 'integer' } },
    required: ['result', 'count'], additionalProperties: false
  };
  const remoteTool = { name: 'fixture_lookup', description: 'Fixture lookup.', inputSchema, outputSchema };
  const contract = api.createMcpToolContract({
    serverId: 'fixture', remoteToolName: remoteTool.name, runtimeToolName: 'fixture_fixture_lookup', transport: 'http',
    inputSchema, outputSchema, description: remoteTool.description
  });
  const defaultSemaphore = {
    acquire: async (signal) => {
      signal.throwIfAborted();
      return () => undefined;
    }
  };
  const tool = api.createLangChainTool({
    client, contract, description: remoteTool.description, remoteTool, runtimeToolName: contract.runtimeToolName,
    runSignal: new AbortController().signal, semaphore: semaphore ?? defaultSemaphore, timeoutMs
  });
  return { contract, tool };
}

function successResult(structuredContent = { result: 'ok', count: 1 }) {
  return { isError: false, content: [{ type: 'text', text: 'ok' }], structuredContent };
}

test('capability previews and runtime compile the same manifest and approval policies', () => {
  for (const mode of ['chat', 'plan']) for (const approval of ['default', 'fully_automatic']) {
    const request = input({ mode, deleteFileApprovalMode: approval, mcpApprovalMode: approval });
    const compiled = api.compileRunCapabilityManifest(request);
    const preview = api.buildAgentCapabilityPreview({ ...request, runtimeStatus });
    assert.deepEqual(preview.manifest, compiled.manifest);
    assert.deepEqual(preview.interruptOn, compiled.interruptOn);
    assert.equal(compiled.toolCards.find(card => card.name === 'fixture_lookup').requiresApproval, approval === 'default');
    assert.equal(compiled.manifest.tools.find(tool => tool.modelVisibleName === 'fixture_lookup').approvalPolicy.kind,
      approval === 'default' ? 'required' : 'none');
    assert.equal(api.isRunCapabilityManifestIntegrityValid(compiled.manifest), true);
  }
});

test('plan cards exclude local execution, deletion and self configuration', () => {
  const compiled = api.compileRunCapabilityManifest(input({ mode: 'plan', selfConfigAvailable: true }));
  assert.deepEqual(compiled.toolCards.map(card => card.name), ['web_read', 'fixture_lookup']);
  assert.equal(compiled.interruptOn.delete_file, undefined);
  const chat = api.compileRunCapabilityManifest(input({ selfConfigAvailable: true, shellAllowedCommands: [] }));
  assert.equal(chat.toolCards.some(card => card.name === 'run_shell_command'), false);
  assert.equal(chat.toolCards.some(card => card.name === 'roc_self_config'), true);
  assert.equal(chat.toolCards.find(card => card.name === 'delete_file').requiresApproval, true);
});

test('execution profiles split isolated read/write from main-only trusted host approval', () => {
  const compiled = api.compileRunCapabilityManifest(input({ trustedHostAvailable: true }));
  const names = compiled.toolCards.map((card) => card.name);
  assert.ok(names.includes('run_isolated_read_command'));
  assert.ok(names.includes('run_shell_command'));
  assert.ok(names.includes('run_trusted_host_command'));
  const readTool = compiled.manifest.tools.find((tool) => tool.modelVisibleName === 'run_isolated_read_command');
  const writeTool = compiled.manifest.tools.find((tool) => tool.modelVisibleName === 'run_shell_command');
  const hostTool = compiled.manifest.tools.find((tool) => tool.modelVisibleName === 'run_trusted_host_command');
  assert.equal(readTool.effectClass, 'isolated_execution');
  assert.equal(writeTool.effectClass, 'isolated_execution');
  assert.equal(hostTool.effectClass, 'host_execution');
  assert.deepEqual(hostTool.executionScopes, ['main']);
  assert.deepEqual(hostTool.approvalPolicy, { kind: 'native_dialog' });
  assert.equal(compiled.interruptOn.run_trusted_host_command, undefined);

  const backgroundPreview = api.compileRunCapabilityManifest(input({ trustedHostAvailable: false }));
  assert.equal(backgroundPreview.toolCards.some((card) => card.name === 'run_trusted_host_command'), false);
});

test('MCP selection preserves disabled and missing reasons and rejects reserved tool names', () => {
  const compiled = api.compileRunCapabilityManifest(input({
    mcpServers: [server, { ...server, id: 'disabled', enabled: false }],
    requestedCapabilities: { mcpServers: ['fixture', 'disabled', 'missing', 'fixture'], skills: [] }
  }));
  assert.deepEqual(compiled.manifest.resolvedCapabilities.mcpServers, ['fixture']);
  assert.deepEqual(compiled.manifest.skippedCapabilities, [
    { id: 'disabled', type: 'mcp_server', reason: 'disabled' },
    { id: 'missing', type: 'mcp_server', reason: 'not_found' }
  ]);
  assert.deepEqual(compiled.manifest.mcpServers.map(item => item.id), ['fixture']);
  assert.throws(() => api.compileRunCapabilityManifest(input({
    mcpServers: [{ ...server, allowedTools: ['read_file'] }]
  })), /run_capability_model_visible_name_reserved:read_file/);
});

test('explicit skills are included once, with content hashes and readiness validation', () => {
  const skill = {
    id: 'fixture', name: 'fixture', enabled: true, path: join(directory, 'skill'), description: 'fixture', status: 'ready',
    origin: 'user', sourceId: null, upstreamRepo: null, upstreamCommit: null
  };
  const request = input({
    skills: [skill], explicitSkillIds: ['fixture', 'fixture'],
    requestedCapabilities: { mcpServers: [], skills: ['fixture'] }
  });
  const compiled = api.compileRunCapabilityManifest(request);
  assert.equal(compiled.manifest.skills.length, 1);
  assert.match(compiled.manifest.skills[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(compiled.skillCards.length, 1);
  assert.throws(() => api.compileRunCapabilityManifest({ ...request, skills: [] }), /skill_not_found:fixture/);
  assert.throws(() => api.compileRunCapabilityManifest({ ...request, skills: [{ ...skill, enabled: false }] }), /skill_disabled:fixture/);
  assert.throws(() => api.compileRunCapabilityManifest({ ...request, skills: [{ ...skill, status: 'invalid' }] }), /skill_invalid:fixture/);
});

test('MCP contract hashing covers canonical input and output schemas', () => {
  const base = {
    serverId: 'fixture',
    remoteToolName: 'fixture_lookup',
    runtimeToolName: 'fixture_fixture_lookup',
    transport: 'http',
    description: 'Lookup a fixture.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: { result: { type: 'string' }, count: { type: 'integer' } },
      required: ['result', 'count']
    }
  };
  const first = api.createMcpToolContract(base);
  const reordered = api.createMcpToolContract({
    ...base,
    inputSchema: {
      required: ['query'],
      properties: { limit: { type: 'integer' }, query: { type: 'string' } },
      type: 'object'
    },
    outputSchema: {
      required: ['count', 'result'],
      properties: { count: { type: 'integer' }, result: { type: 'string' } },
      type: 'object'
    }
  });
  const changedOutput = api.createMcpToolContract({
    ...base,
    outputSchema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] }
  });
  assert.equal(first.schemaHash, reordered.schemaHash);
  assert.notEqual(first.schemaHash, changedOutput.schemaHash);
  assert.equal(api.mcpToolContractsEqual(first, reordered), true);
  assert.throws(
    () => api.assertMcpToolContractMatches(first, { ...first, descriptionHash: '0'.repeat(64) }, 'fixture_lookup'),
    /mcp_tool_contract_drift:fixture_lookup/
  );
  assert.deepEqual(api.readMcpToolContractMetadata({ metadata: { mcpContract: first } }), first);
  assert.throws(() => api.readMcpToolContractMetadata({ metadata: { mcpContract: { ...first, maxOutputBytes: -1 } } }), /mcp_tool_contract_metadata_invalid/);
});

test('MCP contracts bind into and rehash the frozen manifest', () => {
  const compiled = api.compileRunCapabilityManifest(input());
  const contract = api.createMcpToolContract({
    serverId: 'fixture',
    remoteToolName: 'fixture_lookup',
    runtimeToolName: 'fixture_fixture_lookup',
    transport: 'http',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    description: 'Fixture lookup.'
  });
  const bound = api.bindMcpToolContracts(compiled.manifest, [contract]);
  const tool = bound.tools.find((item) => item.modelVisibleName === 'fixture_lookup');
  assert.deepEqual(tool.mcpContract, contract);
  assert.equal(tool.toolVersion, `mcp-contract-v1:${contract.schemaHash}:${contract.descriptionHash}`);
  const recovered = JSON.parse(JSON.stringify(bound));
  assert.equal(api.isRunCapabilityManifestIntegrityValid(recovered), true);
  const recoveredTool = recovered.tools.find((item) => item.modelVisibleName === 'fixture_lookup');
  assert.throws(
    () => api.assertMcpToolContractMatches(recoveredTool.mcpContract, { ...contract, descriptionHash: '0'.repeat(64) }, recoveredTool.modelVisibleName),
    /mcp_tool_contract_drift:fixture_lookup/
  );
  assert.equal(api.isRunCapabilityManifestIntegrityValid(bound), true);
  assert.throws(() => api.bindMcpToolContracts(compiled.manifest, []), /mcp_tool_contract_missing_or_ambiguous/);
  assert.throws(() => api.bindMcpToolContracts(compiled.manifest, [{ ...contract, runtimeToolName: 'wrong' }]), /mcp_tool_contract_runtime_name_invalid/);
});

test('MCP structured outputs are validated against the frozen schema', async () => {
  const validate = api.createMcpOutputValidator({
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false
  });
  await validate({ count: 3 });
  await assert.rejects(validate({ count: '3' }), /mcp_tool_output_invalid/);
  await assert.rejects(validate({}), /mcp_tool_output_invalid/);
  await api.createMcpOutputValidator(undefined)({ unchecked: true });
});

test('MCP tool invocation propagates caller cancellation to the remote request', async () => {
  let requestSignal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { tool } = makeMcpTool({
    timeoutMs: 5_000,
    client: {
      callTool: (_request, options) => {
        requestSignal = options.signal;
        markStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
    }
  });
  const controller = new AbortController();
  const invocation = tool.invoke({ query: 'cancel me' }, { signal: controller.signal });
  await started;
  controller.abort(new Error('fixture_cancelled'));
  await assert.rejects(invocation, /fixture_cancelled/);
  assert.equal(requestSignal.aborted, true);
});

test('MCP invocation timeout aborts while waiting for a server permit', async () => {
  let queuedSignal;
  let providerCalls = 0;
  const waitingSemaphore = {
    acquire: (signal) => {
      queuedSignal = signal;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => reject(new Error('semaphore_wait_aborted'));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener('abort', rejectAborted, { once: true });
      });
    }
  };
  const { tool } = makeMcpTool({
    timeoutMs: 25,
    semaphore: waitingSemaphore,
    client: { callTool: async () => { providerCalls += 1; return successResult(); } }
  });
  await assert.rejects(tool.invoke({ query: 'wait' }), /semaphore_wait_aborted/);
  assert.equal(queuedSignal.aborted, true);
  assert.equal(providerCalls, 0);
});

test('MCP tool rejects oversized input before the provider call', async () => {
  let providerCalls = 0;
  const { tool } = makeMcpTool({
    client: { callTool: async () => { providerCalls += 1; return successResult(); } }
  });
  await assert.rejects(tool.invoke({ query: 'x'.repeat(api.MCP_MAX_TOOL_INPUT_BYTES + 1) }), /mcp_tool_input_limit/);
  assert.equal(providerCalls, 0);
});

test('MCP tool rejects oversized structured responses', async () => {
  let providerCalls = 0;
  const { tool } = makeMcpTool({
    client: {
      callTool: async () => {
        providerCalls += 1;
        return successResult({ result: 'x'.repeat(api.MCP_MAX_TOOL_OUTPUT_BYTES + 1), count: 1 });
      }
    }
  });
  await assert.rejects(tool.invoke({ query: 'large response' }), /mcp_tool_output_limit/);
  assert.equal(providerCalls, 1);
});

test('bounded MCP fetch rejects oversized JSON Content-Length before reading', async () => {
  let cancelled = false;
  const boundedFetch = api.createBoundedMcpFetch({
    maxMessageBytes: 4,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('12345')); },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'application/json', 'content-length': '5' } })
  });
  await assert.rejects(boundedFetch('https://fixture.test/mcp'), (error) => error.code === 'mcp_inbound_message_too_large');
  assert.equal(cancelled, true);
});

test('bounded MCP fetch rejects oversized streamed JSON before parsing', async () => {
  const boundedFetch = api.createBoundedMcpFetch({
    maxMessageBytes: 4,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x":'));
        controller.enqueue(new TextEncoder().encode('123}'));
        controller.close();
      }
    }), { headers: { 'content-type': 'application/json' } })
  });
  const response = await boundedFetch('https://fixture.test/mcp');
  await assert.rejects(response.text(), (error) => error.code === 'mcp_inbound_message_too_large');
});

test('bounded MCP fetch enforces the SSE event limit', async () => {
  const boundedFetch = api.createBoundedMcpFetch({
    maxMessageBytes: 10,
    fetchImpl: async () => new Response('data:123456\n\n', { headers: { 'content-type': 'text/event-stream' } })
  });
  const response = await boundedFetch('https://fixture.test/mcp');
  await assert.rejects(response.text(), (error) => error.code === 'mcp_inbound_message_too_large');
});

test('bounded MCP fetch permits multiple SSE events below the per-event limit', async () => {
  const body = 'data:123\n\ndata:123\n\n';
  const boundedFetch = api.createBoundedMcpFetch({
    maxMessageBytes: 10,
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  });
  const response = await boundedFetch('https://fixture.test/mcp');
  assert.equal(await response.text(), body);
});
