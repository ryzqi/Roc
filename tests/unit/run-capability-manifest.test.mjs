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
