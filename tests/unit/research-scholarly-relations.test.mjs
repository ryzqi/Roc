import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const doi = '10.1234/scholarly';
const timestamp = '2026-11-06T00:00:00.000Z';
const oa = (refs = ['https://openalex.org/W2']) => ({id: 'https://openalex.org/W1',
  doi: `https://doi.org/${doi}`, referenced_works: refs, is_retracted: false});
const cr = () => ({message: {DOI: doi, reference: [{DOI: '10.1234/reference'}, {key: 'unidentified-reference'}],
  relation: {'is-preprint-of': [{id: '10.1234/published', 'id-type': 'doi', 'asserted-by': 'subject'}],
    'is-supplement-to': [{id: 'synthetic', 'id-type': 'uri', 'asserted-by': 'object'}]},
  'update-to': [{DOI: '10.1234/original', type: 'correction', updated: {'date-parts': [[2026, 11, 6]]}}]}});
const s2 = (offset = 0) => ({offset, data: [{citedPaper: {paperId: 'synthetic-paper', externalIds: {DOI: '10.1234/s2-reference'}}}]});
function scene(fetch, governorPolicy = {}) {
  const f = createResearchFixture(api, 'reading');
  const metadata = {id: 'scholarly-fixture', source: 'local', externalId: 'scholarly-fixture', doi,
    title: 'Synthetic scholarly source', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
  const bibliography = {citationKey: 'synthetic2026', entryType: 'article', fields: {title: metadata.title},
    preambles: [], csl: null, title: metadata.title, authors: metadata.authors, doi, publishedYear: 2026, abstract: null, url: null};
  f.item = f.repository.library.import([{metadata, bibliography}], f.project.id).items[0];
  let clock = Date.parse(timestamp);
  const policy = {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100,
    cooldownMs: 60000, ...governorPolicy};
  f.governor = new api.LiteratureProviderGovernor(Object.fromEntries(
    ['api.openalex.org', 'api.crossref.org', 'api.semanticscholar.org'].map(host => [host, policy])),
  () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.calls = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.calls.push({url, init});
    if (fetch !== undefined) return fetch(url, init);
    const host = new URL(url).host;
    return Response.json(host === 'api.openalex.org' ? oa() : host === 'api.crossref.org' ? cr() : s2());
  }, f.governor);
  f.snapshots = new api.ScholarlyRelationsRepository(f.db, f.repository);
  f.service = new api.ScholarlyRelationsService(f.snapshots, f.transport, () => timestamp);
  f.request = {projectId: f.project.id, itemId: f.item.id, expectedRevision: f.item.revision,
    requestId: 'synthetic-scholarly', sources: ['openalex', 'crossref', 'semantic_scholar'], offset: 0, limit: 2};
  f.read = (snapshot, source, offset = 0, limit = 100) => f.snapshots.read({
    projectId: f.project.id, itemId: f.item.id, snapshotId: snapshot.id, source, offset, limit});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}

test('three provider observations preserve direction, exact type, identity, unknown references and immutable history', async () => {
  const f = scene();
  try {
    const library = f.repository.library.get(f.item.id);
    const workflow = f.repository.getWorkflow(f.project.id);
    const saved = await f.service.capture(f.request);
    assert.equal(saved.status, 'complete'); assert.equal(f.calls.length, 3);
    assert.equal(saved.itemRevision, f.item.revision); assert.equal(saved.doi, doi);
    assert.equal('relations' in saved, false, 'capture returns only bounded summary');
    const open = f.read(saved, 'openalex');
    assert.deepEqual(open.relations[0].subject, {scheme: 'openalex', value: 'https://openalex.org/W1'});
    assert.equal(open.relations[0].object.value, 'https://openalex.org/W2');
    assert.equal(saved.sources[0].retraction, 'not_reported');
    const cross = f.read(saved, 'crossref', 0, 2);
    assert.deepEqual(cross.relations.map(row => row.kind), ['cites', 'version']);
    assert.equal(cross.nextOffset, 2);
    const later = f.read(saved, 'crossref', cross.nextOffset, 2);
    assert.equal(later.relations[0].assertedBy, 'object');
    assert.equal(later.relations[0].providerType, 'is-supplement-to');
    assert.equal(later.relations[1].subject.value, doi);
    assert.equal(later.relations[1].object.value, '10.1234/original');
    assert.equal(later.relations[1].kind, 'correction');
    assert.equal(later.nextOffset, null); assert.equal(saved.sources[1].unmappedReferences, 1);
    assert.equal(f.read(saved, 'semantic_scholar').relations[0].object.value, '10.1234/s2-reference');
    for (const source of saved.sources) {
      assert.equal(source.requests.length, 1); assert.equal(source.requests[0].status, 200);
      assert.match(source.responseHash, /^[a-f0-9]{64}$/); assert.equal(source.cache, 'miss');
      assert.equal(source.fetchedAt !== null, true);
    }
    assert.deepEqual(f.repository.library.get(f.item.id), library);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow, 'observations cannot approve or rewrite conclusions');
    assert.deepEqual(await f.service.capture(f.request), saved); assert.equal(f.calls.length, 3);
    const second = await f.service.capture({...f.request, requestId: 'new-observation'});
    assert.notEqual(second.id, saved.id); assert.equal(f.calls.length, 3);
    assert.ok(second.sources.every(source => source.cache === 'hit' && source.requests.length === 0));
    const page = f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 1});
    assert.equal(page.total, 2); assert.equal(page.records[0].id, second.id); assert.equal(page.nextOffset, 1);
    assert.equal(f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 1, limit: 1}).records[0].id, saved.id);
  } finally {await f.dispose();}
});

test('optional Crossref fields and S2 unavailable identities remain explicit without inventing observations', () => {
  const bare = api.readScholarlyMaterial('crossref', doi, 0, 2, {message: {DOI: doi}});
  assert.deepEqual(bare.relations, []); assert.equal(bare.referencesReported, false);
  assert.equal(bare.relationsReported, false); assert.equal(bare.updatesReported, false); assert.equal(bare.retraction, 'unknown');
  const observed = api.readScholarlyMaterial('semantic_scholar', doi, 0, 4, {offset: 0, data: [
    {citedPaper: null}, {citedPaper: {paperId: null}}, {citedPaper: {paperId: 'native', externalIds: {DOI: null}}},
    {citedPaper: {paperId: null, externalIds: {DOI: '10.1234/identified'}}}
  ]});
  assert.equal(observed.unmappedReferences, 2);
  assert.deepEqual(observed.relations.map(row => row.object.scheme), ['semantic_scholar', 'doi']);
  assert.equal(observed.retraction, 'unknown');
});

test('S2 pages remain individually source-bound and report the actual continuation', async () => {
  const f = scene(async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return Response.json({...s2(offset), ...(offset === 0 ? {next: 1} : {})});
  });
  try {
    const first = await f.service.capture({...f.request, sources: ['semantic_scholar']});
    assert.equal(first.sources[0].nextOffset, 1);
    const second = await f.service.capture({...f.request, requestId: 'second-page', sources: ['semantic_scholar'], offset: 1});
    assert.equal(second.request.offset, 1); assert.equal(second.sources[0].nextOffset, null);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '1']);
    assert.equal(api.scholarlyCaptureSchema.safeParse({...f.request, offset: 1}).success, false);
  } finally {await f.dispose();}
});

test('provider schema/identity/pagination changes fail before caching and keep source error receipts', async () => {
  const failures = [
    ['openalex', {...oa(), doi: '10.1234/other'}],
    ['openalex', {id: 'https://openalex.org/W1', doi}],
    ['crossref', {message: {DOI: '10.1234/other'}}],
    ['crossref', {message: {DOI: doi, reference: {changed: []}}}],
    ['semantic_scholar', {...s2(), next: 0}],
    ['semantic_scholar', {offset: 2, data: []}],
    ['semantic_scholar', {offset: 0, data: [{}]}]
  ];
  for (const [source, invalid] of failures) {
    let valid = false;
    const f = scene(async () => Response.json(valid ? source === 'openalex' ? oa() : source === 'crossref' ? cr() : s2() : invalid));
    try {
      const failed = await f.service.capture({...f.request, sources: [source]});
      assert.equal(failed.status, 'failed', source);
      assert.equal(failed.sources[0].errorCode, 'literature_provider_response_invalid');
      assert.match(failed.sources[0].responseHash, /^[a-f0-9]{64}$/);
      assert.equal(f.read(failed, source).total, 0);
      valid = true;
      const repaired = await f.service.capture({...f.request, sources: [source], requestId: 'schema-repaired'});
      assert.equal(repaired.status, 'complete'); assert.equal(f.calls.length, 2, 'invalid payload must not enter cache');
      assert.equal(repaired.sources[0].cache, 'miss');
    } finally {await f.dispose();}
  }
});

test('partial source failure retains successful relations and actual HTTP attempts', async () => {
  const f = scene(async url => new URL(url).host === 'api.crossref.org'
    ? new Response('synthetic unavailable', {status: 503}) : Response.json(oa()));
  try {
    const saved = await f.service.capture({...f.request, sources: ['openalex', 'crossref']});
    assert.equal(saved.status, 'partial'); assert.equal(f.read(saved, 'openalex').total, 1);
    assert.equal(saved.sources[1].errorCode, 'literature_provider_http_503');
    assert.equal(saved.sources[1].requests.length, 3); assert.equal(saved.sources[1].responseHash, null);
    assert.equal(saved.sources[1].retraction, 'unknown');
  } finally {await f.dispose();}
});

test('429 honors shared cooldown and retries without unbounded requests', async () => {
  let calls = 0;
  const f = scene(async () => ++calls === 1 ? new Response('', {status: 429, headers: {'retry-after': '2'}}) : Response.json(oa()));
  try {
    const saved = await f.service.capture({...f.request, sources: ['openalex']});
    assert.equal(saved.status, 'complete'); assert.equal(calls, 2);
    assert.equal(saved.sources[0].requests[0].retryAfterMs, 2000);
    assert.equal(saved.sources[0].requests[1].status, 200);
  } finally {await f.dispose();}
});

test('stream response size is enforced, cancelled, not cached, and failure stays visible', async () => {
  let cancelled = false;
  const f = scene(async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));},
    cancel() {cancelled = true;}
  })));
  try {
    const saved = await f.service.capture({...f.request, sources: ['openalex']});
    assert.equal(saved.status, 'failed'); assert.equal(cancelled, true);
    assert.equal(saved.sources[0].errorCode, 'literature_provider_response_too_large');
    await f.service.capture({...f.request, requestId: 'repeat-large', sources: ['openalex']});
    assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});

test('transport timeout gives a failed source receipt and ordinary transport failures are not retried', async () => {
  const f = scene(async (_url, {signal}) => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), {once: true})));
  try {
    const result = await f.transport.readProviderJson({source: 'openalex', url: api.scholarlyEndpoint('openalex', doi, 0, 2),
      projectId: f.project.id, timeoutMs: 10}, value => api.readScholarlyMaterial('openalex', doi, 0, 2, value));
    assert.equal(result.status, 'error'); assert.equal(result.errorCode, 'literature_provider_timeout');
    assert.equal(result.requests.length, 1); assert.equal(result.requests[0].errorCode, 'literature_provider_timeout');
  } finally {await f.dispose();}
  const failed = scene(async () => {throw new Error('synthetic network error');});
  try {
    const result = await failed.service.capture({...failed.request, sources: ['openalex']});
    assert.equal(result.sources[0].errorCode, 'literature_provider_transport_error'); assert.equal(failed.calls.length, 1);
  } finally {await failed.dispose();}
});

test('request conflicts, missing DOI, wrong scope and revision are rejected before any network request', async () => {
  const f = scene();
  try {
    await assert.rejects(f.service.capture({...f.request, expectedRevision: 99}), /research_library_revision_conflict/);
    f.db.prepare('DELETE FROM research_library_projects WHERE item_id=?').run(f.item.id);
    await assert.rejects(f.service.capture(f.request), /scholarly_item_project_mismatch/);
    f.repository.library.link(f.item.id, f.project.id, true, {notify: false});
    const metadata = {...f.item.metadata, doi: null};
    f.db.prepare('UPDATE research_library SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), f.item.id);
    await assert.rejects(f.service.capture(f.request), /scholarly_doi_required/);
    assert.equal(f.calls.length, 0);
    f.db.prepare('UPDATE research_library SET metadata_json=? WHERE id=?').run(JSON.stringify(f.item.metadata), f.item.id);
    const saved = await f.service.capture(f.request);
    await assert.rejects(f.service.capture({...f.request, limit: 1}), /scholarly_request_conflict/);
    assert.throws(() => f.read(saved, 'openalex', 0, 101));
  } finally {await f.dispose();}
});

test('late results refuse changed library revision, archived project or unlinked scope without saving', async () => {
  for (const change of ['revision', 'archived', 'unlink']) {
    let proceed, ready;
    const started = new Promise(resolve => {ready = resolve;});
    const response = new Promise(resolve => {proceed = resolve;});
    const f = scene(async () => {ready(); await response; return Response.json(oa());});
    try {
      const capture = f.service.capture({...f.request, sources: ['openalex']});
      await started;
      if (change === 'revision') f.repository.library.setCitationKey(f.item.id, f.item.revision, 'changed2026');
      if (change === 'archived') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
      if (change === 'unlink') f.repository.library.link(f.item.id, f.project.id, false, {notify: false});
      proceed();
      await assert.rejects(capture, /research_library_revision_conflict|research_project_archived|scholarly_item_project_mismatch/);
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_scholarly_snapshots').pluck().get(), 0);
    } finally {proceed(); await f.dispose();}
  }
});

test('pending duplicate replays one query; cancellation and shutdown fence ignored late responses', async () => {
  for (const close of [false, true]) {
    let proceed, ready;
    const started = new Promise(resolve => {ready = resolve;});
    const response = new Promise(resolve => {proceed = resolve;});
    const f = scene(async () => {ready(); await response; return Response.json(oa());});
    try {
      const request = {...f.request, sources: ['openalex']};
      const capture = f.service.capture(request);
      const rejection = assert.rejects(capture, /scholarly_capture_cancelled|scholarly_service_closed/);
      await started;
      const duplicate = f.service.capture(request);
      const duplicateRejection = assert.rejects(duplicate, /scholarly_capture_cancelled|scholarly_service_closed/);
      await assert.rejects(f.service.capture({...request, limit: 1}), /scholarly_request_conflict/);
      let shutdown;
      if (close) shutdown = f.service.shutdown();
      else {
        assert.throws(() => f.service.cancel({projectId: f.project.id, itemId: 'wrong', requestId: request.requestId}), /scholarly_item_project_mismatch/);
        assert.deepEqual(f.service.cancel({projectId: f.project.id, itemId: f.item.id, requestId: request.requestId}), {cancelled: true});
      }
      assert.equal(f.calls[0].init.signal.aborted, true);
      proceed();
      await rejection; await duplicateRejection; await shutdown;
      assert.equal(f.calls.length, 1); assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_scholarly_snapshots').pluck().get(), 0);
      if (close) await assert.rejects(f.service.capture(request), /scholarly_service_closed/);
    } finally {proceed(); await f.dispose();}
  }
});

test('exact saved request replays after source revision drift and snapshot corruption fails integrity checks', async () => {
  const f = scene();
  try {
    const saved = await f.service.capture(f.request);
    f.repository.library.setCitationKey(f.item.id, f.item.revision, 'changed2026');
    assert.deepEqual(await f.service.capture(f.request), saved); assert.equal(f.calls.length, 3);
    const row = JSON.parse(f.db.prepare('SELECT snapshot_json FROM research_scholarly_snapshots WHERE id=?').pluck().get(saved.id));
    row.relations[0].relation.object.value = 'https://openalex.org/W999';
    f.db.prepare('UPDATE research_scholarly_snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(row), saved.id);
    assert.throws(() => f.read(saved, 'openalex'), /scholarly_snapshot_invalid/);
  } finally {await f.dispose();}
});

test('migration52 preserves every historical ledger row and initializes no inferred scholarly data', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(row => row.version <= 51)});
    const prior = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyResearchDatabaseSchema(db);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=51 ORDER BY version').all(), prior);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 52);
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_scholarly_snapshots').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {db.close();}
});

test('foreign project reads and canonically rehashed mismatched storage identities cannot expose another snapshot', async () => {
  const f = scene();
  try {
    const saved = await f.service.capture(f.request);
    const other = f.repository.createProject({title: 'Other synthetic project', description: 'Different scope', workspacePath: '/synthetic/other-project'});
    assert.throws(() => f.snapshots.read({projectId: other.id, itemId: f.item.id, snapshotId: saved.id,
      source: 'openalex', offset: 0, limit: 1}), /scholarly_snapshot_not_found/);
    const row = JSON.parse(f.db.prepare('SELECT snapshot_json FROM research_scholarly_snapshots WHERE id=?').pluck().get(saved.id));
    row.id = 'different-snapshot';
    const {contentHash: _hash, ...body} = row;
    row.contentHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(body)).digest('hex');
    f.db.prepare('UPDATE research_scholarly_snapshots SET snapshot_json=? WHERE id=?').run(JSON.stringify(row), saved.id);
    assert.throws(() => f.read(saved, 'openalex'), /scholarly_snapshot_invalid/);
  } finally {await f.dispose();}
});

test('declared IPC and capability path uses strict contracts with paged source results', async () => {
  const f = scene();
  const registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchScholarlyCapabilities) registry.declare('synthetic', descriptor);
    api.registerResearchScholarlyCapabilities({pluginId: 'synthetic', capabilities: registry}, f.service, f.snapshots);
    const args = api.parseIpcRequestArgs('roc:research:scholarly-capture', [f.request]);
    const saved = await registry.invoke('research.scholarly.capture', args[0]);
    assert.equal(saved.status, 'complete');
    const page = await registry.invoke('research.scholarly.read', {projectId: f.project.id, itemId: f.item.id,
      snapshotId: saved.id, source: 'crossref', offset: 0, limit: 1});
    assert.equal(page.relations.length, 1); assert.equal(page.nextOffset, 1);
    await assert.rejects(registry.invoke('research.scholarly.capture', {...f.request, requestId: 'missing', itemId: 'missing'}));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:scholarly-capture', [{...f.request, authority: 'user'}]));
  } finally {await f.dispose();}
});

test('shared host quota refuses another cache miss and cache is isolated by project', async () => {
  const f = scene(undefined, {maxRequests: 1});
  try {
    const url = api.scholarlyEndpoint('openalex', doi, 0, 2);
    const validate = value => api.readScholarlyMaterial('openalex', doi, 0, 2, value);
    const request = {source: 'openalex', url, projectId: f.project.id, timeoutMs: 1000};
    assert.equal((await f.transport.readProviderJson(request, validate)).status, 'ok');
    const hit = await f.transport.readProviderJson(request, validate);
    assert.equal(hit.cache, 'hit'); assert.equal(hit.requests.length, 0);
    const refused = await f.transport.readProviderJson({...request, projectId: 'other-project'}, validate);
    assert.equal(refused.status, 'error'); assert.equal(refused.errorCode, 'literature_provider_quota_exhausted');
    assert.equal(refused.cache, 'miss'); assert.equal(f.calls.length, 1);
  } finally {await f.dispose();}
});

test('mapped collection size failures occur before shared caching rather than silently truncating', async () => {
  const payload = {message: {DOI: doi, reference: Array.from({length: 10000}, (_, index) => ({DOI: `10.1234/ref-${index}`})),
    relation: {'is-version-of': [{id: '10.1234/version', 'id-type': 'doi', 'asserted-by': 'subject'}]}}};
  const f = scene(async () => Response.json(payload));
  try {
    const request = {...f.request, sources: ['crossref']};
    const first = await f.service.capture(request);
    assert.equal(first.status, 'failed'); assert.equal(first.sources[0].errorCode, 'literature_provider_response_invalid');
    assert.equal(first.sources[0].referencesReported, null); assert.equal(first.sources[0].unmappedReferences, null);
    await f.service.capture({...request, requestId: 'repeat-bound'});
    assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});
