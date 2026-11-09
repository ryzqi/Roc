import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const timestamp = '2026-11-06T00:00:00.000Z';
const identity = {kind: 'model', repo: 'synthetic/fixture', revision: 'a'.repeat(40)};
const blobId = 'b'.repeat(40), sha256 = 'c'.repeat(64);
const payload = (overrides = {}) => ({
  id: identity.repo, sha: identity.revision, private: false, gated: false, disabled: false,
  lastModified: timestamp, cardData: {license: 'other', license_name: 'Synthetic fixture license', license_link: 'LICENSE'},
  siblings: [
    {rfilename: 'README.md', size: 20, blobId},
    {rfilename: 'weights/fixture.bin', size: 40, blobId: 'd'.repeat(40), lfs: {size: 40, sha256, pointerSize: 126}}
  ], ...overrides
});
function scene(fetch, policy = {}) {
  const f = createResearchFixture(api, 'reading');
  let clock = Date.parse(timestamp);
  f.governor = new api.LiteratureProviderGovernor({'huggingface.co': {
    minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100, cooldownMs: 60000, ...policy
  }}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.calls = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.calls.push({url, init}); return fetch === undefined ? Response.json(payload()) : fetch(url, init);
  }, f.governor);
  f.hf = new api.HuggingFaceRepository(f.db, f.repository);
  f.service = new api.HuggingFaceService(f.hf, f.transport, () => timestamp);
  f.request = {projectId: f.project.id, requestId: 'synthetic-hf', ...identity};
  f.read = (saved, offset = 0, limit = 100) => f.hf.read({projectId: f.project.id, observationId: saved.id, offset, limit});
  f.history = (offset = 0, limit = 20, filter = null) => f.hf.history({projectId: f.project.id, identity: filter, offset, limit});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}

test('fixed revision observes complete file identity, license and GET receipts without bytes or workflow effects', async () => {
  const f = scene();
  try {
    const workflow = f.repository.getWorkflow(f.project.id);
    const saved = await f.service.capture(f.request);
    assert.equal(saved.status, 'ok'); assert.equal(saved.fileCount, 2);
    assert.equal(saved.metadata.repo, identity.repo); assert.equal(saved.metadata.revision, identity.revision);
    assert.equal(saved.metadata.license, 'other'); assert.equal(saved.metadata.licenseName, 'Synthetic fixture license');
    assert.equal(saved.metadata.licenseLink, 'LICENSE'); assert.equal(saved.metadata.private, false);
    assert.equal(saved.metadata.gated, false); assert.equal('files' in saved.metadata, false);
    const page = f.read(saved);
    assert.deepEqual(page.files[0], {path: 'README.md', size: 20, blobId, lfs: null});
    assert.deepEqual(page.files[1].lfs, {size: 40, sha256, pointerSize: 126});
    assert.match(saved.responseHash, /^[a-f0-9]{64}$/);
    assert.equal(saved.requests.length, 1); assert.equal(saved.requests[0].method, 'GET');
    assert.equal(f.calls[0].url, api.huggingFaceEndpoint(identity)); assert.equal(f.calls[0].init.redirect, 'error');
    assert.equal(new Headers(f.calls[0].init.headers).has('authorization'), false);
    assert.equal(f.calls.some(call => call.url.includes('/resolve/')), false);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_resource_observations').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
    assert.deepEqual(await f.service.capture(f.request), saved);
    const cached = await f.service.capture({...f.request, requestId: 'new'});
    assert.notEqual(cached.id, saved.id); assert.equal(cached.cache, 'hit');
    assert.equal(cached.fetchedAt, saved.fetchedAt); assert.equal(cached.requests.length, 0); assert.equal(f.calls.length, 1);
    await assert.rejects(f.service.capture({...f.request, revision: 'e'.repeat(40)}), /research_hf_request_conflict/);
  } finally {await f.dispose();}
});

test('models and datasets preserve missing observations and explicit gated states without inferring authorization', () => {
  const unknown = api.readHuggingFaceMetadata({...identity, kind: 'dataset'}, payload({
    private: undefined, gated: undefined, disabled: undefined, cardData: undefined, lastModified: undefined, siblings: []
  }));
  assert.equal(unknown.private, null); assert.equal(unknown.gated, null); assert.equal(unknown.disabled, null);
  assert.equal(unknown.license, null); assert.equal(unknown.lastModified, null); assert.deepEqual(unknown.files, []);
  assert.equal(api.huggingFaceEndpoint({...identity, kind: 'dataset'}).includes('/api/datasets/'), true);
  for (const gated of ['auto', 'manual']) {
    const result = api.readHuggingFaceMetadata(identity, payload({gated, cardData: {license: ['mit', 'apache-2.0']}}));
    assert.equal(result.gated, gated); assert.deepEqual(result.license, ['mit', 'apache-2.0']);
  }
});

test('moving branches, abbreviated revisions, authority fields and unsafe repo or file names are refused', () => {
  for (const revision of ['main', 'a'.repeat(7), 'A'.repeat(40), '../main']) {
    assert.throws(() => api.hfCaptureSchema.parse({...identity, revision, projectId: 'p', requestId: 'r'}));
  }
  for (const repo of ['../escape', 'a/b/c', 'a--b', 'a..b', 'a.git', 'https://huggingface.co/a/b', 'a?token=x']) {
    assert.throws(() => api.hfIdentitySchema.parse({...identity, repo}));
  }
  for (const path of ['/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'a\u0000b', 'a/./b']) {
    assert.throws(() => api.readHuggingFaceMetadata(identity, payload({siblings: [{rfilename: path, size: 1, blobId}]})));
  }
  assert.throws(() => api.parseIpcRequestArgs('roc:research:huggingface-capture', [{projectId: 'p', requestId: 'r', ...identity, token: 'secret'}]));
  assert.throws(() => api.parseIpcRequestArgs('roc:research:literature-search', [{query: 'model', sources: ['huggingface']}]));
});

test('missing file identities, malformed LFS, duplicate paths, bounded inventory and wrong repo/revision fail', () => {
  for (const override of [
    {id: 'synthetic/other'}, {sha: 'e'.repeat(40)}, {siblings: undefined},
    {siblings: [{rfilename: 'a', size: 1}]}, {siblings: [{rfilename: 'a', blobId}]},
    {siblings: [{rfilename: 'a', size: 1, blobId, lfs: {size: 1, oid: sha256, pointerSize: 126}}]},
    {siblings: [{rfilename: 'a', size: 2, blobId, lfs: {size: 1, sha256, pointerSize: 126}}]},
    {siblings: [{rfilename: 'a', size: 1, blobId}, {rfilename: 'a', size: 1, blobId}]},
    {siblings: Array.from({length: 10001}, (_, index) => ({rfilename: `f${index}`, size: 0, blobId}))},
    {gated: true}
  ]) assert.throws(() => api.readHuggingFaceMetadata(identity, payload(override)));
});

test('schema drift records failure without a valid inventory and cannot contaminate the validated cache', async () => {
  let valid = false;
  const f = scene(async () => Response.json(valid ? payload() : payload({siblings: [{rfilename: 'missing-size', blobId}]})));
  try {
    const failed = await f.service.capture(f.request);
    assert.equal(failed.status, 'error'); assert.equal(failed.errorCode, 'literature_provider_response_invalid');
    assert.equal(failed.metadata, null); assert.equal(failed.fileCount, null); assert.equal(f.read(failed).total, null);
    assert.deepEqual(await f.service.capture(f.request), failed); assert.equal(f.calls.length, 1);
    valid = true;
    const saved = await f.service.capture({...f.request, requestId: 'new-after-drift'});
    assert.equal(saved.status, 'ok'); assert.equal(saved.cache, 'miss'); assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});

test('403 and 404 are failed anonymous observations and do not assert repository absence or license', async () => {
  for (const status of [403, 404]) {
    const f = scene(async () => new Response(null, {status}));
    try {
      const saved = await f.service.capture(f.request);
      assert.equal(saved.errorCode, `literature_provider_http_${status}`);
      assert.equal(saved.metadata, null); assert.equal(saved.requests.length, 1); assert.equal(f.calls.length, 1);
    } finally {await f.dispose();}
  }
});

test('429 uses bounded retries, shared cooldown and recorded request receipts', async () => {
  let calls = 0;
  const f = scene(async () => ++calls < 3 ? new Response(null, {status: 429, headers: {'retry-after': '2'}}) : Response.json(payload()));
  try {
    const saved = await f.service.capture(f.request);
    assert.equal(saved.status, 'ok'); assert.deepEqual(saved.requests.map(request => request.status), [429, 429, 200]);
    assert.deepEqual(saved.requests.slice(0, 2).map(request => request.retryAfterMs), [2000, 2000]);
    assert.equal(f.governor.observe('huggingface.co').remainingRequests, 297);
  } finally {await f.dispose();}
});

test('timeout and transport failure retain error receipts with no fabricated metadata', async () => {
  const timed = scene(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
  }));
  try {
    const result = await timed.transport.readProviderJson({source: 'huggingface', url: api.huggingFaceEndpoint(identity),
      projectId: timed.project.id, timeoutMs: 20}, value => api.readHuggingFaceMetadata(identity, value));
    assert.equal(result.errorCode, 'literature_provider_timeout'); assert.equal(result.value, null); assert.equal(result.requests.length, 1);
  } finally {await timed.dispose();}
  const failed = scene(async () => {throw new Error('synthetic-offline');});
  try {
    assert.equal((await failed.service.capture(failed.request)).errorCode, 'literature_provider_transport_error');
    assert.equal(failed.calls.length, 1);
  } finally {await failed.dispose();}
});

test('oversized streamed responses are cancelled and never cached', async () => {
  let cancelled = 0;
  const f = scene(async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));}, cancel() {cancelled++;}
  })));
  try {
    const failed = await f.service.capture(f.request);
    assert.equal(failed.errorCode, 'literature_provider_response_too_large'); assert.equal(failed.metadata, null);
    assert.equal(cancelled, 1);
    await f.service.capture({...f.request, requestId: 'again'}); assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});

test('exact concurrent replay shares one query and cancellation fences late responses that ignore abort', async () => {
  let start, release;
  const started = new Promise(resolve => {start = resolve;});
  const response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {start(); return response;});
  try {
    const outcomes = Promise.allSettled([f.service.capture(f.request), f.service.capture(f.request)]);
    await started;
    await assert.rejects(f.service.capture({...f.request, kind: 'dataset'}), /research_hf_request_conflict/);
    assert.equal(f.service.cancel({projectId: 'other', requestId: f.request.requestId}).cancelled, false);
    assert.equal(f.service.cancel({projectId: f.project.id, requestId: f.request.requestId}).cancelled, true);
    release(Response.json(payload()));
    assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.message === 'research_hf_capture_cancelled'));
    assert.equal(f.calls.length, 1); assert.equal(f.history().total, 0);
  } finally {release(Response.json(payload())); await f.dispose();}
});

test('shutdown aborts active query and refuses late saves and further captures', async () => {
  let start;
  const started = new Promise(resolve => {start = resolve;});
  const f = scene(async (_url, init) => {
    start(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  try {
    const outcomes = Promise.allSettled([f.service.capture(f.request)]);
    await started; await f.service.shutdown();
    assert.equal((await outcomes)[0].reason.message, 'research_hf_service_closed'); assert.equal(f.history().total, 0);
    await assert.rejects(f.service.capture(f.request), /research_hf_service_closed/);
  } finally {await f.dispose();}
});

test('archive retains history and exact replay while refusing new observations including in-flight saves', async () => {
  let start, release, slow = false;
  const started = new Promise(resolve => {start = resolve;});
  const response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {if (!slow) return Response.json(payload()); start(); return response;});
  try {
    const saved = await f.service.capture(f.request);
    slow = true;
    const outcomes = Promise.allSettled([f.service.capture({...f.request, requestId: 'slow', revision: 'e'.repeat(40)})]);
    await started;
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    release(Response.json(payload({sha: 'e'.repeat(40)})));
    assert.match((await outcomes)[0].reason.message, /research_project_archived/);
    assert.deepEqual(await f.service.capture(f.request), saved); assert.equal(f.history().total, 1);
    await assert.rejects(f.service.capture({...f.request, requestId: 'new'}), /research_project_archived/);
  } finally {release(Response.json(payload())); await f.dispose();}
});

test('full inventory and observation history page with exact identity and project ownership', async () => {
  const files = Array.from({length: 101}, (_, index) => ({rfilename: `files/f${index}`, size: index, blobId}));
  const f = scene(async () => Response.json(payload({siblings: files})));
  try {
    const saved = await f.service.capture(f.request);
    assert.equal(f.read(saved).total, 101); assert.equal(f.read(saved).nextOffset, 100);
    assert.equal(f.read(saved, 100).files[0].path, 'files/f100'); assert.equal(f.read(saved, 100).nextOffset, null);
    for (let index = 0; index < 3; index++) await f.service.capture({...f.request, requestId: `h${index}`});
    assert.equal(f.history(0, 2).total, 4); assert.equal(f.history(0, 2).nextOffset, 2);
    assert.equal(f.history(2, 2).nextOffset, null); assert.equal(f.history(0, 20, identity).total, 4);
    assert.equal(f.history(0, 20, {...identity, kind: 'dataset'}).total, 0);
    const other = f.repository.createProject({title: 'Other', description: 'Synthetic scope', workspacePath: '/synthetic/other'});
    assert.throws(() => f.hf.get(other.id, saved.id), /research_hf_not_found/);
    const second = await f.service.capture({...f.request, projectId: other.id});
    assert.equal(second.cache, 'miss'); assert.equal(f.calls.length, 2); assert.equal(f.history().total, 4);
  } finally {await f.dispose();}
});

test('persisted hashes and physical ownership cannot be bypassed by rehashing a substituted snapshot', async () => {
  const f = scene();
  try {
    const saved = await f.service.capture(f.request);
    const original = f.db.prepare('SELECT snapshot_json FROM research_hf_observations WHERE id=?').pluck().get(saved.id);
    for (const mutate of [
      json => {json.metadata.license = 'changed';},
      json => {json.id = 'wrong-row-id';},
      json => {json.request.repo = 'synthetic/other'; json.metadata.repo = 'synthetic/other'; json.endpoint = api.huggingFaceEndpoint(json.request);},
      json => {json.request.revision = 'e'.repeat(40); json.metadata.revision = 'e'.repeat(40); json.endpoint = api.huggingFaceEndpoint(json.request);},
      json => {json.request.projectId = 'other'; json.projectId = 'other';},
      json => {json.request.requestId = 'other';}
    ]) {
      const json = JSON.parse(original); mutate(json);
      if (json.metadata.license !== 'changed') {
        const {contentHash: _hash, ...body} = json; json.contentHash = api.resourceContentHash(body);
      }
      f.db.prepare('UPDATE research_hf_observations SET snapshot_json=? WHERE id=?').run(JSON.stringify(json), saved.id);
      assert.throws(() => f.read(saved), /research_hf_snapshot_invalid/);
    }
    f.db.prepare('UPDATE research_hf_observations SET snapshot_json=? WHERE id=?').run(original, saved.id);
    const reopened = new Database(f.db.serialize());
    try {
      const research = new api.ResearchRepository(reopened, f.tasks, () => timestamp);
      assert.deepEqual(new api.HuggingFaceRepository(reopened, research).get(f.project.id, saved.id), f.hf.get(f.project.id, saved.id));
    } finally {reopened.close();}
  } finally {await f.dispose();}
});

test('capability and strict IPC expose project-scoped bounded observations with no download or gated acceptance', async () => {
  const f = scene(), registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchHuggingFaceCapabilities) registry.declare('synthetic', descriptor);
    api.registerResearchHuggingFaceCapabilities({pluginId: 'synthetic', capabilities: registry}, f.service, f.hf);
    const saved = await registry.invoke('research.huggingface.capture', api.parseIpcRequestArgs('roc:research:huggingface-capture', [f.request])[0]);
    const page = await registry.invoke('research.huggingface.read', {projectId: f.project.id, observationId: saved.id, offset: 0, limit: 1});
    assert.equal(page.total, 2); assert.equal(page.files.length, 1); assert.equal(page.nextOffset, 1);
    assert.throws(() => api.hfReadSchema.parse({projectId: f.project.id, observationId: saved.id, offset: 0, limit: 101}));
    assert.throws(() => api.hfHistorySchema.parse({projectId: f.project.id, identity: null, offset: 0, limit: 51}));
    await assert.rejects(registry.invoke('research.huggingface.capture', {...f.request, requestId: 'foreign', projectId: 'missing'}));
    assert.deepEqual(api.researchHuggingFaceCapabilities.map(row => row.name).sort(),
      ['research.huggingface.cancel', 'research.huggingface.capture', 'research.huggingface.history', 'research.huggingface.read']);
  } finally {await f.dispose();}
});
