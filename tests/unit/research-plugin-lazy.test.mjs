import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, unlink, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadResearchPluginApi, createResearchPluginFixture } from '../fixtures/research-plugin-fixture.mjs';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

let api, legacy, reference, pdfAcquisition, acquisitions;
before(async () => {
  api = await loadResearchPluginApi();
  legacy = await loadResearchPluginApi({ legacy: true });
  reference = await loadResearchPluginApi({ referenceGitSha: '2ffe8bd' });
  [pdfAcquisition, acquisitions] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/literature-pdf-acquisition.ts', {platform: 'node', tempDir: '.runtime/tmp'}),
    importTypeScriptModule('src/main/plugins/research/literature-acquisition-repository.ts', {platform: 'node', tempDir: '.runtime/tmp'})
  ]);
});
after(async () => { await Promise.all([api?.dispose(), legacy?.dispose(), reference?.dispose()]); });
function project(f) {
  return f.repository.createProject({ title: 'Synthetic startup study', description: 'Isolated fixture',
    workspacePath: f.directory });
}
const initializedDomains = f => f.observations.filter(item =>
  item.message === 'Research capability initialization.' && item.metadata.outcome === 'ready').map(item => item.metadata.domain);

const scientificAdditions = [
  'research.knowledge.scientificSearch', 'research.knowledge.scientificGenerations', 'research.knowledge.scientificActivate',
  'research.knowledge.scientificContext', 'research.knowledge.scientificEvidence',
  'research.knowledge.scientificRead', 'research.knowledge.extractionEnqueue', 'research.knowledge.extractionJobs',
  'research.knowledge.extractionRetry', 'research.knowledge.extractionCancel',
  'research.visual.config', 'research.visual.inspectModel', 'research.visual.saveConfig',
  'research.visual.rebuild', 'research.visual.search', 'research.visual.understandFigure'
];
const acquisitionAdditions = [
  'research.library.acquisitionSettings', 'research.library.saveAcquisitionSettings',
  'research.library.listAcquisition', 'research.library.retryAcquisition', 'research.library.cancelAcquisition'
];
function originalCapabilities(plugin) {
  return plugin.manifest.capabilities.filter(item =>
    !scientificAdditions.includes(item.name) && !acquisitionAdditions.includes(item.name));
}
function assertScientificAdditions(plugin) {
  assert.deepEqual(plugin.manifest.capabilities.filter(item => scientificAdditions.includes(item.name))
    .map(item => ({name: item.name, version: item.version, effectReceipt: item.effectReceipt})),
  scientificAdditions.map(name => ({name, version: '1.0.0', effectReceipt: undefined})));
}
function assertAcquisitionAdditions(plugin) {
  const capabilities = plugin.manifest.capabilities.filter(item => acquisitionAdditions.includes(item.name));
  assert.deepEqual(capabilities.map(item => ({name: item.name, version: item.version, effectReceipt: item.effectReceipt})),
    acquisitionAdditions.map(name => ({name, version: '1.0.0', effectReceipt: undefined})));
  const [settings, saveSettings, list, retry, cancel] = capabilities;
  assert.deepEqual(settings.inputSchema.parse({}), {});
  assert.equal(settings.inputSchema.safeParse({unexpected: true}).success, false);
  const defaults = {versionPreference: 'balanced', unpaywallEmail: null};
  assert.deepEqual(settings.outputSchema.parse({}), defaults);
  assert.deepEqual(saveSettings.inputSchema.parse({}), defaults);
  for (const schema of [settings.outputSchema, saveSettings.inputSchema, saveSettings.outputSchema]) {
    const value = {versionPreference: 'published', unpaywallEmail: 'fixture@example.org'};
    assert.deepEqual(schema.parse(value), value);
    for (const invalid of [{versionPreference: 'unknown'}, {unpaywallEmail: 'invalid'}, {unexpected: true}]) {
      assert.equal(schema.safeParse(invalid).success, false);
    }
  }
  assert.deepEqual(list.inputSchema.parse({}), {offset: 0, limit: 20});
  assert.equal(list.inputSchema.safeParse({limit: 51}).success, false);
  assert.equal(list.inputSchema.safeParse({offset: -1}).success, false);
  assert.equal(list.inputSchema.safeParse({unexpected: true}).success, false);
  assert.deepEqual(list.outputSchema.parse({jobs: [], total: 0, nextOffset: null}), {jobs: [], total: 0, nextOffset: null});
  assert.equal(list.outputSchema.safeParse({jobs: [], total: -1, nextOffset: null}).success, false);
  for (const capability of [retry, cancel]) {
    const request = {jobId: 'job', generation: 'generation'};
    assert.deepEqual(capability.inputSchema.parse(request), request);
    for (const invalid of [{jobId: 'job'}, {generation: 'generation'}, {...request, unexpected: true}]) {
      assert.equal(capability.inputSchema.safeParse(invalid).success, false);
    }
    assert.equal(capability.outputSchema.safeParse({}).success, false);
  }
}

test('domain split preserves every original manifest schema, readonly output and shared provider alongside explicit scientific additions', async () => {
  const current = await createResearchPluginFixture(api), old = await createResearchPluginFixture(reference);
  try {
    const contract = plugin => ({
      ...plugin.manifest,
      capabilities: originalCapabilities(plugin).map(item => ({
        name: item.name, version: item.version, effectReceipt: item.effectReceipt,
        input: z.toJSONSchema(item.inputSchema, { unrepresentable: 'any' }),
        output: z.toJSONSchema(item.outputSchema, { unrepresentable: 'any' })
      }))
    });
    assertScientificAdditions(current.plugin);
    assertAcquisitionAdditions(current.plugin);
    assert.deepEqual(contract(current.plugin), contract(old.plugin));
    const p = project(current), oldProject = project(old);
    await current.initialize(); await old.initialize();
    const requests = [
      ['research.reading.listReadingNotes', {}],
      ['research.huggingfaceDownloads.history', { observationId: null, offset: 0, limit: 20 }],
      ['research.reviewProtocol.list', { limit: 20 }]
    ];
    for (const [name, input] of requests) {
      assert.deepEqual(await current.registry.invoke(name, { ...input, projectId: p.id }),
        await old.registry.invoke(name, { ...input, projectId: oldProject.id }));
    }
    assert.deepEqual(initializedDomains(current), initializedDomains(old));
    assert.equal(initializedDomains(current).filter(domain => domain === 'documents').length, 1);
    for (const descriptor of current.plugin.manifest.capabilities) {
      assert.equal(current.registry.list().find(item => item.name === descriptor.name), descriptor);
    }
  } finally { await current.close(); await old.close(); }
});

test('manifest, schemas and real readonly outputs remain compatible while unused domains stay idle', async () => {
  const current = await createResearchPluginFixture(api), old = await createResearchPluginFixture(legacy);
  try {
    const contract = plugin => ({
      ...plugin.manifest,
      capabilities: originalCapabilities(plugin).map(item => ({
        name: item.name, version: item.version, effectReceipt: item.effectReceipt
      }))
    });
    assertScientificAdditions(current.plugin);
    assertAcquisitionAdditions(current.plugin);
    assert.deepEqual(contract(current.plugin), contract(old.plugin));
    assert.equal(current.plugin.manifest.required, true);
    const p = project(current), oldProject = project(old);
    await Promise.all([current.initialize(), old.initialize()]);
    assert.deepEqual(initializedDomains(current), []);
    await assert.rejects(access(join(current.directory, 'resources')));
    for (const descriptor of current.plugin.manifest.capabilities) {
      assert.equal(current.registry.list().find(item => item.name === descriptor.name), descriptor);
    }
    const requests = [
      ['research.reading.listReadingNotes', {}],
      ['research.huggingface.history', { identity: null, offset: 0, limit: 20 }],
      ['research.huggingfaceDownloads.history', { observationId: null, offset: 0, limit: 20 }],
      ['research.reviewProtocol.list', { limit: 20 }]
    ];
    for (const [name, input] of requests) {
      assert.deepEqual(await current.registry.invoke(name, { ...input, projectId: p.id }),
        await old.registry.invoke(name, { ...input, projectId: oldProject.id }));
    }
    assert.deepEqual(initializedDomains(current), ['reading', 'huggingface', 'huggingface-downloads', 'documents', 'systematic-review']);
    assert.equal(current.requests.length, 0);
    assert.deepEqual(await current.plugin.healthCheck(), { status: 'healthy' });
  } finally { await current.close(); await old.close(); }
});

test('twenty simultaneous first reading calls initialize its real services once; invalid input stays outside', async () => {
  const f = await createResearchPluginFixture(api);
  try {
    const p = project(f);
    await f.initialize();
    await assert.rejects(f.registry.invoke('research.reading.listReadingNotes', { projectId: 42 }));
    assert.deepEqual(initializedDomains(f), []);
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      f.registry.invoke('research.reading.listReadingNotes', { projectId: p.id })));
    assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
    assert.deepEqual(initializedDomains(f), ['reading']);
  } finally { await f.close(); }
});

test('diagnostic eager initialization creates unused domains once and closes their real providers', async () => {
  const previous = process.env.ROC_PERF_RESEARCH_LAZY_INIT;
  process.env.ROC_PERF_RESEARCH_LAZY_INIT = '0';
  try {
    const f = await createResearchPluginFixture(api);
    try {
      const p = project(f);
      await f.initialize();
      const domains = initializedDomains(f);
      assert.equal(new Set(domains).size, domains.length);
      assert.deepEqual([...domains].sort(), [
        'diagram', 'documents', 'huggingface', 'huggingface-downloads', 'monitors', 'openreview',
        'prose', 'reading', 'reference-check', 'resources', 'scholarly', 'systematic-review'
      ]);
      await access(join(f.directory, 'resources'));
      assert.deepEqual(await f.plugin.healthCheck(), { status: 'healthy' });
      assert.deepEqual(await f.registry.invoke('research.reading.listReadingNotes', { projectId: p.id }), []);
      assert.deepEqual(initializedDomains(f), domains);
      assert.equal(f.requests.length, 0);
      await f.plugin.shutdown();
      assert.deepEqual(await f.plugin.healthCheck(), { status: 'unhealthy', reason: 'research_plugin_not_initialized' });
      await assert.rejects(f.registry.invoke('research.reading.listReadingNotes', { projectId: p.id }),
        /research_capability_provider_closed/u);
    } finally { await f.close(); }
  } finally {
    if (previous === undefined) delete process.env.ROC_PERF_RESEARCH_LAZY_INIT;
    else process.env.ROC_PERF_RESEARCH_LAZY_INIT = previous;
  }
});

test('a physical download-root failure affects health, releases partial services and permits a real retry', async () => {
  const f = await createResearchPluginFixture(api);
  try {
    const p = project(f);
    const resources = join(f.directory, 'resources'), target = join(f.directory, 'symlink-target');
    await mkdir(target);
    await symlink(target, resources);
    await f.initialize();
    const request = { projectId: p.id, observationId: null, offset: 0, limit: 20 };
    await assert.rejects(f.registry.invoke('research.huggingfaceDownloads.history', request), /storage_failed/);
    assert.deepEqual(await f.plugin.healthCheck(), {
      status: 'unhealthy', reason: 'research_capability_initialization_failed:huggingface-downloads'
    });
    await unlink(resources);
    await f.registry.invoke('research.huggingfaceDownloads.history', request);
    assert.deepEqual(await f.plugin.healthCheck(), { status: 'healthy' });
    assert.equal(initializedDomains(f).filter(domain => domain === 'huggingface').length, 1);
    assert.equal(initializedDomains(f).filter(domain => domain === 'huggingface-downloads').length, 1);
  } finally { await f.close(); }
});

test('PDF storage initialization shares concurrent work and retries after a sanitized failure', async () => {
  let calls = 0, rejectInitialization;
  const downloader = {initialize: () => {
    calls++;
    return calls === 1 ? new Promise((_resolve, reject) => {rejectInitialization = reject;}) : Promise.resolve();
  }};
  const worker = new pdfAcquisition.LiteraturePdfAcquisition({}, {}, downloader, () => {}, undefined);
  assert.equal(calls, 0);
  const first = worker.initialize(), second = worker.initialize();
  assert.equal(first, second);
  assert.equal(calls, 1);
  const failed = Promise.allSettled([first, second]);
  rejectInitialization(new Error('EACCES: /private/synthetic-download-root'));
  for (const result of await failed) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.message, 'research_pdf_storage_unavailable');
  }
  const retry = worker.initialize();
  assert.notEqual(retry, first);
  assert.equal(retry, worker.initialize());
  await retry;
  await worker.initialize();
  assert.equal(calls, 2);
});

test('queued acquisition storage failures block only their jobs and recover without restarting the plugin', async () => {
  const f = await createResearchPluginFixture(api);
  try {
    const p = project(f), jobs = new acquisitions.LiteratureAcquisitionRepository(f.db);
    const metadata = {id: 'crossref:storage-fixture', source: 'crossref', externalId: 'storage-fixture', doi: null,
      title: 'Storage recovery fixture', authors: [], abstract: 'Synthetic metadata without a resolvable PDF identity.',
      publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
      importedAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z'};
    const item = f.repository.library.import([{metadata, bibliography: {citationKey: 'storage-fixture', entryType: 'article',
      fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: [], doi: null,
      publishedYear: 2026, abstract: metadata.abstract, url: null}}], p.id, {notify: false}).items[0];
    f.db.transaction(() => {jobs.enqueue(p.id, item.id); jobs.enqueue(null, item.id);})();
    const resources = join(f.directory, 'resources'), target = join(f.directory, 'symlink-target');
    await mkdir(target); await symlink(target, resources);
    await f.initialize();
    const scope = {owner: 'fixture', projectId: p.id};
    const readJobs = () => [
      ...jobs.list(scope, {destination: 'current_project', offset: 0, limit: 20}).jobs,
      ...jobs.list({...scope, projectId: null}, {destination: 'library_only', offset: 0, limit: 20}).jobs
    ];
    const waitForStatus = async status => {
      let current;
      for (let attempt = 0; attempt < 200; attempt++) {
        current = readJobs();
        if (current.length === 2 && current.every(job => job.status === status)) return current;
        await delay(10);
      }
      assert.fail(`Expected ${status}, received ${JSON.stringify(current)}`);
    };
    const blocked = await waitForStatus('blocked');
    assert.ok(blocked.every(job => job.stage === 'download' && job.errorCode === 'research_pdf_storage_unavailable'));
    assert.deepEqual(await f.plugin.healthCheck(), {status: 'healthy'});
    assert.deepEqual(initializedDomains(f), []);
    await assert.rejects(access(join(target, 'literature-pdf')));
    await unlink(resources);
    for (const job of blocked) jobs.change(job, job.generation, 'retry');
    // A real source notification wakes the existing background worker.
    await f.registry.invoke('research.library.linkProject', {id: item.id, projectId: p.id, linked: true});
    const recovered = await waitForStatus('unavailable');
    assert.ok(recovered.every(job => job.errorCode === 'research_pdf_identifier_required'), JSON.stringify(recovered));
    assert.ok(recovered.every(job => job.generation !== blocked.find(previous => previous.id === job.id).generation));
    await access(join(resources, 'literature-pdf'));
    await access(join(resources, 'literature-pdf-library'));
    assert.deepEqual(await f.plugin.healthCheck(), {status: 'healthy'});
    assert.deepEqual(initializedDomains(f), []);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

for (const invalidation of ['cancel', 'generation']) test(`PDF initialization fences ${invalidation} before creating the library workspace`, {timeout: 5000}, async () => {
  let releaseInitialization, startedInitialization, workspaceCalls = 0, downloads = 0, current = true;
  const started = new Promise(resolve => {startedInitialization = resolve;});
  const controller = new AbortController();
  const worker = new pdfAcquisition.LiteraturePdfAcquisition({}, {}, {
    initialize: () => new Promise(resolve => {releaseInitialization = resolve; startedInitialization();}),
    libraryWorkspace: async () => {workspaceCalls++; return '/synthetic-workspace';},
    acquire: async () => {downloads++; throw new Error('unexpected_download');}
  }, () => {}, undefined);
  const processing = worker.process({stage: 'download', projectId: null, id: 'job', generation: 'generation',
    libraryItemId: 'paper', title: 'Fixture', source: null, attempts: 0}, controller.signal, () => {
    controller.signal.throwIfAborted();
    if (!current) throw new Error('literature_acquisition_changed');
  });
  await started;
  if (invalidation === 'cancel') controller.abort(new Error('cancelled'));
  else current = false;
  releaseInitialization();
  await assert.rejects(processing, invalidation === 'cancel' ? /cancelled/u : /literature_acquisition_changed/u);
  assert.equal(workspaceCalls, 0);
  assert.equal(downloads, 0);
});

test('startup recovers a queued linked stage without a renderer or a new model call', async () => {
  const f = await createResearchPluginFixture(api);
  try {
    const p = project(f);
    const queued = f.repository.runs.begin({ projectId: p.id, expectedStage: 'discovery',
      instruction: 'Synthetic recoverable task', requestId: 'startup-pending' });
    f.tasks.linkStage(queued, null);
    f.repository.runs.bindTask(queued.id, p.id);
    await f.initialize();
    const run = f.repository.runs.get(queued.id, p.id);
    assert.equal(run.status, 'interrupted');
    assert.ok(run.taskId);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(initializedDomains(f), []);
  } finally { await f.close(); }
});

test('an already configured due monitor starts and completes in main without a renderer invocation', async () => {
  const f = await createResearchPluginFixture(api, {
    fetchImpl: async () => Response.json({ message: { 'total-results': 0, items: [] } })
  });
  try {
    const p = project(f);
    const monitors = new api.ResearchMonitorRepository(f.db, f.repository);
    const saved = api.withResearchHumanContext({ capability: 'research.monitors.save', projectId: p.id, windowId: 71 }, () =>
      monitors.save({ projectId: p.id, requestId: 'configured', monitorId: null, expectedRevision: 0,
        title: 'Synthetic recovery monitor', cadence: 'weekly',
        query: { kind: 'search', search: { query: 'Synthetic fixture', sources: ['crossref'], limit: 5, maxPages: 1 } } }));
    const due = api.sealMonitor({ ...saved, nextCheckAt: new Date(Date.now() - 1000).toISOString() });
    f.db.prepare('UPDATE research_monitors SET snapshot_json=? WHERE id=?').run(JSON.stringify(due), due.id);
    await f.initialize();
    assert.deepEqual(initializedDomains(f), ['monitors']);
    let checks = [];
    for (let tries = 0; tries < 200; tries++) {
      checks = monitors.history({ projectId: p.id, monitorId: due.id, offset: 0, limit: 20 }, 'checks').records;
      if (checks.some(check => check.status === 'complete')) break;
      await delay(10);
    }
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'complete');
    assert.equal(checks[0].trigger, 'scheduled');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('startup cleans a persisted download partial before recovering its receipt without re-executing it', async () => {
  const f = await createResearchPluginFixture(api);
  const transport = new api.LiteratureSearchService(async () => Response.json({
    id: 'synthetic/startup', sha: 'a'.repeat(40), private: false, gated: false, disabled: false,
    cardData: { license: 'mit' },
    siblings: [{ rfilename: 'fixture.txt', size: 1, blobId: 'b'.repeat(40) }]
  }));
  let metadata;
  try {
    const p = project(f);
    const observations = new api.HuggingFaceRepository(f.db, f.repository);
    metadata = new api.HuggingFaceService(observations, transport);
    const observed = await metadata.capture({ projectId: p.id, requestId: 'observed',
      kind: 'dataset', repo: 'synthetic/startup', revision: 'a'.repeat(40) });
    const downloads = new api.HuggingFaceDownloadRepository(f.db, observations);
    const started = api.withResearchHumanContext({
      capability: 'research.huggingfaceDownloads.start', projectId: p.id, windowId: 71
    }, () => downloads.create({ projectId: p.id, requestId: 'download', observationId: observed.id,
      expectedContentHash: observed.contentHash, paths: ['fixture.txt'], maxBytes: 1, timeoutMs: 1000,
      licenseReview: 'Reviewed the isolated synthetic MIT fixture.' }).receipt);
    const directory = join(f.directory, 'resources', api.huggingFaceDownloadDirectory(p.id, started.id));
    await mkdir(directory, { recursive: true });
    const partial = join(directory, 'file-0.part');
    await writeFile(partial, 'incomplete synthetic data');
    await f.initialize();
    assert.deepEqual(initializedDomains(f), ['huggingface', 'huggingface-downloads']);
    assert.equal(downloads.get(p.id, started.id).state, 'interrupted');
    await assert.rejects(access(partial));
    assert.equal(f.requests.length, 0);
  } finally { await metadata?.shutdown(); await transport.shutdown(); await f.close(); }
});
