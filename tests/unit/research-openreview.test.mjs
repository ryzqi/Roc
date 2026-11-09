import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const timestamp = '2026-11-06T00:00:00.000Z';
const query = {kind: 'note', target: 'Paper1', after: null, limit: 1};
const note = (overrides = {}) => ({
  id: 'Paper1', forum: 'Paper1', invitations: ['Synthetic.org/2026/Conference/-/Submission'],
  readers: ['everyone'], signatures: ['Synthetic.org/2026/Conference/Authors'],
  domain: 'Synthetic.org/2026/Conference', tcdate: 1, tmdate: 2, cdate: 0,
  license: 'CC BY 4.0', content: {title: {value: 'Synthetic submission'}, authors: {value: ['Synthetic author']}},
  ...overrides
});
const edit = (overrides = {}) => ({
  id: 'Edit1', invitation: 'Synthetic.org/2026/Conference/-/Revision', readers: ['everyone'],
  signatures: ['~Synthetic_Author1'], tcdate: 3, tmdate: 4, replacement: false,
  content: {reason: {value: 'Synthetic correction'}},
  note: {id: 'Paper1', content: {title: {value: 'Synthetic revised title'}}},
  ...overrides
});
function scene(fetch) {
  const f = createResearchFixture(api, 'reading');
  let clock = Date.parse(timestamp);
  f.governor = new api.LiteratureProviderGovernor({'api2.openreview.net': {
    minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100, cooldownMs: 60000
  }}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.calls = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.calls.push({url, init});
    return fetch === undefined ? Response.json({notes: [note()]}) : fetch(url, init);
  }, f.governor);
  f.observations = new api.OpenReviewRepository(f.db, f.repository);
  f.service = new api.OpenReviewService(f.observations, f.transport, () => timestamp);
  f.request = {projectId: f.project.id, requestId: 'synthetic-openreview', query};
  f.read = (saved, offset = 0, limit = 50) =>
    f.observations.read({projectId: f.project.id, observationId: saved.id, offset, limit});
  f.history = (offset = 0, limit = 20) => f.observations.history({projectId: f.project.id, offset, limit});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}

test('anonymous v2 captures public Note source identity, wrappers, venue and server dates without workflow effects', async () => {
  const f = scene();
  try {
    const workflow = f.repository.getWorkflow(f.project.id);
    const saved = await f.service.capture(f.request), page = f.read(saved), observed = page.entries[0];
    assert.equal(saved.status, 'ok'); assert.equal(saved.entryCount, 1); assert.equal(saved.providerTotal, null);
    assert.equal('entries' in saved, false); assert.equal(observed.kind, 'note');
    assert.equal(observed.note.id, observed.note.forum); assert.equal(observed.note.replyto, null);
    assert.equal(observed.note.domain, 'Synthetic.org/2026/Conference');
    assert.equal(observed.note.tcdate, 1); assert.equal(observed.note.tmdate, 2); assert.equal(observed.note.cdate, 0);
    assert.deepEqual(observed.note.content.authors, {value: ['Synthetic author'], readers: null});
    assert.equal(observed.note.content.venueid, undefined); assert.equal(observed.note.license, 'CC BY 4.0');
    assert.equal(observed.sourceHash, api.resourceContentHash(observed.note));
    assert.match(saved.responseHash, /^[a-f0-9]{64}$/); assert.equal(saved.requests[0].method, 'GET');
    assert.equal(f.calls[0].url, api.openReviewEndpoint(query)); assert.equal(f.calls[0].init.redirect, 'error');
    assert.equal(new Headers(f.calls[0].init.headers).has('authorization'), false);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
    for (const table of ['research_library', 'research_resource_observations', 'research_scholarly_snapshots', 'research_evidence'])
      assert.equal(f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
    assert.deepEqual(await f.service.capture(f.request), saved);
    const cached = await f.service.capture({...f.request, requestId: 'again'});
    assert.equal(cached.cache, 'hit'); assert.equal(cached.fetchedAt, saved.fetchedAt);
    assert.notEqual(cached.id, saved.id); assert.equal(cached.requests.length, 0); assert.equal(f.calls.length, 1);
    await assert.rejects(f.service.capture({...f.request, query: {...query, target: 'Other'}}), /request_conflict/);
  } finally {await f.dispose();}
});

test('forum replies and invitation filters preserve source role rather than classifying all replies as reviews', () => {
  const reply = note({id: 'Reply1', replyto: 'Paper1', invitations: ['Synthetic.org/2026/Conference/-/Comment'],
    content: {comment: {value: 'Synthetic unverified opinion', readers: ['everyone']}}});
  for (const input of [
    {kind: 'forum', target: 'Paper1', after: null, limit: 2},
    {kind: 'invitation', target: reply.invitations[0], after: null, limit: 2}
  ]) {
    const result = api.readOpenReviewPage(input, {notes: [reply], count: 1});
    assert.equal(result.entries[0].note.replyto, 'Paper1');
    assert.deepEqual(result.entries[0].note.invitations, reply.invitations);
    assert.equal(result.providerTotal, 1); assert.equal(result.nextAfter, null);
  }
});

test('public Edit retains exact delta, ACL operations and replacement without reconstructing a historical Note', () => {
  const delta = {id: 'Paper1', readers: {values: ['Synthetic.org/Authors']},
    content: {private_field: {delete: true}, title: {value: 'Synthetic revision'}}};
  const result = api.readOpenReviewPage({kind: 'edits', target: 'Paper1', after: null, limit: 1},
    {edits: [edit({note: delta})]});
  assert.equal(result.nextAfter, 'Edit1'); assert.equal(result.entries[0].kind, 'edit');
  assert.deepEqual(result.entries[0].edit.note, delta);
  assert.deepEqual(result.entries[0].edit.content, {reason: {value: 'Synthetic correction'}});
  assert.equal(result.entries[0].edit.replacement, false);
  assert.equal(result.entries[0].sourceHash, api.resourceContentHash(result.entries[0].edit));
  assert.equal('forum' in result.entries[0].edit.note, false);
});

test('Note private readers, excluded everyone and independently private content cannot enter public observations', () => {
  for (const override of [
    {readers: ['Synthetic.org/Authors']}, {readers: undefined}, {nonreaders: ['everyone']},
    {content: {title: {value: 'Hidden', readers: ['Synthetic.org/Authors']}}},
    {content: {title: 'v1 unwrapped value'}}
  ]) assert.throws(() => api.readOpenReviewPage(query, {notes: [note(override)]}));
  for (const override of [{readers: ['Synthetic.org/Authors']}, {nonreaders: ['everyone']}])
    assert.throws(() => api.readOpenReviewPage({kind: 'edits', target: 'Paper1', after: null, limit: 1},
      {edits: [edit(override)]}));
});

test('explicit query identity and ascending after cursors reject mixed or substituted pages', () => {
  for (const [input, payload] of [
    [query, {notes: [note({id: 'Other'})]}],
    [{kind: 'forum', target: 'Paper1', after: null, limit: 2}, {notes: [note({forum: 'Other'})]}],
    [{kind: 'invitation', target: 'Venue/-/Review', after: null, limit: 2}, {notes: [note()]}],
    [{kind: 'edits', target: 'Paper1', after: null, limit: 2}, {edits: [edit({note: {id: 'Other'}})]}],
    [{kind: 'edits', target: 'Paper1', after: null, limit: 2}, {notes: [note()]}],
    [{kind: 'forum', target: 'Paper1', after: null, limit: 2}, {notes: [note(), note()]}],
    [{kind: 'forum', target: 'Paper1', after: null, limit: 2}, {notes: [note({id: 'Z'}), note({id: 'A'})]}],
    [{kind: 'forum', target: 'Paper1', after: 'Paper1', limit: 2}, {notes: [note()]}],
    [query, {notes: [note(), note({id: 'Other'})]}]
  ]) assert.throws(() => api.readOpenReviewPage(input, payload));
});

test('unknown counts and full pages use final id cursor, while empty success is distinct from failed page', async () => {
  const input = {kind: 'forum', target: 'Paper1', after: 'A', limit: 1};
  const full = api.readOpenReviewPage(input, {notes: [note()], count: 1});
  assert.equal(full.nextAfter, 'Paper1');
  assert.deepEqual(api.readOpenReviewPage({...input, after: full.nextAfter}, {notes: []}),
    {entries: [], providerTotal: null, nextAfter: null});
  for (const kind of ['forum', 'edits']) {
    const endpoint = new URL(api.openReviewEndpoint({...input, kind}));
    assert.equal(endpoint.hostname, 'api2.openreview.net'); assert.equal(endpoint.searchParams.get('after'), 'A');
    assert.equal(endpoint.searchParams.get('sort'), 'id:asc'); assert.equal(endpoint.searchParams.has('offset'), false);
    assert.equal(endpoint.searchParams.get(kind === 'edits' ? 'note.id' : 'forum'), 'Paper1');
  }
  const f = scene(async () => Response.json({notes: []}));
  try {
    const result = await f.service.capture(f.request);
    assert.equal(result.status, 'ok'); assert.equal(f.read(result).total, 0); assert.equal(result.entryCount, 0);
  } finally {await f.dispose();}
});

test('schema drift and partial invalid pages persist failure without contaminating cache', async () => {
  let valid = false;
  const f = scene(async () => Response.json(valid ? {notes: [note()]} :
    {notes: [note(), note({id: 'Reply1', content: {title: 'invalid-wrapper'}})]}));
  try {
    const request = {...f.request, query: {kind: 'forum', target: 'Paper1', after: null, limit: 2}};
    const failed = await f.service.capture(request);
    assert.equal(failed.status, 'error'); assert.equal(failed.errorCode, 'literature_provider_response_invalid');
    assert.equal(failed.entryCount, null); assert.equal(f.read(failed).total, null); assert.deepEqual(f.read(failed).entries, []);
    assert.deepEqual(await f.service.capture(request), failed); assert.equal(f.calls.length, 1);
    valid = true;
    const success = await f.service.capture({...request, requestId: 'after-drift'});
    assert.equal(success.status, 'ok'); assert.equal(success.cache, 'miss'); assert.equal(f.calls.length, 2);
  } finally {await f.dispose();}
});

test('anonymous 403/404 failures make no claim about private note existence and 429 records bounded retries', async () => {
  for (const status of [403, 404]) {
    const f = scene(async () => new Response(null, {status}));
    try {
      const result = await f.service.capture(f.request);
      assert.equal(result.errorCode, `literature_provider_http_${status}`); assert.equal(result.entryCount, null);
      assert.equal(result.requests.length, 1); assert.equal(f.calls.length, 1);
    } finally {await f.dispose();}
  }
  let calls = 0;
  const f = scene(async () => ++calls < 3 ? new Response(null, {status: 429, headers: {'retry-after': '2'}}) :
    Response.json({notes: [note()]}));
  try {
    const result = await f.service.capture(f.request);
    assert.deepEqual(result.requests.map(row => row.status), [429, 429, 200]);
    assert.deepEqual(result.requests.slice(0, 2).map(row => row.retryAfterMs), [2000, 2000]);
    assert.equal(f.governor.observe('api2.openreview.net').remainingRequests, 297);
  } finally {await f.dispose();}
});

test('timeout, transport failure and oversized stream retain failures without cached success', async () => {
  const timed = scene(async (_url, init) => new Promise((_resolve, reject) =>
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true})));
  try {
    const result = await timed.transport.readProviderJson({source: 'openreview', url: api.openReviewEndpoint(query),
      projectId: timed.project.id, timeoutMs: 20}, payload => api.readOpenReviewPage(query, payload));
    assert.equal(result.errorCode, 'literature_provider_timeout'); assert.equal(result.value, null);
  } finally {await timed.dispose();}
  const offline = scene(async () => {throw new Error('synthetic-offline');});
  try {assert.equal((await offline.service.capture(offline.request)).errorCode, 'literature_provider_transport_error');}
  finally {await offline.dispose();}
  let cancelled = 0;
  const large = scene(async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));}, cancel() {cancelled++;}
  })));
  try {
    assert.equal((await large.service.capture(large.request)).errorCode, 'literature_provider_response_too_large');
    await large.service.capture({...large.request, requestId: 'again'});
    assert.equal(cancelled, 2); assert.equal(large.calls.length, 2);
  } finally {await large.dispose();}
});

test('exact concurrent replay, conflicting query and project-scoped cancellation fence late responses', {timeout: 10000}, async () => {
  let start, release;
  const started = new Promise(resolve => {start = resolve;}), response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {start(); return response;});
  try {
    const outcomes = Promise.allSettled([f.service.capture(f.request), f.service.capture(f.request)]);
    await started;
    await assert.rejects(f.service.capture({...f.request, query: {...query, target: 'Other'}}), /request_conflict/);
    assert.equal(f.service.cancel({projectId: 'other', requestId: f.request.requestId}).cancelled, false);
    assert.equal(f.service.cancel({projectId: f.project.id, requestId: f.request.requestId}).cancelled, true);
    release(Response.json({notes: [note()]}));
    assert.ok((await outcomes).every(result => result.status === 'rejected' &&
      result.reason.message === 'research_openreview_capture_cancelled'));
    assert.equal(f.calls.length, 1); assert.equal(f.history().total, 0);
  } finally {release(Response.json({notes: []})); await f.dispose();}
});

test('shutdown refuses late writes and future captures', {timeout: 10000}, async () => {
  let start;
  const started = new Promise(resolve => {start = resolve;});
  const f = scene(async (_url, init) => {
    start(); return new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  try {
    const outcomes = Promise.allSettled([f.service.capture(f.request)]);
    await started; await f.service.shutdown();
    assert.equal((await outcomes)[0].reason.message, 'research_openreview_service_closed');
    assert.equal(f.history().total, 0);
    await assert.rejects(f.service.capture(f.request), /research_openreview_service_closed/);
  } finally {await f.dispose();}
});

test('archive retains exact replay and history while rejecting in-flight save and new capture', {timeout: 10000}, async () => {
  let start, release, slow = false;
  const started = new Promise(resolve => {start = resolve;}), response = new Promise(resolve => {release = resolve;});
  const f = scene(async () => {if (!slow) return Response.json({notes: [note()]}); start(); return response;});
  try {
    const saved = await f.service.capture(f.request);
    slow = true;
    const outcomes = Promise.allSettled([f.service.capture({...f.request, requestId: 'slow', query: {...query, target: 'Other'}})]);
    await started; f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    release(Response.json({notes: [note({id: 'Other', forum: 'Other'})]}));
    assert.equal((await outcomes)[0].reason.message, 'research_project_archived');
    assert.deepEqual(await f.service.capture(f.request), saved); assert.equal(f.history().total, 1);
    await assert.rejects(f.service.capture({...f.request, requestId: 'new'}), /research_project_archived/);
  } finally {release(Response.json({notes: []})); await f.dispose();}
});

test('local entry/history pages and transport cache stay project-scoped', async () => {
  const notes = Array.from({length: 50}, (_, index) => note({id: `Reply${String(index).padStart(2, '0')}`}));
  const f = scene(async () => Response.json({notes}));
  try {
    const request = {...f.request, query: {kind: 'forum', target: 'Paper1', after: null, limit: 50}};
    const saved = await f.service.capture(request);
    assert.equal(f.read(saved, 0, 20).nextOffset, 20); assert.equal(f.read(saved, 40, 20).entries.length, 10);
    assert.equal(f.read(saved, 40, 20).nextOffset, null); assert.equal(saved.nextAfter, 'Reply49');
    for (let index = 0; index < 3; index++) await f.service.capture({...request, requestId: `history${index}`});
    assert.equal(f.history(0, 2).total, 4); assert.equal(f.history(0, 2).nextOffset, 2);
    assert.equal(f.history(2, 2).nextOffset, null);
    const other = f.repository.createProject({title: 'Other', description: 'Synthetic scope', workspacePath: '/synthetic/other'});
    assert.throws(() => f.observations.get(other.id, saved.id), /research_openreview_not_found/);
    const second = await f.service.capture({...request, projectId: other.id});
    assert.equal(second.cache, 'miss'); assert.equal(f.calls.length, 2); assert.equal(f.history().total, 4);
  } finally {await f.dispose();}
});

test('physical row identity, query, endpoint, governance and entry hash are checked even after outer rehashing', async () => {
  const f = scene();
  try {
    const saved = await f.service.capture(f.request);
    const original = f.db.prepare('SELECT snapshot_json FROM research_openreview_observations WHERE id=?').pluck().get(saved.id);
    for (const mutate of [
      value => {value.id = 'other';},
      value => {value.request.projectId = 'other'; value.projectId = 'other';},
      value => {value.request.requestId = 'other';},
      value => {value.endpoint = 'https://api.openreview.net/notes';},
      value => {value.governance.host = 'api.openreview.net';},
      value => {value.page.entries[0].note.content.title.value = 'changed';},
      value => {value.page.entries[0].note.id = 'Other';
        value.page.entries[0].sourceHash = api.resourceContentHash(value.page.entries[0].note);},
      value => {value.request.query.target = 'Other'; value.endpoint = api.openReviewEndpoint(value.request.query);}
    ]) {
      const value = JSON.parse(original); mutate(value);
      const {contentHash: _hash, ...body} = value; value.contentHash = api.resourceContentHash(body);
      f.db.prepare('UPDATE research_openreview_observations SET snapshot_json=? WHERE id=?').run(JSON.stringify(value), saved.id);
      assert.throws(() => f.read(saved), /research_openreview_snapshot_invalid/);
    }
    f.db.prepare('UPDATE research_openreview_observations SET snapshot_json=? WHERE id=?').run(original, saved.id);
    const reopened = new Database(f.db.serialize());
    try {
      const repository = new api.OpenReviewRepository(reopened, new api.ResearchRepository(reopened, f.tasks, () => timestamp));
      assert.deepEqual(repository.get(f.project.id, saved.id), f.observations.get(f.project.id, saved.id));
    } finally {reopened.close();}
  } finally {await f.dispose();}
});

test('post-insert archive or storage substitution rolls back the entire transaction', async () => {
  for (const action of [
    "UPDATE research_projects SET status='archived' WHERE id=NEW.project_id;",
    "UPDATE research_openreview_observations SET snapshot_json='{}' WHERE id=NEW.id;"
  ]) {
    const f = scene();
    try {
      f.db.exec(`CREATE TRIGGER synthetic_drift AFTER INSERT ON research_openreview_observations BEGIN ${action} END;`);
      await assert.rejects(f.service.capture(f.request), /research_project_archived|research_openreview_snapshot_invalid/);
      assert.equal(f.history().total, 0); assert.equal(f.repository.getProject(f.project.id).status, 'active');
    } finally {await f.dispose();}
  }
});

test('strict IPC and four bounded capabilities refuse tokens, actors, v1 data and foreign project', async () => {
  const f = scene(), registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchOpenReviewCapabilities) registry.declare('synthetic', descriptor);
    api.registerResearchOpenReviewCapabilities({pluginId: 'synthetic', capabilities: registry}, f.service, f.observations);
    const saved = await registry.invoke('research.openreview.capture',
      api.parseIpcRequestArgs('roc:research:openreview-capture', [f.request])[0]);
    const page = await registry.invoke('research.openreview.read',
      {projectId: f.project.id, observationId: saved.id, offset: 0, limit: 1});
    assert.equal(page.total, 1); assert.equal(page.entries.length, 1);
    for (const extra of [{token: 'secret'}, {actor: 'human'}, {apiVersion: 1}])
      assert.throws(() => api.parseIpcRequestArgs('roc:research:openreview-capture', [{...f.request, ...extra}]));
    for (const invalid of [
      {...query, target: 'https://openreview.net/forum?id=Paper1'}, {...query, limit: 2}, {...query, after: 'A'},
      {kind: 'edits', target: 'Paper1', after: null, limit: 51},
      {kind: 'edits', target: 'Paper1', after: null, limit: 1, offset: 0}
    ]) assert.throws(() => api.openReviewQuerySchema.parse(invalid));
    assert.throws(() => api.openReviewReadSchema.parse({projectId: f.project.id, observationId: saved.id, offset: 0, limit: 51}));
    assert.throws(() => api.openReviewHistorySchema.parse({projectId: f.project.id, offset: 0, limit: 51}));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:literature-search', [{query: 'review', sources: ['openreview']}]));
    await assert.rejects(registry.invoke('research.openreview.capture', {...f.request, projectId: 'missing'}));
    assert.deepEqual(api.researchOpenReviewCapabilities.map(row => row.name).sort(),
      ['research.openreview.cancel', 'research.openreview.capture', 'research.openreview.history', 'research.openreview.read']);
  } finally {await f.dispose();}
});
