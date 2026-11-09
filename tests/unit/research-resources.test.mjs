import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const doi = '10.1234/resource';
const timestamp = '2026-11-06T00:00:00.000Z';
const payload = (overrides = {}) => ({data: {id: doi, type: 'dois', attributes: {
  doi, state: 'findable', types: {resourceTypeGeneral: 'Dataset', resourceType: 'Synthetic table'},
  titles: [{title: 'Synthetic dataset', lang: 'en'}], version: '2.1',
  schemaVersion: 'http://datacite.org/schema/kernel-4', url: 'https://example.org/synthetic',
  rightsList: [{rights: 'Synthetic license observation', rightsUri: 'https://example.org/license',
    rightsIdentifier: 'synthetic', rightsIdentifierScheme: 'synthetic', schemeUri: 'https://example.org/rights', lang: 'en'}],
  relatedIdentifiers: [{relatedIdentifier: '10.1234/article', relatedIdentifierType: 'DOI',
    relationType: 'IsSupplementTo', resourceTypeGeneral: 'JournalArticle', relationTypeInformation: 'Synthetic supplement'}],
  ...overrides
}}});
function scene(fetch, policy = {}) {
  const f = createResearchFixture(api, 'reading');
  let clock = Date.parse(timestamp);
  f.governor = new api.LiteratureProviderGovernor({'api.datacite.org': {
    minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100, cooldownMs: 60000, ...policy
  }}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.calls = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.calls.push({url, init});
    return fetch === undefined ? Response.json(payload()) : fetch(url, init);
  }, f.governor);
  f.resources = new api.ResearchResourceRepository(f.db, f.repository);
  f.service = new api.ResearchResourceService(f.resources, f.transport, () => timestamp);
  f.request = {projectId: f.project.id, requestId: 'synthetic-resource', doi};
  f.read = (saved, offset = 0, limit = 100) => f.resources.read({projectId: f.project.id, resourceId: saved.id, offset, limit});
  f.history = (offset = 0, limit = 20) => f.resources.history({projectId: f.project.id, doi: null, offset, limit});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}

test('resource metadata preserves DOI, exact version, rights and direction without importing literature or changing approvals', async () => {
  const f = scene();
  try {
    const workflow = f.repository.getWorkflow(f.project.id);
    const saved = await f.service.capture({...f.request, doi: `https://doi.org/${doi.toUpperCase()}`});
    assert.equal(saved.status, 'ok'); assert.equal(saved.metadata.kind, 'dataset');
    assert.equal(saved.metadata.doi, doi); assert.equal(saved.metadata.version, '2.1');
    assert.equal(saved.metadata.rights[0].rightsIdentifier, 'synthetic');
    assert.equal(saved.metadata.rights[0].lang, 'en');
    assert.equal('relatedIdentifiers' in saved.metadata, false);
    const read = f.read(saved);
    assert.equal(read.resource.metadata.doi, doi);
    assert.equal(read.relatedIdentifiers[0].relatedIdentifier, '10.1234/article');
    assert.equal(read.relatedIdentifiers[0].relationType, 'IsSupplementTo');
    assert.equal(read.relatedIdentifiers[0].relationTypeInformation, 'Synthetic supplement');
    assert.equal(saved.requests.length, 1); assert.equal(saved.requests[0].method, 'GET');
    assert.equal(f.calls[0].init.redirect, 'error');
    assert.equal(f.calls[0].url, `https://api.datacite.org/dois/${encodeURIComponent(doi)}`);
    assert.match(saved.responseHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
    assert.deepEqual(await f.service.capture(f.request), saved); assert.equal(f.calls.length, 1);
    const cached = await f.service.capture({...f.request, requestId: 'new'});
    assert.notEqual(cached.id, saved.id); assert.equal(cached.cache, 'hit'); assert.equal(cached.requests.length, 0);
    assert.equal(cached.fetchedAt, saved.fetchedAt); assert.equal(f.history().total, 2);
    await assert.rejects(f.service.capture({...f.request, doi: '10.1234/other'}), /research_resource_request_conflict/);
  } finally {await f.dispose();}
});

test('absent fields remain unknown, reported empty relations remain empty and software remains a resource', () => {
  const bare = payload({version: undefined, rightsList: undefined, relatedIdentifiers: undefined, schemaVersion: undefined,
    types: {resourceTypeGeneral: 'Software'}});
  const metadata = api.readDataCiteMetadata(doi, JSON.parse(JSON.stringify(bare)));
  assert.equal(metadata.kind, 'software'); assert.equal(metadata.resourceType, null);
  assert.equal(metadata.version, null); assert.equal(metadata.rights, null);
  assert.equal(metadata.relatedIdentifiers, null); assert.equal(metadata.reportedSchemaVersion, null);
  assert.deepEqual(api.readDataCiteMetadata(doi, payload({rightsList: [], relatedIdentifiers: []})).rights, []);
  assert.throws(() => api.readDataCiteMetadata(doi, payload({types: {resourceTypeGeneral: 'JournalArticle'}})));
  assert.throws(() => api.readDataCiteMetadata(doi, payload({state: 'registered'})));
  assert.throws(() => api.readDataCiteMetadata(doi, payload({doi: '10.1234/wrong'})), /literature_provider_response_invalid/);
});

test('schema or identity failure is saved as failure and cannot contaminate validated cache', async () => {
  let valid = false;
  const f = scene(async () => Response.json(valid ? payload() : payload({titles: []})));
  try {
    const failed = await f.service.capture(f.request);
    assert.equal(failed.status, 'error'); assert.equal(failed.errorCode, 'literature_provider_response_invalid');
    assert.equal(failed.metadata, null); assert.equal(failed.relatedCount, null); assert.equal(f.read(failed).total, null);
    assert.deepEqual(await f.service.capture(f.request), failed); assert.equal(f.calls.length, 1);
    valid = true;
    const saved = await f.service.capture({...f.request, requestId: 'new-after-failure'});
    assert.equal(saved.status, 'ok'); assert.equal(saved.cache, 'miss'); assert.equal(f.calls.length, 2);
    const wrong = payload(); wrong.data.id = '10.1234/wrong';
    assert.throws(() => api.readDataCiteMetadata(doi, wrong), /literature_provider_response_invalid/);
  } finally {await f.dispose();}
});

test('public API 404 remains public metadata unavailable and does not establish global DOI nonexistence', async () => {
  const f = scene(async () => new Response(null, {status: 404}));
  try {
    const saved = await f.service.capture(f.request);
    assert.equal(saved.status, 'error'); assert.equal(saved.errorCode, 'literature_provider_http_404');
    assert.equal(saved.metadata, null); assert.equal(saved.requests.length, 1); assert.equal(f.calls.length, 1);
  } finally {await f.dispose();}
});

test('429 respects shared cooldown and retries bounded GET before saving the actual receipts', async () => {
  let calls = 0;
  const f = scene(async () => ++calls < 3 ? new Response(null, {status: 429, headers: {'retry-after': '2'}}) : Response.json(payload()));
  try {
    const saved = await f.service.capture(f.request);
    assert.equal(saved.status, 'ok'); assert.deepEqual(saved.requests.map(request => request.status), [429, 429, 200]);
    assert.deepEqual(saved.requests.slice(0, 2).map(request => request.retryAfterMs), [2000, 2000]);
    assert.equal(f.governor.observe('api.datacite.org').remainingRequests, 297);
  } finally {await f.dispose();}
});

test('transport failure makes one attempt and oversized streamed JSON cannot enter cache or resource metadata', async () => {
  const failed = scene(async () => {throw new Error('synthetic-offline');});
  try {
    const saved = await failed.service.capture(failed.request);
    assert.equal(saved.errorCode, 'literature_provider_transport_error'); assert.equal(failed.calls.length, 1);
  } finally {await failed.dispose();}
  let cancelled = 0;
  const huge = scene(async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));},
    cancel() {cancelled++;}
  })));
  try {
    const saved = await huge.service.capture(huge.request);
    assert.equal(saved.errorCode, 'literature_provider_response_too_large'); assert.equal(saved.metadata, null);
    assert.equal(cancelled, 1);
    await huge.service.capture({...huge.request, requestId: 'again'});
    assert.equal(huge.calls.length, 2);
  } finally {await huge.dispose();}
});

test('timeout includes admission and never fabricates resource metadata', async () => {
  const f = scene(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
  }));
  try {
    const result = await f.transport.readProviderJson({source: 'datacite', url: api.dataciteEndpoint(doi),
      projectId: f.project.id, timeoutMs: 20}, value => api.readDataCiteMetadata(doi, value));
    assert.equal(result.status, 'error'); assert.equal(result.value, null); assert.equal(result.errorCode, 'literature_provider_timeout');
    assert.equal(result.requests.length, 1);
  } finally {await f.dispose();}
});

test('exact concurrent replay shares one job and cancellation fences even a response that ignores its signal', async () => {
  let start, release;
  const started = new Promise(resolve => {start = resolve;});
  const response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {start(); return response;});
  try {
    const first = f.service.capture(f.request), second = f.service.capture(f.request);
    await started;
    await assert.rejects(f.service.capture({...f.request, doi: '10.1234/different'}), /research_resource_request_conflict/);
    assert.equal(f.service.cancel({projectId: f.project.id, requestId: f.request.requestId}).cancelled, true);
    release(Response.json(payload()));
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'research_resource_capture_cancelled'));
    assert.equal(f.calls.length, 1); assert.equal(f.history().total, 0);
    assert.equal(f.service.cancel({projectId: f.project.id, requestId: f.request.requestId}).cancelled, false);
  } finally {await f.dispose();}
});

test('shutdown aborts active requests and never saves a late response', async () => {
  let start;
  const started = new Promise(resolve => {start = resolve;});
  const f = scene(async (_url, init) => {
    start();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  try {
    const pending = f.service.capture(f.request);
    const outcome = Promise.allSettled([pending]);
    await started; await f.service.shutdown();
    assert.equal((await outcome)[0].reason.message, 'research_resource_service_closed');
    assert.equal(f.history().total, 0);
    await assert.rejects(f.service.capture(f.request), /research_resource_service_closed/);
  } finally {await f.dispose();}
});

test('archives block new captures and archive during a request cannot save a new observation', async () => {
  let start, release;
  const started = new Promise(resolve => {start = resolve;});
  const response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {start(); return response;});
  try {
    const pending = f.service.capture(f.request);
    await started;
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    release(Response.json(payload()));
    await assert.rejects(pending, /research_project_archived/);
    await assert.rejects(f.service.capture({...f.request, requestId: 'new'}), /research_project_archived/);
    assert.equal(f.history().total, 0);
  } finally {await f.dispose();}
});

test('history and relation pages retain reported counts and unknown fields with project ownership', async () => {
  const relations = Array.from({length: 101}, (_, index) => ({
    relatedIdentifier: `10.1234/resource-${index}`, relatedIdentifierType: 'DOI', relationType: 'References'
  }));
  const f = scene(async () => Response.json(payload({relatedIdentifiers: relations})));
  try {
    const first = await f.service.capture(f.request);
    const page = f.read(first, 0, 100); assert.equal(page.total, 101); assert.equal(page.nextOffset, 100);
    assert.equal(f.read(first, 100, 100).relatedIdentifiers.length, 1);
    for (let index = 0; index < 3; index++) await f.service.capture({...f.request, requestId: `history-${index}`});
    assert.equal(f.history(0, 2).total, 4); assert.equal(f.history(0, 2).nextOffset, 2);
    assert.equal(f.history(2, 2).nextOffset, null);
    const other = f.repository.createProject({title: 'Other project', description: 'Synthetic scope', workspacePath: '/synthetic/other'});
    assert.throws(() => f.resources.read({projectId: other.id, resourceId: first.id, offset: 0, limit: 1}), /research_resource_not_found/);
    const json = JSON.parse(f.db.prepare('SELECT snapshot_json FROM research_resource_observations WHERE id=?').pluck().get(first.id));
    json.id = 'changed-row-identity';
    const {contentHash: _hash, ...body} = json; json.contentHash = api.resourceContentHash(body);
    f.db.prepare('UPDATE research_resource_observations SET snapshot_json=? WHERE id=?').run(JSON.stringify(json), first.id);
    assert.throws(() => f.read(first), /research_resource_snapshot_invalid/);
  } finally {await f.dispose();}
});

test('one shared quota isolates project caches and enforces the configured HTTPS host before any GET', async () => {
  const f = scene(undefined, {maxRequests: 1});
  const request = {source: 'datacite', url: api.dataciteEndpoint(doi), projectId: f.project.id, timeoutMs: 1000};
  const validate = value => api.readDataCiteMetadata(doi, value);
  try {
    assert.equal((await f.transport.readProviderJson(request, validate)).status, 'ok');
    assert.equal((await f.transport.readProviderJson(request, validate)).cache, 'hit');
    const miss = await f.transport.readProviderJson({...request, projectId: 'other'}, validate);
    assert.equal(miss.errorCode, 'literature_provider_quota_exhausted'); assert.equal(f.calls.length, 1);
    await assert.rejects(f.transport.readProviderJson({...request, url: 'https://example.org/dois/x'}, validate), /literature_provider_url_invalid/);
    const http = await f.transport.readProviderJson({...request, url: request.url.replace('https:', 'http:')}, validate);
    assert.equal(http.status, 'error'); assert.equal(f.calls.length, 1);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:literature-search', [{query: 'dataset', sources: ['datacite']}]));
  } finally {await f.dispose();}
});

test('capability and generated IPC contracts expose bounded metadata and reject undeclared authority fields', async () => {
  const f = scene(), registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchResourceCapabilities) registry.declare('synthetic', descriptor);
    api.registerResearchResourceCapabilities({pluginId: 'synthetic', capabilities: registry}, f.service, f.resources);
    const args = api.parseIpcRequestArgs('roc:research:resource-capture', [f.request]);
    const saved = await registry.invoke('research.resource.capture', args[0]);
    const page = await registry.invoke('research.resource.read', {projectId: f.project.id, resourceId: saved.id, offset: 0, limit: 1});
    assert.equal(page.total, 1); assert.equal(page.relatedIdentifiers.length, 1);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:resource-capture', [{...f.request, authority: 'user'}]));
    await assert.rejects(registry.invoke('research.resource.capture', {...f.request, requestId: 'wrong', projectId: 'missing'}));
  } finally {await f.dispose();}
});
