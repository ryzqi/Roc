import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const metadata = {upload_type: 'publication', publication_type: 'preprint', title: 'Synthetic publication',
  description: 'Task-created engineering fixture.', publication_date: '2026-11-06', access_right: 'open',
  license: 'cc-by-4.0', creators: [{name: 'Synthetic Author'}], version: 'fixture-1'};

function scene() {
  const f = createResearchFixture(api, 'reading');
  f.record = {id: 'export', projectId: f.project.id, approval: 'approved'};
  f.repository.exports.get = (project, id) => {
    assert.equal(project, f.project.id); assert.equal(id, 'export'); return f.record;
  };
  f.calls = 0;
  f.consumer = {async publicationInputs(request) {
    api.zenodoInputsRequestSchema.parse(request); f.calls++;
    if (f.pause) await f.pause;
    if (f.failure) throw new Error(f.failure);
    return api.sealZenodo({projectId: request.projectId, exportId: request.exportId, artifactId: 'artifact',
      exportHash: hash(JSON.stringify(f.record)), sourceHash: hash('sources'),
      files: request.files.map(file => ({...file, sha256: hash(f.bytes ?? 'bytes'), md5: hash(f.bytes ?? 'bytes', 'md5'), size: 5}))});
  }};
  f.service = new api.ZenodoPreparationService(f.db, f.repository, f.consumer);
  f.selection = {projectId: f.project.id, exportId: 'export', files: [{area: 'archive', path: 'export.zip', name: 'paper.zip'}]};
  f.request = async (overrides = {}) => ({...f.selection, requestId: 'prepare',
    expectedInputsHash: (await f.service.inputs(f.selection)).contentHash, environment: 'sandbox',
    metadata, review: {privacy: true, fileLicenses: true, authors: true}, ...overrides});
  f.prepare = input => api.withResearchHumanContext({capability: 'research.zenodo.prepare',
    projectId: f.project.id, windowId: 12}, () => f.service.prepare(input));
  f.count = () => f.db.prepare('SELECT count(*) FROM research_zenodo_preparations').pluck().get();
  return f;
}

test('main sender alone authorizes preparation and strict IPC rejects self-awarded review or duplicate sources', async () => {
  const f = scene();
  try {
    const request = await f.request();
    await assert.rejects(f.service.prepare(request), /research_human_required/);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.monitors.save', projectId: f.project.id,
      windowId: 12}, () => f.service.prepare(request)), /research_human_required/);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.zenodo.prepare', projectId: 'foreign',
      windowId: 12}, () => f.service.prepare(request)), /research_human_project_mismatch/);
    const registry = new api.CapabilityRegistry();
    for (const capability of api.researchZenodoCapabilities) registry.declare('fixture', capability);
    api.registerResearchZenodoCapabilities({pluginId: 'fixture', capabilities: registry}, f.service);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    assert.equal((await adapter.invoke('research.prepareZenodo', [request], 0)).ok, false);
    for (const invalid of [
      {...request, actor: {kind: 'user', id: 'forged'}},
      {...request, review: {...request.review, privacy: false}},
      {...request, files: [...request.files, {...request.files[0], name: 'other.zip'}]},
      {...request, files: [...request.files, {area: 'bundle', path: 'paper.pdf', name: 'PAPER.ZIP'}]},
      {...request, metadata: {...metadata, access_right: 'restricted'}},
      {...request, metadata: {...metadata, description: 'Read /Users/private/paper.pdf'}},
      {...request, metadata: {...metadata, token: 'fixture-secret'}}
    ]) assert.throws(() => api.parseIpcRequestArgs('roc:research:zenodo-prepare', [invalid]));
    assert.equal(f.count(), 0);
    const result = await adapter.invoke('research.prepareZenodo', [request], 12);
    assert.equal(result.ok, true); assert.equal(result.data.actor.id, 'window:12');
    const replay = await adapter.invoke('research.prepareZenodo', [request], 13);
    assert.deepEqual(replay.data, result.data); assert.equal(f.count(), 1);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  } finally {f.close();}
});

test('exact and concurrent replay produce one receipt; changed request conflicts without recapture', async () => {
  const f = scene();
  try {
    const request = await f.request();
    const [a, b] = await Promise.all([f.prepare(request), f.prepare(request)]);
    assert.deepEqual(a, b); assert.equal(f.count(), 1);
    const calls = f.calls; f.failure = 'source unavailable';
    assert.deepEqual(await f.prepare(request), a); assert.equal(f.calls, calls);
    await assert.rejects(f.prepare({...request, metadata: {...metadata, version: 'changed'}}), /request_conflict/);
    assert.equal(f.count(), 1);
  } finally {f.close();}
});

test('changed source, approval, and asynchronous archive changes fail before a preparation is stored', async () => {
  const f = scene();
  try {
    const request = await f.request();
    f.bytes = 'changed';
    await assert.rejects(f.prepare(request), /inputs_changed/); assert.equal(f.count(), 0);
    delete f.bytes;
    f.failure = 'research_export_approval_required';
    await assert.rejects(f.prepare(request), /approval_required/); assert.equal(f.count(), 0);
    delete f.failure;
    const original = f.consumer.publicationInputs;
    f.consumer.publicationInputs = async request => {
      const input = await original(request); f.record = {...f.record, approval: 'draft'}; return input;
    };
    await assert.rejects(f.prepare(request), /inputs_changed/); assert.equal(f.count(), 0);
  } finally {f.close();}
});

test('archive during capture denies persistence and historical reads stay project scoped', async () => {
  const f = scene();
  try {
    const request = await f.request(), saved = await f.prepare(request);
    const other = f.repository.createProject({title: 'Other', description: 'Synthetic', workspacePath: '/tmp/other'});
    assert.throws(() => f.service.get(other.id, saved.id), /project_mismatch/);
    assert.equal(f.service.list({projectId: other.id, offset: 0, limit: 20}).total, 0);
    let resume;
    f.pause = new Promise(resolve => {resume = resolve;});
    const pending = f.prepare({...request, requestId: 'archived'});
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    resume();
    await assert.rejects(pending, /project_archived/); assert.equal(f.count(), 1);
    assert.deepEqual(f.service.get(f.project.id, saved.id), saved);
    await assert.rejects(f.service.assertCurrent(saved), /project_archived/);
  } finally {f.close();}
});

test('bounded history pages contain every immutable receipt once and enforce page limits', async () => {
  const f = scene();
  try {
    const request = await f.request();
    for (let n = 0; n < 23; n++) await f.prepare({...request, requestId: `prepare-${n}`});
    const first = f.service.list({projectId: f.project.id, offset: 0, limit: 20});
    const second = f.service.list({projectId: f.project.id, offset: first.nextOffset, limit: 20});
    assert.equal(first.total, 23); assert.equal(first.records.length, 20);
    assert.equal(second.records.length, 3); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.records, ...second.records].map(record => record.id)).size, 23);
    assert.throws(() => f.service.list({projectId: f.project.id, offset: 0, limit: 21}));
  } finally {f.close();}
});

test('hashes do not replace physical receipt, request, selected tuple and timestamp identities', async () => {
  const f = scene();
  try {
    const saved = await f.prepare(await f.request());
    const replace = record => f.db.prepare('UPDATE research_zenodo_preparations SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify(record), saved.id);
    for (const mutate of [
      body => {body.id = 'other';},
      body => {body.request.requestId = 'other';},
      body => {body.createdAt = '2026-11-05T00:00:00.000Z';},
      body => {body.inputs.files[0].name = 'other.zip'; const {contentHash, ...input} = body.inputs;
        body.inputs = api.sealZenodo(input); body.request.expectedInputsHash = body.inputs.contentHash;}
    ]) {
      const {contentHash, ...body} = structuredClone(saved); mutate(body); replace(api.sealZenodo(body));
      assert.throws(() => f.service.get(f.project.id, saved.id), /receipt_invalid/);
    }
    replace({...saved, contentHash: hash('tampered')});
    assert.throws(() => f.service.get(f.project.id, saved.id), /receipt_invalid/);
    replace(saved);
    await f.service.assertCurrent(saved);
    f.bytes = 'changed';
    await assert.rejects(f.service.assertCurrent(saved), /inputs_changed/);
  } finally {f.close();}
});

test('insert trigger identity corruption rolls the entire preparation transaction back', async () => {
  const f = scene();
  try {
    f.db.exec(`CREATE TRIGGER corrupt_preparation AFTER INSERT ON research_zenodo_preparations
      BEGIN UPDATE research_zenodo_preparations SET request_id='corrupt' WHERE id=NEW.id; END;`);
    await assert.rejects(f.prepare(await f.request()), /receipt_invalid/); assert.equal(f.count(), 0);
  } finally {f.close();}
});

test('streamed hashes verify actual multi-block bytes and reject wrong digest, size, symlink and cancellation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-zenodo-file-')));
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 13, 7);
    await writeFile(join(root, 'paper.zip'), bytes);
    const expected = {size: bytes.length, sha256: hash(bytes)};
    assert.equal(await api.hashZenodoFile(root, 'paper.zip', expected, new AbortController().signal), hash(bytes, 'md5'));
    for (const invalid of [{...expected, size: 5}, {...expected, sha256: hash('other')}]) {
      await assert.rejects(api.hashZenodoFile(root, 'paper.zip', invalid, new AbortController().signal), /file_changed/);
    }
    await symlink(join(root, 'paper.zip'), join(root, 'link.zip'));
    await assert.rejects(api.hashZenodoFile(root, 'link.zip', expected, new AbortController().signal));
    const cancel = new AbortController(); cancel.abort(new Error('synthetic_cancelled'));
    await assert.rejects(api.hashZenodoFile(root, 'paper.zip', expected, cancel.signal), /synthetic_cancelled/);
    await writeFile(join(root, 'paper.zip'), Buffer.alloc(bytes.length, 8));
    await assert.rejects(api.hashZenodoFile(root, 'paper.zip', expected, new AbortController().signal), /file_changed/);
  } finally {await rm(root, {recursive: true, force: true});}
});
