import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';

let directory, api;
before(async () => {
  directory = await mkdtemp(join(process.cwd(), '.runtime/tmp/p5-acquisition-ipc-'));
  const outfile = join(directory, 'fixture.mjs');
  await build({stdin: {contents: `
    import './src/preload/index';
    export {transport} from 'electron';
    export {rocApi} from './src/preload/ipc-api-generated';
    export {ipcRegistry, parseIpcRequestArgs, parseIpcResult} from './src/shared/ipc-registry';
    export {registerPluginCapabilityIpc} from './src/main/ipc/plugin-capability-adapter';
    export {executeIpcRequest} from './src/main/ipc/ipc-common';
    export {CapabilityRegistry} from './src/main/kernel/capability-registry';
    export {literatureAcquisitionCapabilities, registerLiteratureAcquisitionCapabilities}
      from './src/main/plugins/research/literature-acquisition-capabilities';
    export {literatureContext} from './src/main/services/literature-context';
    export {RocDomainError} from './src/main/services/errors';
    export {ResearchRepository} from './src/main/plugins/research/repository';
    export {ResearchTaskRepository} from './src/main/plugins/research/research-task-repository';
    export {applyAgentDatabaseSchema, applyResearchDatabaseSchema} from './src/main/infrastructure/database-schemas';
    export {LiteratureAcquisitionRepository} from './src/main/plugins/research/literature-acquisition-repository';
    export {LiteratureAcquisitionService} from './src/main/plugins/research/literature-acquisition-service';
    export {createRocClient} from './src/renderer/shared/roc-client';
    export {listLiteratureProcessing, changeLiteratureProcessing} from './src/renderer/literature/literature-processing';
  `, resolveDir: process.cwd()}, outfile, bundle: true, format: 'esm', platform: 'node',
    packages: 'external', logLevel: 'silent', plugins: [{name: 'synthetic-electron-transport', setup(builder) {
      builder.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'synthetic-electron'}));
      builder.onLoad({filter: /.*/, namespace: 'synthetic-electron'}, () => ({contents: `
        export const transport = {handlers: new Map(), calls: [], exposed: {}, senderId: 71};
        export const contextBridge = {exposeInMainWorld: (name, value) => {transport.exposed[name] = value;}};
        export const ipcRenderer = {
          invoke: async (channel, ...args) => {
            transport.calls.push({channel, args});
            const handler = transport.handlers.get(channel);
            if (!handler) throw new Error('synthetic_ipc_handler_missing:' + channel);
            return handler({sender: {id: transport.senderId}}, ...args);
          },
          on() {}, off() {}
        };
      `}));
    }}]});
  api = await import(pathToFileURL(outfile).href);
});
after(async () => {if (directory) await rm(directory, {recursive: true, force: true});});

const endpoints = [
  ['listAcquisition', 'researchAcquisitionList', 'roc:research:acquisition-list'],
  ['retryAcquisition', 'researchAcquisitionRetry', 'roc:research:acquisition-retry'],
  ['cancelAcquisition', 'researchAcquisitionCancel', 'roc:research:acquisition-cancel']
];
const job = (overrides = {}) => ({id: 'job-a', projectId: 'project-a', libraryItemId: 'item-a', title: 'Synthetic paper',
  generation: 'generation-a', stage: 'parse', status: 'blocked', attempts: 1, nextRetryAt: null,
  documentId: 'old-pdf', receipt: null, errorCode: 'synthetic_parse_failure', updatedAt: '2026-11-19T00:00:00.000Z', ...overrides});
const listRequest = {projectId: 'project-a', destination: 'current_project', offset: 0, limit: 20};
const changeRequest = {projectId: 'project-a', destination: 'current_project', jobId: 'job-a', generation: 'generation-a'};

function scene({list, change, service: realService, config = new Map()} = {}) {
  const calls = [], registry = new api.CapabilityRegistry();
  for (const descriptor of api.literatureAcquisitionCapabilities) registry.declare('research', descriptor);
  const service = {
    list: async input => {
      calls.push({method: 'list', input, context: api.literatureContext()});
      return list ? list(input) : {jobs: [job()], total: 1, nextOffset: null};
    },
    change: async (input, action) => {
      calls.push({method: action, input, context: api.literatureContext()});
      return change ? change(input, action) : job({status: action === 'retry' ? 'queued' : 'cancelled',
        generation: action === 'retry' ? 'generation-b' : input.generation,
        stage: input.replacementDocumentId ? 'resolve' : 'parse', documentId: input.replacementDocumentId ?? 'old-pdf', errorCode: null});
    }
  };
  api.registerLiteratureAcquisitionCapabilities({pluginId: 'research', capabilities: registry, config}, realService ?? service);
  api.transport.handlers.clear(); api.transport.calls.length = 0;
  api.registerPluginCapabilityIpc((channel, handler) => {
    assert.equal(api.transport.handlers.has(channel), false, channel);
    api.transport.handlers.set(channel, (event, ...args) => api.executeIpcRequest(channel, event, args, handler));
  }, {invokeCapability: (name, input) => registry.invoke(name, input)});
  return {calls, client: api.createRocClient(api.transport.exposed.roc)};
}

test('acquisition preferences traverse generated IPC, persist, validate and disable optional DOI lookup', async () => {
  const config = new Map();
  let f = scene({config});
  assert.deepEqual((await f.client.api.research.acquisitionSettings({})).data,
    {versionPreference: 'balanced', unpaywallEmail: null});
  const settings = {versionPreference: 'published', unpaywallEmail: 'contact@example.org'};
  assert.deepEqual((await f.client.api.research.saveAcquisitionSettings(settings)).data, settings);
  f = scene({config});
  assert.deepEqual((await f.client.api.research.acquisitionSettings({})).data, settings);
  const invalid = await f.client.api.research.saveAcquisitionSettings({...settings, unpaywallEmail: 'invalid'});
  assert.equal(invalid.ok, false);
  assert.deepEqual((await f.client.api.research.acquisitionSettings({})).data, settings);
  const disabled = {versionPreference: 'preprint', unpaywallEmail: null};
  assert.deepEqual((await f.client.api.research.saveAcquisitionSettings(disabled)).data, disabled);
});

test('real generated preload methods, registry contracts and main handlers expose all three acquisition capabilities', async () => {
  const f = scene();
  assert.equal(api.transport.exposed.roc, api.rocApi);
  for (const [method, key, channel] of endpoints) {
    const entry = api.ipcRegistry.requests.find(candidate => candidate.key === key);
    assert.ok(entry, key);
    assert.equal(entry.channel, channel); assert.equal(entry.domain, 'research'); assert.equal(entry.method, method);
    assert.equal(entry.kind, 'plugin'); assert.equal(entry.capabilityName, `research.library.${method}`);
    assert.deepEqual(entry.inputTransform, {kind: 'first'});
    assert.equal(typeof f.client.api.research[method], 'function');
    assert.equal(api.transport.handlers.has(channel), true, channel);
    const request = method === 'listAcquisition' ? listRequest : changeRequest;
    const result = await f.client.api.research[method](request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(api.transport.calls.at(-1), {channel, args: [request]});
    assert.deepEqual(f.calls.at(-1).input, request);
    assert.deepEqual(f.calls.at(-1).context, {owner: 'window:71', projectId: 'project-a'});
    assert.deepEqual(api.parseIpcResult(channel, result), result);
  }
  assert.deepEqual(f.calls.map(call => call.method), ['list', 'retry', 'cancel']);
});

test('renderer helpers traverse the real generated preload and preserve selected replacement PDF and generation', async () => {
  const f = scene();
  const listed = await api.listLiteratureProcessing(f.client, 'project-a', 0);
  assert.equal(listed.ok, true); assert.deepEqual(listed.data.jobs, [job()]);
  const retried = await api.changeLiteratureProcessing(f.client, 'project-a', job(), 'retry', 'replacement-pdf');
  assert.equal(retried.ok, true); assert.equal(retried.data.documentId, 'replacement-pdf');
  assert.deepEqual(f.calls[1].input, {...changeRequest, replacementDocumentId: 'replacement-pdf'});
  const cancelled = await api.changeLiteratureProcessing(f.client, 'project-a', job(), 'cancel');
  assert.equal(cancelled.ok, true); assert.equal(cancelled.data.status, 'cancelled');
  assert.deepEqual(f.calls[2].input, changeRequest);
  assert.equal(Object.hasOwn(f.calls[2].input, 'replacementDocumentId'), false);
});

test('IPC rejects missing generation, forged authority, invalid paging and replacement IDs before backend invocation', async () => {
  const f = scene();
  for (const [method, , channel] of endpoints) {
    const request = method === 'listAcquisition' ? listRequest : changeRequest;
    const invalid = [{...request, owner: 'thread:forged'}, {...request, runId: 'forged'}, {...request, extra: true}];
    if (method === 'listAcquisition') invalid.push({...request, offset: -1}, {...request, limit: 51});
    else {
      const {generation, ...missingGeneration} = request;
      invalid.push(missingGeneration, {...request, generation: ''}, {...request, replacementDocumentId: ''});
    }
    for (const args of [[], [request, request], ...invalid.map(input => [input])]) {
      assert.throws(() => api.parseIpcRequestArgs(channel, args));
      const result = await f.client.api.research[method](...args);
      assert.equal(result.ok, false, JSON.stringify({method, args, result}));
    }
  }
  assert.equal(f.calls.length, 0);
});

test('IPC preserves generation conflicts without replay and rejects malformed successful results', async () => {
  const f = scene({change: () => {throw new api.RocDomainError({code: 'research_acquisition_generation_conflict',
    message: 'Refresh before retry', category: 'conflict', retryable: false});}});
  const result = await api.changeLiteratureProcessing(f.client, 'project-a', job(), 'retry', 'replacement-pdf');
  assert.equal(result.ok, false); assert.equal(result.error.code, 'research_acquisition_generation_conflict');
  assert.equal(f.calls.length, 1); assert.equal(api.transport.calls.length, 1);
  const malformed = scene({list: () => ({jobs: [job({status: 'done'})], total: 1, nextOffset: null})});
  assert.equal((await malformed.client.api.research.listAcquisition(listRequest)).ok, false);
  assert.throws(() => api.parseIpcResult(endpoints[1][2], {ok: true, data: job({status: 'done'})}));
});

test('real repository conflicts, missing jobs and invalid replacement PDFs reach the renderer as actionable errors', async () => {
  const db = new Database(':memory:'), agentDb = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const now = () => '2026-11-19T00:00:00.000Z';
  api.applyResearchDatabaseSchema(db, now); api.applyAgentDatabaseSchema(agentDb);
  const repository = new api.ResearchRepository(db, new api.ResearchTaskRepository(agentDb), now);
  const jobs = new api.LiteratureAcquisitionRepository(db, now);
  const service = new api.LiteratureAcquisitionService(jobs);
  try {
    const project = repository.createProject({title: 'IPC fixture', description: '', workspacePath: '/synthetic-ipc-workspace'});
    const metadata = {id: 'crossref:ipc', source: 'crossref', externalId: 'ipc', doi: null, title: 'IPC fixture',
      authors: [], abstract: '', publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
      importedAt: now(), updatedAt: now()};
    const item = repository.library.import([{metadata, bibliography: {citationKey: 'ipc', entryType: 'article',
      fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: [], doi: null,
      publishedYear: 2026, abstract: '', url: null}}], project.id, {notify: false}).items[0];
    db.transaction(() => jobs.enqueue(project.id, item.id))();
    const claim = jobs.claim();
    jobs.complete(claim, {status: 'blocked', errorCode: 'synthetic_blocked'});
    const scope = {owner: 'window:71', projectId: project.id};
    const current = jobs.getScoped(scope, 'current_project', claim.id);
    const f = scene({service});
    const request = {projectId: project.id, destination: 'current_project', jobId: current.id, generation: current.generation};
    for (const [method, input, code, category] of [
      ['retryAcquisition', {...request, generation: 'stale'}, 'literature_acquisition_changed', 'conflict'],
      ['cancelAcquisition', {...request, generation: 'stale'}, 'literature_acquisition_changed', 'conflict'],
      ['retryAcquisition', {...request, jobId: 'missing'}, 'literature_acquisition_not_found', 'not_found'],
      ['retryAcquisition', {...request, replacementDocumentId: 'missing-pdf'}, 'literature_acquisition_replacement_invalid', 'validation']
    ]) {
      const result = await f.client.api.research[method](input);
      assert.equal(result.ok, false); assert.equal(result.error.code, code);
      assert.equal(result.error.category, category); assert.equal(result.error.retryable, false);
      assert.match(result.error.message, /文献处理|补充的 PDF/u);
      assert.deepEqual(jobs.getScoped(scope, 'current_project', claim.id), current);
    }
    assert.equal(api.transport.calls.length, 4, 'a conflict cannot replay a write automatically');
  } finally {
    await service.shutdown();
    await Promise.all([repository.knowledgeJobs.shutdown(), repository.paperCards.shutdown(), repository.wiki.shutdown()]);
    db.close(); agentDb.close();
  }
});
