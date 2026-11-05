import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { loadResearchTestApi, createResearchFixture } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

const request = network => ({
  engine: 'typescript', runtime: { kind: 'bundled-node' }, sourceVersion: 1,
  requestId: 'compute-policy', label: 'Controlled computation', sourcePath: 'analysis.mts',
  inputPaths: [], parameters: {}, timeoutMs: 1000, network
});

test('ordinary document and index parsing default to CPU without an implicit GPU grant', () => {
  const tools = new api.ResearchToolchain(null);
  for (const mediaType of ['application/pdf', 'image/png', 'text/html']) {
    assert.equal(tools.defaultParseOptions(mediaType).device, 'cpu');
  }
});

test('the computation sandbox refuses unused network grants before resolving any executable or file scope', async () => {
  for (const networkAccess of ['full', 'loopback']) {
    await assert.rejects(api.researchSandboxProfile({
      command: '/usr/bin/true', readablePaths: ['/usr/bin/true'], writablePaths: [],
      allowGpuAcceleration: false, networkAccess
    }), /research_process_network_policy_required/);
    await assert.rejects(api.researchSandboxProfile({
      command: '/does-not-exist', readablePaths: [], writablePaths: [],
      allowGpuAcceleration: false, networkAccess
    }), /research_process_network_policy_required/);
  }
});

test('actual role SDK refuses a model networking request before invoking effects or creating an execution', async () => {
  const f = createResearchFixture(api, 'experiment');
  let starts = 0;
  const service = {
    async start(input) {
      starts += 1;
      return f.repository.experiments.create(input, f.project.workspacePath, f.project.workspacePath, '/tmp/roc-policy-fixture');
    }
  };
  const effects = new api.ResearchProductionEffectService(f.repository, undefined, service);
  const tools = api.createResearchRoleTools({
    run: f.run, context: f.repository.runs.getContext(f.run.id), repository: f.repository,
    capabilities: {}, effects, signal: new AbortController().signal
  });
  try {
    const start = tools.find(tool => tool.name === 'start_experiment');
    assert.ok(start);
    await assert.rejects(start.invoke({ type: 'tool_call', id: 'network-forbidden', name: start.name, args: request('enabled') }));
    assert.equal(starts, 0); assert.equal(f.repository.experiments.list(f.project.id, 20).length, 0);
    await start.invoke({ type: 'tool_call', id: 'offline-approved', name: start.name, args: request('disabled') });
    assert.equal(starts, 1);
    assert.equal(f.repository.experiments.list(f.project.id, 20)[0].request.network, 'disabled');
  } finally { f.close(); }
});

test('actual main experiment capability refuses networking before its handler and accepts the explicit offline contract', async () => {
  const f = createResearchFixture(api, 'experiment'), registry = new api.CapabilityRegistry();
  let starts = 0;
  const service = {
    async start(input) {
      starts += 1;
      return f.repository.experiments.create({ ...input, ownerRunId: null }, f.project.workspacePath, f.project.workspacePath, '/tmp/roc-policy-fixture');
    }
  };
  for (const descriptor of api.researchExperimentCapabilities) registry.declare('research', descriptor);
  api.registerResearchExperimentCapabilities({ pluginId: 'research', capabilities: registry }, f.repository.experiments, service);
  try {
    await assert.rejects(registry.invoke('research.experiment.start', { ...request('enabled'), projectId: f.project.id }));
    assert.equal(starts, 0); assert.equal(f.repository.experiments.list(f.project.id, 20).length, 0);
    const offline = await registry.invoke('research.experiment.start', { ...request('disabled'), projectId: f.project.id });
    assert.equal(starts, 1); assert.equal(offline.request.network, 'disabled');
  } finally { f.close(); }
});
