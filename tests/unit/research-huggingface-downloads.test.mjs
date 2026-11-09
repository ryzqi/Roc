import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const timestamp = '2026-11-06T00:00:00.000Z';
const identity = {kind: 'dataset', repo: 'synthetic/download', revision: 'a'.repeat(40)};
const contents = [Buffer.from('synthetic git file\n'), Buffer.from('synthetic LFS bytes\n')];
const sha = value => createHash('sha256').update(value).digest('hex');
const siblings = contents.map((content, index) => ({
  rfilename: index === 0 ? 'data/A.csv' : 'data/a.csv', size: content.length,
  blobId: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
  ...(index === 1 ? {lfs: {size: content.length, sha256: sha(content), pointerSize: 126}} : {})
}));
function stream(chunks) {
  return new Response(new ReadableStream({start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  }}));
}
async function scene(fetchImpl, metadata = {}) {
  const f = createResearchFixture(api, 'reading');
  f.root = await mkdtemp(join(tmpdir(), 'roc-hf-download-'));
  let clock = Date.parse(timestamp);
  f.governor = new api.LiteratureProviderGovernor({'huggingface.co': {
    minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100, cooldownMs: 60000
  }}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.observations = new api.HuggingFaceRepository(f.db, f.repository);
  f.transport = new api.LiteratureSearchService(async () => Response.json({
    id: identity.repo, sha: identity.revision, private: false, gated: false, disabled: false,
    cardData: {license: 'other', license_name: 'Synthetic test-only data'}, siblings, ...metadata
  }), f.governor);
  f.metadataService = new api.HuggingFaceService(f.observations, f.transport);
  f.observed = await f.metadataService.capture({projectId: f.project.id, requestId: 'observation', ...identity});
  f.downloads = new api.HuggingFaceDownloadRepository(f.db, f.observations);
  f.calls = [];
  f.downloader = new api.HuggingFaceDownloader(f.governor, async (url, init) => {
    f.calls.push({url, init});
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_hf_downloads').pluck().get() > 0, true);
    return fetchImpl === undefined ? stream([contents[f.calls.length - 1]]) : fetchImpl(url, init, f);
  });
  f.service = new api.HuggingFaceDownloadService(f.downloads, f.observations, f.downloader, f.root);
  await f.service.initialize();
  f.request = {projectId: f.project.id, requestId: 'download', observationId: f.observed.id,
    expectedContentHash: f.observed.contentHash, paths: siblings.map(file => file.rfilename),
    maxBytes: contents.reduce((sum, value) => sum + value.length, 0), timeoutMs: 10000,
    licenseReview: 'I reviewed the synthetic test license and selected files.'};
  f.human = action => api.withResearchHumanContext({
    capability: 'research.huggingfaceDownloads.start', projectId: f.project.id, windowId: 41
  }, action);
  f.start = (overrides = {}) => f.human(() => f.service.start({...f.request, ...overrides}));
  f.read = receipt => f.service.read({projectId: f.project.id, downloadId: receipt.id});
  f.directory = receipt => join(f.root, api.huggingFaceDownloadDirectory(f.project.id, receipt.id));
  f.terminal = async receipt => {
    for (let tries = 0; tries < 500; tries++) {
      const current = f.read(receipt);
      if (current.state !== 'running') return current;
      await delay(10);
    }
    assert.fail('download did not terminate within 5 seconds');
  };
  f.dispose = async () => {
    try {await f.service.shutdown();}
    finally {await f.metadataService.shutdown(); await f.transport.shutdown(); f.close(); await rm(f.root, {recursive: true, force: true});}
  };
  return f;
}

test('reviewed stream downloads Git and LFS payloads, persists before GET and retains physical file identities', async () => {
  const f = await scene();
  try {
    const before = f.repository.getWorkflow(f.project.id);
    const started = f.start(); assert.equal(started.state, 'running'); assert.equal(started.actor.id, 'window:41');
    const result = await f.terminal(started);
    assert.equal(result.state, 'completed'); assert.equal(result.files.length, 2);
    assert.equal(result.lastRecordedTransferredBytes, f.request.maxBytes);
    assert.equal(result.verifiedBytes, f.request.maxBytes); assert.equal(result.requests.length, 2);
    assert.equal(f.governor.observe('huggingface.co').remainingRequests, 297, 'metadata and downloads share quota');
    for (const [index, file] of result.files.entries()) {
      assert.equal(file.sha256, sha(contents[index])); assert.equal(file.storageName, `file-${index}`);
      assert.deepEqual(await readFile(join(f.directory(result), file.storageName)), contents[index]);
      assert.equal(f.calls[index].url, api.huggingFaceResolveUrl(identity, siblings[index].rfilename));
      assert.equal(f.calls[index].init.redirect, 'manual'); assert.equal(f.calls[index].init.credentials, 'omit');
      assert.equal(new Headers(f.calls[index].init.headers).has('authorization'), false);
      assert.equal(result.requests[index].status, 200); assert.ok(result.requests[index].endedAt);
    }
    assert.deepEqual(await readdir(f.directory(result)), ['file-0', 'file-1']);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
    assert.deepEqual(f.start(), result); assert.equal(f.calls.length, 2);
    assert.throws(() => f.start({licenseReview: 'Changed'}), /request_conflict/);
    assert.equal(f.service.cancel({projectId: f.project.id, downloadId: result.id}).cancelled, false);
    assert.throws(() => f.downloads.update(result), /state_conflict/);
  } finally {await f.dispose();}
});

test('wire and capability boundaries refuse actor forgery, missing human and cross-project authorization before GET', async () => {
  const f = await scene();
  try {
    assert.throws(() => f.service.start(f.request), /research_human_required/);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.resourceAssociations.save', projectId: f.project.id, windowId: 41},
      () => f.service.start(f.request)), /research_human_required/);
    assert.throws(() => f.start({projectId: 'foreign'}), /research_human_project_mismatch/);
    for (const changes of [{actor: {kind: 'user', id: 'forged'}}, {token: 'synthetic'}, {paths: [siblings[0].rfilename, siblings[0].rfilename]},
      {paths: ['../escape']}, {timeoutMs: 120001}, {maxBytes: 512 * 1024 * 1024 + 1}, {licenseReview: ''}]) {
      assert.throws(() => api.parseIpcRequestArgs('roc:research:huggingface-download-start', [{...f.request, ...changes}]));
    }
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchHuggingFaceDownloadCapabilities) registry.declare('fixture', descriptor);
    api.registerResearchHuggingFaceDownloadCapabilities({pluginId: 'fixture', capabilities: registry}, f.service);
    await assert.rejects(registry.invoke('research.huggingfaceDownloads.start', f.request), error => error.code === 'research_human_required');
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    const refused = await adapter.invoke('research.startHuggingFaceDownload', [f.request]);
    assert.equal(refused.ok, false);
    assert.equal(f.calls.length, 0);
    const reply = await adapter.invoke('research.startHuggingFaceDownload', [f.request], 72);
    assert.equal(reply.ok, true); assert.equal(reply.data.actor.id, 'window:72');
    assert.equal((await f.terminal(reply.data)).state, 'completed');
  } finally {await f.dispose();}
});

test('unknown/private/gated/disabled observations and mismatched approvals never admit download', async () => {
  for (const metadata of [{private: undefined}, {private: true}, {gated: undefined}, {gated: 'auto'}, {gated: 'manual'}, {disabled: true}]) {
    const f = await scene(undefined, metadata);
    try {assert.throws(() => f.start(), /access_restricted/); assert.equal(f.calls.length, 0);}
    finally {await f.dispose();}
  }
  const f = await scene();
  try {
    assert.throws(() => f.start({expectedContentHash: '0'.repeat(64)}), /source_changed/);
    assert.throws(() => f.start({paths: ['missing']}), /file_missing/);
    assert.throws(() => f.start({maxBytes: 1}), /byte_limit/); assert.equal(f.calls.length, 0);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(() => f.start(), /research_project_archived/);
  } finally {await f.dispose();}
});

test('oversized streamed chunk reports actual observed bytes, removes partial and preserves verified preceding file', async () => {
  const f = await scene((_url, _init, f) => stream([f.calls.length === 1 ? contents[0] : Buffer.alloc(contents[1].length + 5)]));
  try {
    const result = await f.terminal(f.start());
    assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'research_hf_download_byte_limit');
    assert.equal(result.lastRecordedTransferredBytes, f.request.maxBytes + 5); assert.equal(result.verifiedBytes, contents[0].length);
    assert.equal(result.files.length, 1); assert.deepEqual(await readdir(f.directory(result)), ['file-0']);
    assert.deepEqual(f.start(), result); assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});

test('truncated, equal-size corrupt Git and LFS payloads produce strict failures without verified files', async () => {
  for (const [index, content, expected] of [
    [0, contents[0].subarray(1), 'size_mismatch'], [0, Buffer.alloc(contents[0].length), 'hash_mismatch'],
    [1, Buffer.alloc(contents[1].length), 'hash_mismatch']
  ]) {
    const f = await scene(() => stream([content]));
    try {
      const result = await f.terminal(f.start({paths: [siblings[index].rfilename]}));
      assert.equal(result.state, 'failed'); assert.equal(result.errorCode, `research_hf_download_${expected}`);
      assert.equal(result.files.length, 0); assert.equal(result.lastRecordedTransferredBytes, content.length);
      assert.deepEqual(await readdir(f.directory(result)), []);
    } finally {await f.dispose();}
  }
});

test('safe CDN redirects omit signed URLs in receipt and reject foreign hosts, credentials and protocols', async () => {
  let url;
  const f = await scene((_url, _init, f) => {
    url = _url;
    return f.calls.length === 1 ? new Response(null, {status: 302, headers: {location: 'https://cdn-lfs.hf.co/blob?signature=synthetic-private'}})
      : stream([contents[0]]);
  });
  try {
    const result = await f.terminal(f.start({paths: [siblings[0].rfilename]}));
    assert.equal(result.state, 'completed'); assert.match(url, /signature/);
    assert.deepEqual(result.requests.map(request => request.host), ['huggingface.co', 'cdn-lfs.hf.co']);
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
    for (const target of ['http://huggingface.co/a', 'https://huggingface.co.evil.test/a', 'https://evil.test/a',
      'https://user@huggingface.co/a', 'https://cdn-lfs.hf.co:444/a', 'file:///tmp/a']) {
      assert.throws(() => api.requireHuggingFaceDownloadUrl(target), /redirect_rejected/);
    }
  } finally {await f.dispose();}
  const denied = await scene(() => new Response(null, {status: 302, headers: {location: 'https://evil.test/signed'}}));
  try {
    const result = await denied.terminal(denied.start());
    assert.equal(result.errorCode, 'research_hf_download_redirect_rejected'); assert.equal(denied.calls.length, 1);
  } finally {await denied.dispose();}
});

test('redirect depth and HTTP retries are bounded; rejected HTTP response does not transfer body', async () => {
  const redirect = await scene(() => new Response(null, {status: 302, headers: {location: 'https://cdn-lfs.hf.co/loop'}}));
  try {
    const result = await redirect.terminal(redirect.start());
    assert.equal(result.errorCode, 'research_hf_download_redirect_limit'); assert.equal(redirect.calls.length, 6);
  } finally {await redirect.dispose();}
  for (const status of [403, 404, 429, 503]) {
    const f = await scene(() => new Response('untrusted error bytes', {status, headers: {'retry-after': '0'}}));
    try {
      const result = await f.terminal(f.start()); assert.equal(result.errorCode, `research_hf_download_http_${status}`);
      assert.equal(f.calls.length, status === 429 || status === 503 ? 3 : 1);
      assert.equal(result.lastRecordedTransferredBytes, 0);
      assert.equal(result.requests.every(request => request.status === status && request.endedAt !== null), true);
    } finally {await f.dispose();}
  }
});

test('transport failure after partial stream never retries bytes and never includes sensitive error text', async () => {
  const f = await scene(() => new Response(new ReadableStream({
    start(controller) {controller.enqueue(contents[0].subarray(0, 5));},
    pull(controller) {controller.error(new Error('https://signed.test/?synthetic-secret')); }
  })));
  try {
    const result = await f.terminal(f.start());
    assert.equal(result.state, 'failed'); assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.equal(result.requests[0].errorCode, 'research_hf_download_transport_failed');
    assert.deepEqual(await readdir(f.directory(result)), []);
  } finally {await f.dispose();}
});

test('cancel and timeout abort actual stream, retain observed partial progress and isolate project scope', async () => {
  for (const operation of ['cancel', 'timeout', 'shutdown']) {
    let began;
    const ready = new Promise(resolve => {began = resolve;});
    const f = await scene((_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(contents[0].subarray(0, 5)); began();
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {once: true});
      }
    })));
    try {
      const started = f.start({timeoutMs: operation === 'timeout' ? 1000 : 10000});
      await ready; await delay(30);
      const other = f.repository.createProject({title: 'Other', description: 'Synthetic', workspacePath: '/tmp/other'});
      assert.throws(() => f.service.cancel({projectId: other.id, downloadId: started.id}), /not_found/);
      if (operation === 'cancel') assert.equal(f.service.cancel({projectId: f.project.id, downloadId: started.id}).cancelled, true);
      if (operation === 'shutdown') await f.service.shutdown();
      const result = await f.terminal(started);
      assert.equal(result.state, operation === 'cancel' ? 'cancelled' : operation === 'shutdown' ? 'interrupted' : 'failed');
      assert.equal(result.errorCode, `research_hf_download_${operation === 'timeout' ? 'timeout' : operation === 'shutdown' ? 'interrupted' : 'cancelled'}`);
      assert.equal(result.lastRecordedTransferredBytes, 5); assert.equal(result.files.length, 0);
      assert.deepEqual(await readdir(f.directory(result)), []);
    } finally {await f.dispose();}
  }
});

test('cancel before first GET and exact running replay do not dispatch another request', async () => {
  const f = await scene();
  try {
    const started = f.start();
    assert.deepEqual(f.start(), started);
    assert.equal(f.service.cancel({projectId: f.project.id, downloadId: started.id}).cancelled, true);
    const result = await f.terminal(started); assert.equal(result.state, 'cancelled'); assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
});

test('startup marks persisted running receipts interrupted, removes partial and never resumes', async () => {
  const f = await scene();
  try {
    const created = f.human(() => f.downloads.create(f.request).receipt);
    const directory = f.directory(created);
    await import('node:fs/promises').then(fs => fs.mkdir(directory, {recursive: true}));
    await writeFile(join(directory, 'file-0.part'), 'synthetic partial');
    const recovered = new api.HuggingFaceDownloadService(f.downloads, f.observations, f.downloader, f.root);
    await recovered.initialize();
    const result = recovered.read({projectId: f.project.id, downloadId: created.id});
    assert.equal(result.state, 'interrupted'); assert.equal(result.lastRecordedTransferredBytes, 0);
    assert.deepEqual(await readdir(directory), []); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.human(() => recovered.start(f.request)), result); assert.equal(f.calls.length, 0);
    await recovered.shutdown();
  } finally {await f.dispose();}
});

test('physical row, authorization, hash, progress and CAS invariants reject tampering and stale updates', async () => {
  const f = await scene();
  try {
    const created = f.human(() => f.downloads.create(f.request).receipt);
    const updated = f.downloads.update({...created, lastRecordedTransferredBytes: 1});
    assert.throws(() => f.downloads.update(created), /state_conflict/);
    assert.throws(() => f.downloads.update({...updated, lastRecordedTransferredBytes: 0}), /state_conflict/);
    assert.throws(() => f.downloads.update({...updated, actor: {kind: 'user', id: 'forged'}}), /state_conflict/);
    const raw = f.db.prepare('SELECT * FROM research_hf_downloads WHERE id=?').get(created.id);
    const value = JSON.parse(raw.snapshot_json); value.request.requestId = 'swapped';
    const {contentHash: _hash, ...body} = value; value.contentHash = api.resourceContentHash(body);
    f.db.prepare('UPDATE research_hf_downloads SET snapshot_json=? WHERE id=?').run(JSON.stringify(value), created.id);
    assert.throws(() => f.read(created), /snapshot_invalid/);
    f.db.prepare('UPDATE research_hf_downloads SET snapshot_json=? WHERE id=?').run(raw.snapshot_json, created.id);
    f.downloads.recoverInterrupted();
  } finally {await f.dispose();}
});

test('durable download receipts survive SQLite backup/reopen and archived readonly pagination', async () => {
  const f = await scene();
  let restored;
  try {
    const result = await f.terminal(f.start());
    for (let index = 0; index < 3; index++) {
      f.human(() => f.downloads.create({...f.request, requestId: `unstarted-${index}`}));
    }
    f.downloads.recoverInterrupted();
    const first = f.service.history({projectId: f.project.id, observationId: f.observed.id, offset: 0, limit: 2});
    assert.equal(first.total, 4); assert.equal(first.nextOffset, 2);
    assert.equal(f.service.history({projectId: f.project.id, observationId: null, offset: 2, limit: 2}).nextOffset, null);
    assert.throws(() => f.service.history({projectId: 'missing', observationId: null, offset: 0, limit: 2}));
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.start(), result);
    await f.db.backup(join(f.root, 'reopen.sqlite'));
    restored = new Database(join(f.root, 'reopen.sqlite'));
    const observations = new api.HuggingFaceRepository(restored, new api.ResearchRepository(restored, f.tasks));
    const downloads = new api.HuggingFaceDownloadRepository(restored, observations);
    assert.deepEqual(downloads.get(f.project.id, result.id), result);
    assert.deepEqual(downloads.history({projectId: f.project.id, observationId: f.observed.id, offset: 0, limit: 2}), first);
  } finally {restored?.close(); await f.dispose();}
});

test('symlink storage root is rejected and persistence errors remain explicit in read and shutdown', async () => {
  const f = await scene();
  try {
    const target = join(f.root, 'root-link'); await symlink(f.root, target);
    const refused = new api.HuggingFaceDownloadService(f.downloads, f.observations, f.downloader, target);
    await assert.rejects(refused.initialize(), /storage_failed/); assert.equal(f.calls.length, 0);
    f.db.exec(`CREATE TRIGGER reject_download_update BEFORE UPDATE ON research_hf_downloads
      BEGIN SELECT RAISE(ABORT, 'synthetic persistence rejection'); END`);
    const started = f.start(); await delay(100);
    assert.throws(() => f.read(started), /persistence_failed/);
    await assert.rejects(f.service.shutdown(), /persistence_failed/);
    assert.equal(f.calls.length, 0, 'running receipt update must persist before source GET');
    f.db.exec('DROP TRIGGER reject_download_update');
    f.downloads.recoverInterrupted();
    f.service = new api.HuggingFaceDownloadService(f.downloads, f.observations, f.downloader, f.root);
    await f.service.initialize();
  } finally {await f.dispose();}
});

test('shared quota exhaustion prevents GET and archival during transfer prevents file commit', async () => {
  const f = await scene();
  try {
    const policy = new api.LiteratureProviderGovernor({'huggingface.co': {
      minIntervalMs: 0, maxRequests: 0, windowMs: 3600000, failureThreshold: 3, cooldownMs: 60000
    }}, Date.now, async () => {});
    const service = new api.HuggingFaceDownloadService(f.downloads, f.observations,
      new api.HuggingFaceDownloader(policy, () => {assert.fail('exhausted governor dispatched GET');}), f.root);
    await service.initialize();
    const started = f.human(() => service.start(f.request));
    for (let tries = 0; service.read({projectId: f.project.id, downloadId: started.id}).state === 'running' && tries < 200; tries++) await delay(10);
    assert.equal(service.read({projectId: f.project.id, downloadId: started.id}).errorCode, 'literature_provider_quota_exhausted');
    await service.shutdown(); assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
  const archived = await scene((_url, _init, f) => {
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    return stream([contents[0]]);
  });
  try {
    const result = await archived.terminal(archived.start());
    assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'research_project_archived');
    assert.equal(result.files.length, 0); assert.equal(result.lastRecordedTransferredBytes, contents[0].length);
    assert.deepEqual(await readdir(archived.directory(result)), []);
  } finally {await archived.dispose();}
});

test('progress checkpoints preserve request status and observed byte counts across parsed receipt copies', async () => {
  const content = Buffer.alloc(2 * 1024 * 1024 + 32, 7);
  const file = {rfilename: 'data/large.bin', size: content.length, blobId: 'b'.repeat(40),
    lfs: {size: content.length, sha256: sha(content), pointerSize: 126}};
  const f = await scene(() => stream([content.subarray(0, 1024 * 1024), content.subarray(1024 * 1024)]), {siblings: [file]});
  try {
    const result = await f.terminal(f.start({paths: [file.rfilename], maxBytes: content.length}));
    assert.equal(result.state, 'completed'); assert.equal(result.verifiedBytes, content.length);
    assert.equal(result.requests[0].status, 200); assert.ok(result.requests[0].endedAt);
    assert.ok(result.revision >= 7); assert.equal(result.lastRecordedTransferredBytes, content.length);
    assert.equal(result.files[0].sha256, sha(content));
  } finally {await f.dispose();}
});

test('download authorization insertion drift rolls back and requires a fresh observed source', async () => {
  const f = await scene();
  try {
    f.db.exec(`CREATE TRIGGER mutate_hf_observation AFTER INSERT ON research_hf_downloads BEGIN
      UPDATE research_hf_observations SET snapshot_json='{}' WHERE id=NEW.observation_id; END`);
    assert.throws(() => f.start());
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_hf_downloads').pluck().get(), 0);
    assert.equal(f.observations.get(f.project.id, f.observed.id).contentHash, f.observed.contentHash);
    assert.equal(f.calls.length, 0); f.db.exec('DROP TRIGGER mutate_hf_observation');
  } finally {await f.dispose();}
});
