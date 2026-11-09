import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, symlink, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {zenodoProviderFixture} from '../fixtures/zenodo-provider.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const token = 'task-created-zenodo-fixture-token';
const metadata = {upload_type: 'publication', publication_type: 'preprint', title: 'Synthetic publication',
  description: 'Task-created isolated engineering fixture.', publication_date: '2026-11-06', access_right: 'open',
  license: 'cc-by-4.0', creators: [{name: 'Synthetic Author'}], version: 'fixture-1'};
const signal = () => new AbortController().signal;
const tick = () => new Promise(resolve => setImmediate(resolve));

function governor() {
  let clock = Date.now();
  return new api.LiteratureProviderGovernor({
    'sandbox.zenodo.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1},
    'zenodo.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1}
  }, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
}
async function scene() {
  const f = createResearchFixture(api, 'reading');
  f.bytes = Buffer.from('bytes'); f.source = 'original';
  f.export = {id: 'export', projectId: f.project.id, approval: 'approved'};
  f.repository.exports.get = (projectId, id) => {
    assert.equal(projectId, f.project.id); assert.equal(id, 'export'); return f.export;
  };
  f.preparations = new api.ZenodoPreparationService(f.db, f.repository, {async publicationInputs(request, cancellation) {
    cancellation?.throwIfAborted();
    if (f.localFailure) throw new Error(f.localFailure);
    const body = api.zenodoInputsSchema.omit({contentHash: true}).parse({projectId: request.projectId,
      exportId: 'export', artifactId: 'artifact', exportHash: hash(JSON.stringify(f.export)), sourceHash: hash(f.source),
      files: request.files.map(file => ({...file, sha256: hash(f.bytes), md5: hash(f.bytes, 'md5'), size: f.bytes.length}))});
    return api.sealZenodo(body);
  }});
  f.human = (capability, run) => api.withResearchHumanContext({capability: `research.zenodo.${capability}`,
    projectId: f.project.id, windowId: 11}, run);
  const selection = {projectId: f.project.id, exportId: 'export',
    files: [{area: 'archive', path: 'paper.zip', name: 'paper.zip'}]};
  const prepare = {...selection, requestId: 'prepare', expectedInputsHash: (await f.preparations.inputs(selection)).contentHash,
    environment: 'sandbox', metadata, review: {privacy: true, fileLicenses: true, authors: true}};
  f.prepared = await f.human('prepare', () => f.preparations.prepare(prepare));
  f.secretValues = new Map([['zenodo-sandbox', token]]);
  f.secrets = {get: async key => f.secretValues.get(key) ?? null,
    set: async (key, value) => {f.secretValues.set(key, value);}, clear: key => {f.secretValues.delete(key);}};
  f.provider = zenodoProviderFixture(token);
  f.transport = new api.ZenodoTransport(f.secrets, f.provider.fetch, governor());
  f.operations = new api.ZenodoOperationRepository(f.db, f.repository, f.preparations);
  f.upload = async (preparation, name, cancellation, send) => {
    cancellation.throwIfAborted();
    return send(new ReadableStream({start(controller) {controller.enqueue(f.bytes); controller.close();}}), f.bytes.length);
  };
  f.service = new api.ZenodoPublicationService(f.repository, f.preparations, f.operations, f.transport, f.secrets,
    (...args) => f.upload(...args));
  f.startRequest = {projectId: f.project.id, preparationId: f.prepared.id, requestId: 'start',
    expectedPreparationHash: f.prepared.contentHash};
  f.start = () => f.human('start', () => f.service.start(f.startRequest));
  f.read = operation => ({projectId: f.project.id, operationId: operation.id});
  f.action = operation => ({...f.read(operation), expectedRevision: operation.revision});
  f.approveRequest = operation => ({...f.action(operation), requestId: 'approve',
    expectedRemoteHash: operation.remote.contentHash, expectedPreparationHash: f.prepared.contentHash, confirmPublic: true});
  f.approve = operation => f.human('approvePublication', () => f.service.approve(f.approveRequest(operation)));
  f.publish = (operation, approval) => f.human('publish', () => f.service.publish({...f.action(operation), approvalId: approval.id}));
  f.dispose = async () => {await f.service.shutdown(); f.close();};
  return f;
}

test('main sender, strict wire, scoped secret facade and separate sandbox credentials', async () => {
  const f = await scene();
  try {
    await assert.rejects(f.service.start(f.startRequest), /human_required/);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.zenodo.start', projectId: 'foreign', windowId: 11},
      () => f.service.start(f.startRequest)), /human_project_mismatch/);
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchZenodoPublicationCapabilities) registry.declare('fixture', descriptor);
    api.registerResearchZenodoPublicationCapabilities({pluginId: 'fixture', capabilities: registry}, f.service, f.operations);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    assert.equal((await adapter.invoke('research.startZenodoOperation', [f.startRequest], 0)).ok, false);
    for (const invalid of [{...f.startRequest, actor: {kind: 'user', id: 'forged'}}, {...f.startRequest, token}]) {
      assert.throws(() => api.parseIpcRequestArgs('roc:research:zenodo-start', [invalid]));
    }
    assert.deepEqual(await f.service.credentialStatus({projectId: f.project.id, environment: 'production'}), {stored: false});
    const credential = {projectId: f.project.id, environment: 'production', plaintext: token};
    await assert.rejects(f.service.saveCredential(credential), /human_required/);
    assert.deepEqual((await adapter.invoke('research.saveZenodoCredential', [credential], 11)).data, {stored: true});
    assert.deepEqual((await adapter.invoke('research.clearZenodoCredential', [{
      projectId: f.project.id, environment: 'production'
    }], 11)).data, {stored: false});
    const started = await adapter.invoke('research.startZenodoOperation', [f.startRequest], 11);
    assert.equal(started.ok, true); assert.equal(started.data.status, 'ready'); assert.equal(started.data.actor.id, 'window:11');
    assert.equal(JSON.stringify(started.data).includes(token), false);
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 0);
  } finally {await f.dispose();}
});

test('durable operation precedes POST; exact/concurrent retry and changed requests cannot create another record', async () => {
  const f = await scene();
  try {
    f.provider.override = async (url, init, respond) => {
      if (init.method === 'POST') assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_operations').pluck().get(), 1);
      return respond();
    };
    const [first, second] = await Promise.all([f.start(), f.start()]);
    assert.equal(first.id, second.id); assert.equal(f.provider.records.size, 1); assert.equal(f.provider.uploads.length, 1);
    const ready = f.operations.get(f.project.id, first.id), count = f.provider.calls.length;
    assert.deepEqual(await f.start(), ready); assert.equal(f.provider.calls.length, count);
    await assert.rejects(f.human('start', () => f.service.start({...f.startRequest, requestId: 'another'})), /request_conflict/);
    await assert.rejects(f.human('start', () => f.service.start({...f.startRequest, expectedPreparationHash: hash('changed')})),
      /request_conflict/);
  } finally {await f.dispose();}
});

test('unknown create never resends; complete unique marker query binds ID and explicit resume uploads', async () => {
  const f = await scene();
  try {
    f.provider.override = async (url, init, respond) => {
      const response = await respond();
      if (init.method === 'POST') throw new Error('lost create reply');
      return response;
    };
    const unknown = await f.start();
    assert.equal(unknown.status, 'create_unknown'); assert.equal(unknown.remoteId, null);
    assert.equal((await f.start()).id, unknown.id); assert.equal(f.provider.records.size, 1);
    f.provider.override = null;
    const draft = await f.service.refresh(f.read(unknown));
    assert.equal(draft.status, 'draft'); assert.ok(draft.remoteId); assert.equal(f.provider.uploads.length, 0);
    const ready = await f.human('resume', () => f.service.resume(f.action(draft)));
    assert.equal(ready.status, 'ready'); assert.equal(f.provider.records.size, 1); assert.equal(f.provider.uploads.length, 1);
  } finally {await f.dispose();}
});

test('incomplete, zero and multiple marker matches remain unresolved without create or upload retries', async () => {
  const f = await scene();
  try {
    f.provider.override = async () => {throw new Error('lost create');};
    const unknown = await f.start(), initial = f.provider.calls.length;
    f.provider.override = async () => Response.json([]);
    assert.equal((await f.service.refresh(f.read(unknown))).error, 'research_zenodo_create_unresolved');
    const raw = {id: 42, owner: 77, modified: '2026-11-06T00:00:00+00:00', state: 'inprogress', submitted: false,
      metadata: {...metadata, related_identifiers: [{identifier: unknown.marker, relation: 'isAlternateIdentifier'}]}, files: []};
    f.provider.override = async () => Response.json([raw, {...raw, id: 43}]);
    assert.equal((await f.service.refresh(f.read(unknown))).remoteId, null);
    let pages = 0;
    f.provider.override = async () => {pages++; return Response.json(Array.from({length: 100},
      (_, index) => ({...raw, id: index + 1, metadata})));};
    const unresolved = await f.service.refresh(f.read(unknown));
    assert.equal(pages, 10); assert.equal(unresolved.status, 'create_unknown'); assert.equal(unresolved.remoteId, null);
    assert.equal(f.provider.calls.slice(initial).every(call => call.method === 'GET'), true);
  } finally {await f.dispose();}
});

test('unknown PUT queries before resume; uploaded matching bytes are not sent again', async () => {
  const f = await scene();
  try {
    f.provider.override = async (url, init, respond) => {
      const response = await respond();
      if (init.method === 'PUT') throw new Error('lost upload reply');
      return response;
    };
    const unknown = await f.start();
    assert.equal(unknown.status, 'upload_unknown'); assert.equal(f.provider.uploads.length, 1);
    f.provider.override = null;
    const ready = await f.human('resume', () => f.service.resume(f.action(unknown)));
    assert.equal(ready.status, 'ready'); assert.equal(f.provider.uploads.length, 1);
    assert.equal(f.provider.calls.filter(call => call.method === 'PUT').length, 1);
  } finally {await f.dispose();}
});

test('staging failure and late upload checksum failure persist the latest operation revision and exact cause', async () => {
  const f = await scene();
  try {
    f.upload = async () => {throw new Error('research_zenodo_file_changed');};
    const failed = await f.start();
    assert.equal(failed.status, 'draft'); assert.equal(failed.error, 'research_zenodo_file_changed');
    assert.deepEqual(f.operations.get(f.project.id, failed.id), failed); assert.equal(f.provider.uploads.length, 0);
    f.upload = async (preparation, name, cancellation, send) => send(new ReadableStream({
      start(controller) {controller.enqueue(f.bytes); controller.close();}
    }), f.bytes.length);
    f.provider.override = async (url, init, respond) => init.method === 'PUT' ?
      (await respond(), Response.json({key: 'paper.zip', size: 5, checksum: `md5:${'0'.repeat(32)}`})) : respond();
    const mismatch = await f.human('resume', () => f.service.resume(f.action(failed)));
    assert.equal(mismatch.status, 'upload_unknown'); assert.equal(mismatch.error, 'research_zenodo_upload_checksum_changed');
    assert.ok(mismatch.revision > failed.revision);
  } finally {await f.dispose();}
});

test('remote metadata and file drift stay reviewable; wrong ID owner and marker cannot replace the bound snapshot', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), raw = f.provider.records.get(ready.remoteId);
    raw.metadata.title = 'Changed remote title'; f.provider.touch(raw);
    const changed = await f.service.refresh(f.read(ready));
    assert.equal(changed.status, 'draft'); assert.equal(changed.error, 'research_zenodo_remote_metadata_changed');
    assert.equal(changed.remote.metadata.title, raw.metadata.title);
    await assert.rejects(f.approve(changed), /publication_review_changed/);
    raw.metadata.title = metadata.title; raw.files[0].checksum = '0'.repeat(32); f.provider.touch(raw);
    const files = await f.service.refresh(f.read(ready));
    assert.equal(files.status, 'draft'); assert.equal(files.error, 'research_zenodo_remote_files_changed');
    for (const patch of [{id: raw.id + 1}, {owner: 999}, {metadata: {...raw.metadata, related_identifiers: []}}]) {
      f.provider.override = async () => Response.json({...raw, ...patch});
      const rejected = await f.service.refresh(f.read(ready));
      assert.equal(rejected.error, 'research_zenodo_remote_identity_changed');
      assert.equal(rejected.remote.contentHash, files.remote.contentHash);
    }
  } finally {await f.dispose();}
});

test('final approval is a distinct immutable receipt; exact retry after operation revision advances cannot grant anew', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), request = f.approveRequest(ready), count = f.provider.calls.length;
    await assert.rejects(f.service.approve(request), /human_required/);
    const approval = await f.approve(ready), approved = f.operations.get(f.project.id, ready.id);
    assert.equal(approval.actor.id, 'window:11'); assert.equal(approved.approval.id, approval.id);
    assert.equal(approved.revision, ready.revision + 1); assert.equal(f.provider.calls.length, count + 1);
    const after = f.provider.calls.length;
    assert.deepEqual(await f.human('approvePublication', () => f.service.approve(request)), approval);
    assert.equal(f.provider.calls.length, after);
    await assert.rejects(f.human('approvePublication', () => f.service.approve({...request, expectedRemoteHash: hash('other')})),
      /request_conflict/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_publication_approvals').pluck().get(), 1);
    await assert.rejects(f.publish(approved, {id: 'absent'}), /approval_required/);
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 0);
  } finally {await f.dispose();}
});

test('publish requires unchanged source and refreshed remote review; changed local or remote identities send zero publish requests', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), approval = await f.approve(ready), approved = f.operations.get(f.project.id, ready.id);
    f.source = 'changed';
    const stale = await f.publish(approved, approval);
    assert.equal(stale.error, 'research_zenodo_inputs_changed');
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 0);
    f.source = 'original';
    const raw = f.provider.records.get(ready.remoteId);
    raw.metadata.version = 'fixture-2'; f.provider.touch(raw);
    const remoteChanged = await f.publish(stale, approval);
    assert.equal(remoteChanged.remote.metadata.version, 'fixture-2');
    assert.equal(remoteChanged.status, 'draft'); assert.equal(remoteChanged.error, 'research_zenodo_publication_review_changed');
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 0);
  } finally {await f.dispose();}
});

test('accepted publish is queried; unknown publish and duplicate grant never POST again, completed receipt records DOI and version', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), approval = await f.approve(ready), approved = f.operations.get(f.project.id, ready.id);
    f.provider.override = async (url, init, respond) => {
      if (url.pathname.endsWith('/actions/publish')) {
        assert.equal(f.operations.get(f.project.id, ready.id).status, 'publish_requested');
        return Response.json(f.provider.records.get(ready.remoteId), {status: 202});
      }
      return respond();
    };
    const accepted = await f.publish(approved, approval);
    assert.equal(accepted.status, 'publish_unknown');
    assert.equal((await f.publish(approved, approval)).status, 'publish_unknown');
    const raw = f.provider.records.get(ready.remoteId);
    raw.state = 'done'; raw.submitted = true; f.provider.touch(raw);
    const incomplete = await f.service.refresh(f.read(ready));
    assert.equal(incomplete.status, 'publish_unknown'); assert.equal(incomplete.error, 'research_zenodo_publication_receipt_incomplete');
    raw.doi = `10.5072/zenodo.${raw.id}`; raw.record_id = raw.id; raw.record_url = `https://sandbox.zenodo.org/records/${raw.id}`;
    const published = await f.service.refresh(f.read(ready));
    assert.equal(published.status, 'published'); assert.equal(published.remote.doi, raw.doi);
    assert.equal(published.remote.metadata.version, metadata.version);
    assert.equal((await f.publish(published, approval)).status, 'published');
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 1);
  } finally {await f.dispose();}
});

test('lost publish response retains requested identity; refresh reports actual published state without local rollback', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), approval = await f.approve(ready), approved = f.operations.get(f.project.id, ready.id);
    f.provider.override = async (url, init, respond) => {
      const response = await respond();
      if (url.pathname.endsWith('/actions/publish')) throw new Error('lost publish reply');
      return response;
    };
    const unknown = await f.publish(approved, approval);
    assert.equal(unknown.status, 'publish_unknown');
    f.provider.override = null;
    const published = await f.service.refresh(f.read(unknown));
    assert.equal(published.status, 'published'); assert.ok(published.remote.doi);
    assert.equal((await f.publish(approved, approval)).status, 'published');
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 1);
  } finally {await f.dispose();}
});

test('archive/read ownership, cancellation and restart preserve uncertain operations without automatic provider work', async () => {
  const f = await scene();
  try {
    let started;
    const entered = new Promise(resolve => {started = resolve;});
    f.provider.override = async (url, init) => {started(); await new Promise(resolve =>
      init.signal.addEventListener('abort', resolve, {once: true})); init.signal.throwIfAborted();};
    const pending = f.start(); await entered;
    const row = f.db.prepare('SELECT id FROM research_zenodo_operations').get();
    await assert.rejects(f.service.refresh({projectId: f.project.id, operationId: row.id}), /operation_busy/);
    f.human('cancel', () => f.service.cancel({projectId: f.project.id, operationId: row.id}));
    const cancelled = await pending;
    assert.equal(cancelled.status, 'create_unknown'); assert.equal(cancelled.error, 'research_zenodo_cancelled');
    const count = f.provider.calls.length;
    const creating = f.operations.update(cancelled, {status: 'creating'});
    f.service.recover();
    assert.equal(f.operations.get(f.project.id, creating.id).status, 'create_unknown');
    assert.equal(f.provider.calls.length, count);
    assert.throws(() => f.service.get({projectId: 'foreign', operationId: creating.id}), /project_not_found/);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.equal(f.service.get(f.read(creating)).id, creating.id);
    await assert.rejects(f.start(), /project_archived/);
  } finally {await f.dispose();}
});

test('physical and nested receipt corruption rejects readback; approval insert failure rolls back the operation revision', async () => {
  const f = await scene();
  try {
    const ready = await f.start();
    const original = f.db.prepare('SELECT * FROM research_zenodo_operations WHERE id=?').get(ready.id);
    for (const changed of [
      {...ready, createdAt: '2026-11-05T00:00:00.000Z'},
      {...ready, environment: 'production'},
      {...ready, remote: {...ready.remote, files: []}},
      {...ready, request: {...ready.request, expectedPreparationHash: hash('other')}}
    ]) {
      const {contentHash, ...body} = changed;
      f.db.prepare('UPDATE research_zenodo_operations SET snapshot_json=? WHERE id=?')
        .run(JSON.stringify(api.sealZenodo(body)), ready.id);
      assert.throws(() => f.operations.get(f.project.id, ready.id), /operation_invalid/);
    }
    f.db.prepare('UPDATE research_zenodo_operations SET snapshot_json=? WHERE id=?').run(original.snapshot_json, ready.id);
    f.db.exec(`CREATE TRIGGER approval_corrupt AFTER INSERT ON research_zenodo_publication_approvals
      BEGIN UPDATE research_zenodo_publication_approvals SET created_at='2026-11-01T00:00:00.000Z' WHERE id=NEW.id; END;`);
    await assert.rejects(f.approve(ready), /approval_invalid/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_publication_approvals').pluck().get(), 0);
    assert.deepEqual(f.operations.get(f.project.id, ready.id), ready);
  } finally {await f.dispose();}
});

test('transport rejects redirects token query credential echoes invalid buckets and oversized or stalled responses', async () => {
  const secrets = {get: async () => token}, calls = [];
  let response = Response.json({ok: true});
  const transport = new api.ZenodoTransport(secrets, async (url, init) => {calls.push({url, init}); return response;}, governor());
  await assert.rejects(transport.request('sandbox', `deposit/depositions?access_token=${token}`, 'GET', 200, signal()),
    /endpoint_invalid/);
  assert.equal(calls.length, 0);
  for (const value of ['https://zenodo.org/api/files/00000000-0000-4000-8000-000000000001',
    'https://sandbox.zenodo.org/api/files/00000000-0000-4000-8000-000000000001?token=x',
    'https://user:password@sandbox.zenodo.org/api/files/00000000-0000-4000-8000-000000000001',
    'https://sandbox.zenodo.org/api/files/------------------------------------']) assert.throws(() => api.zenodoBucket(value, 'sandbox'));
  response = Response.json({description: token});
  await assert.rejects(transport.request('sandbox', 'deposit/depositions', 'GET', 200, signal()), /response_invalid/);
  response = new Response('provider secret body', {status: 302, headers: {location: 'https://foreign.invalid'}});
  await assert.rejects(transport.request('sandbox', 'deposit/depositions', 'GET', 200, signal()),
    error => error.code === 'research_zenodo_http_302' && !error.message.includes('provider secret body'));
  response = new Response(new Uint8Array(4 * 1024 * 1024 + 1));
  await assert.rejects(transport.request('sandbox', 'deposit/depositions', 'GET', 200, signal()), /response_limit/);
  let cancelled = false;
  response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
  const controller = new AbortController();
  const pending = transport.request('sandbox', 'deposit/depositions', 'GET', 200, controller.signal);
  await tick(); controller.abort();
  await assert.rejects(pending, /transport_unknown/);
  assert.equal(cancelled, true);
});

test('429 cooldown and bounded admission send no automatic retry and report safe HTTP error codes', async () => {
  let calls = 0, now = Date.now();
  const policy = new api.LiteratureProviderGovernor({'sandbox.zenodo.org': {
    minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 3, cooldownMs: 60000
  }}, () => now, async (ms, signal) => {signal.throwIfAborted(); now += ms;});
  const transport = new api.ZenodoTransport({get: async () => token}, async () => {
    calls++; return new Response('private provider body', {status: 429, headers: {'retry-after': '120'}});
  }, policy);
  await assert.rejects(transport.request('sandbox', 'deposit/depositions', 'GET', 200, signal()), /http_429/);
  assert.equal(calls, 1);
  await tick(); assert.equal(calls, 1);
  const before = now;
  await assert.rejects(transport.request('sandbox', 'deposit/depositions', 'GET', 200, signal()), /http_429/);
  assert.ok(now - before >= 120000);
  assert.equal(calls, 2);
  const capped = new api.LiteratureProviderGovernor({'sandbox.zenodo.org': {
    minIntervalMs: 1, maxRequests: 1, windowMs: 3600000, failureThreshold: 3, cooldownMs: 60000
  }}, () => now, async (ms, signal) => {signal.throwIfAborted(); now += ms;});
  const limited = new api.ZenodoTransport({get: async () => token}, async () => {calls++; return Response.json({ok: true});}, capped);
  await limited.request('sandbox', 'deposit/depositions', 'GET', 200, signal());
  await assert.rejects(limited.request('sandbox', 'deposit/depositions', 'GET', 200, signal()), /quota_exhausted/);
  assert.equal(calls, 3);
});

test('real multi-block staging sends only complete verified unlinked bytes and removes owned temporary directories', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-zenodo-stage-test-')));
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 41);
    await writeFile(join(root, 'paper.zip'), bytes);
    const file = {area: 'archive', path: 'paper.zip', name: 'paper.zip',
      sha256: hash(bytes), md5: hash(bytes, 'md5'), size: bytes.length};
    const before = (await readdir(tmpdir())).filter(value => value.startsWith('roc-zenodo-upload-'));
    let checked = false, sent = 0;
    const result = await api.uploadZenodoFile(root, file, signal(), async () => {
      checked = true;
      // The source may change after the completed copy; the upload must still send the sealed bytes.
      await writeFile(join(root, file.path), Buffer.alloc(bytes.length, 99));
    }, async (stream, size) => {
      sent++; assert.equal(checked, true); assert.equal(size, bytes.length);
      const received = Buffer.from(await new Response(stream).arrayBuffer());
      assert.deepEqual(received, bytes); return {uploaded: true};
    });
    assert.deepEqual(result, {uploaded: true}); assert.equal(sent, 1);
    await assert.rejects(api.uploadZenodoFile(root, file, signal(), async () => {}, async () => {sent++;}), /file_changed/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.uploadZenodoFile(root, file, controller.signal, async () => {}, async () => {sent++;}));
    await symlink(join(root, 'paper.zip'), join(root, 'link.zip'));
    await assert.rejects(api.uploadZenodoFile(root, {...file, path: 'link.zip'}, signal(), async () => {}, async () => {sent++;}));
    assert.equal(sent, 1);
    assert.deepEqual((await readdir(tmpdir())).filter(value => value.startsWith('roc-zenodo-upload-')), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('missing or failed secret storage exposes only a safe failure and creates no durable remote operation', async () => {
  const f = await scene();
  try {
    f.secretValues.clear();
    await assert.rejects(f.start(), /credential_required/);
    assert.equal(f.provider.calls.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_operations').pluck().get(), 0);
    f.secrets.set = async () => {throw new Error(token);};
    await assert.rejects(f.human('saveCredential', () => f.service.saveCredential({
      projectId: f.project.id, environment: 'sandbox', plaintext: token
    })), error => error.message === 'research_zenodo_credential_storage_failed' && !error.message.includes(token));
  } finally {await f.dispose();}
});

test('source changes during remote final review prevent both a new human grant and a publish POST', async () => {
  const f = await scene();
  try {
    const ready = await f.start();
    f.provider.override = async (url, init, respond) => {
      const response = await respond();
      if (init.method === 'GET') f.source = 'changed during remote review';
      return response;
    };
    await assert.rejects(f.approve(ready), /inputs_changed/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_publication_approvals').pluck().get(), 0);
    f.source = 'original'; f.provider.override = null;
    const approval = await f.approve(ready), approved = f.operations.get(f.project.id, ready.id);
    f.provider.override = async (url, init, respond) => {
      const response = await respond();
      if (init.method === 'GET') f.source = 'changed before publish';
      return response;
    };
    const refused = await f.publish(approved, approval);
    assert.equal(refused.error, 'research_zenodo_inputs_changed');
    assert.equal(f.provider.calls.filter(call => call.pathname.endsWith('/actions/publish')).length, 0);
  } finally {await f.dispose();}
});

test('shutdown cancels a stalled response and preserves a durable unknown create without publishing work', async () => {
  const f = await scene();
  try {
    let entered;
    const started = new Promise(resolve => {entered = resolve;});
    let cancelled = false;
    f.provider.override = async () => {
      entered();
      return new Response(new ReadableStream({cancel() {cancelled = true;}}), {status: 201});
    };
    const pending = f.start(); await started; await tick();
    await f.service.shutdown();
    const unknown = await pending;
    assert.equal(unknown.status, 'create_unknown'); assert.equal(unknown.error, 'research_zenodo_cancelled');
    assert.equal(cancelled, true); assert.equal(f.provider.calls.length, 1);
    await assert.rejects(f.start(), /zenodo_closed/);
  } finally {await f.dispose();}
});

test('history pages and approvals remain scoped after archive and damaged grants cannot authorize publishing', async () => {
  const f = await scene();
  try {
    const ready = await f.start(), approval = await f.approve(ready);
    const row = f.db.prepare('SELECT * FROM research_zenodo_publication_approvals WHERE id=?').get(approval.id);
    const {contentHash, ...body} = approval;
    const corrupted = api.sealZenodo({...body, request: {...body.request, operationId: 'different-operation'}});
    f.db.prepare('UPDATE research_zenodo_publication_approvals SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify(corrupted), approval.id);
    assert.throws(() => f.operations.get(f.project.id, ready.id), /approval_invalid/);
    f.db.prepare('UPDATE research_zenodo_publication_approvals SET snapshot_json=? WHERE id=?').run(row.snapshot_json, approval.id);
    const secondProject = f.repository.createProject({title: 'Foreign project', description: '', workspacePath: '/tmp/foreign-zenodo'});
    assert.throws(() => f.operations.get(secondProject.id, ready.id), /project_mismatch/);
    assert.deepEqual(f.operations.list({projectId: secondProject.id, limit: 20, offset: 0}).records, []);
    assert.throws(() => f.operations.list({projectId: f.project.id, limit: 21, offset: 0}));
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.equal(f.operations.list({projectId: f.project.id, limit: 20, offset: 0}).records[0].approval.id, approval.id);
  } finally {await f.dispose();}
});

test('preparation lookup reads the exact existing scoped operation without network work or new request identity', async () => {
  const f = await scene();
  try {
    assert.equal(f.operations.forPreparation(f.project.id, f.prepared.id), null);
    const operation = await f.start(), count = f.provider.calls.length;
    assert.deepEqual(f.operations.forPreparation(f.project.id, f.prepared.id), operation);
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchZenodoPublicationCapabilities) registry.declare('fixture', descriptor);
    api.registerResearchZenodoPublicationCapabilities({pluginId: 'fixture', capabilities: registry}, f.service, f.operations);
    const input = {projectId: f.project.id, preparationId: f.prepared.id};
    assert.deepEqual(await registry.invoke('research.zenodo.operationForPreparation', input), operation);
    assert.throws(() => f.operations.forPreparation('foreign', f.prepared.id));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:zenodo-operationForPreparation', [{...input, actor: {kind: 'user', id: 'forged'}}]));
    f.repository.updateProject({id: f.project.id, status: 'archived'});
    assert.deepEqual(f.operations.forPreparation(f.project.id, f.prepared.id), operation);
    assert.equal(f.provider.calls.length, count);
  } finally {await f.dispose();}
});
