import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const timestamp = '2026-11-06T00:00:00.000Z';
const notice = (type = 'correction', id = '10.1234/notice') => ({DOI: id, title: ['Synthetic notice'],
  'update-to': [{DOI: '10.1234/target', type, updated: {'date-parts': [[2026, 11, 6]]}}]});
const crossref = (ids = ['baseline']) => ({message: {'total-results': ids.length,
  items: ids.map(id => ({DOI: `10.1234/${id}`, title: [`Synthetic ${id}`], author: [{given: 'Synthetic', family: 'Author'}]}))}});
function scene(fetch) {
  const f = createResearchFixture(api, 'reading');
  let clock = Date.parse(timestamp);
  f.now = () => new Date(clock).toISOString();
  f.advance = () => {clock += 7 * 86400_000;};
  f.calls = []; f.errors = []; f.transports = [];
  const governor = new api.LiteratureProviderGovernor({
    'api.crossref.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1000},
    'api.openalex.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1000}
  }, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  const transport = () => {
    const value = new api.LiteratureSearchService(async (url, init) => {
      f.calls.push({url, init});
      return fetch ? fetch(url, init) : Response.json(crossref(f.ids ?? ['baseline']));
    }, governor);
    f.transports.push(value); return value;
  };
  f.imports = new api.LiteratureImportService(f.db, f.repository.library,
    {searchDetailed: (...args) => transport().searchDetailed(...args)}, {
      prepareRecord() {throw new Error('unexpected_import');}, prepareDoi() {throw new Error('unexpected_import');}
    }, () => {throw new Error('unexpected_library_change');}, f.now);
  f.monitors = new api.ResearchMonitorRepository(f.db, f.repository, f.now);
  f.service = new api.ResearchMonitorService(f.monitors, f.imports,
    {readProviderJson: (...args) => transport().readProviderJson(...args)}, error => f.errors.push(error), f.now);
  f.human = (capability, action) => api.withResearchHumanContext({capability: `research.monitors.${capability}`,
    projectId: f.project.id, windowId: 7}, action);
  f.request = {projectId: f.project.id, requestId: 'create', monitorId: null, expectedRevision: 0,
    title: 'Synthetic monitor', cadence: 'weekly', query: {kind: 'search',
      search: {query: 'Synthetic fixture', sources: ['crossref'], limit: 30, maxPages: 1}}};
  f.save = (request = f.request) => f.human('save', () => f.service.save(request));
  f.check = (monitor, requestId = crypto.randomUUID()) => f.human('check', () => f.service.check({
    projectId: f.project.id, monitorId: monitor.id, expectedRevision: monitor.revision, requestId
  }));
  f.history = (monitor, kind, offset = 0) => f.monitors.history({projectId: f.project.id, monitorId: monitor.id, offset, limit: 20}, kind);
  f.dispose = async () => {await f.service.shutdown(); await f.imports.shutdown();
    for (const value of f.transports) await value.shutdown(); f.close();};
  f.target = () => {
    const record = {id: 'crossref:10.1234/target', source: 'crossref', externalId: '10.1234/target',
      doi: '10.1234/target', title: 'Synthetic target', authors: ['Synthetic Author'], abstract: null,
      publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
    const item = f.repository.library.import([{metadata: record, bibliography: api.bibliographyFromRecord(record, new Set())}],
      f.project.id).items[0];
    return {kind: 'updates', itemId: item.id, itemRevision: item.revision, doi: record.doi};
  };
  return f;
}

test('human main authority, strict requests, query versions and exact mutation replay', async () => {
  const f = scene();
  try {
    assert.throws(() => f.service.save(f.request), /research_human_required/);
    assert.throws(() => api.monitorSaveSchema.parse({...f.request, actor: {kind: 'user', id: 'fake'}}));
    assert.throws(() => api.monitorSaveSchema.parse({...f.request, query: {kind: 'search',
      search: {...f.request.query.search, sources: ['crossref', 'crossref']}}}));
    const saved = f.save();
    assert.deepEqual(f.save(), saved); assert.equal(f.calls.length, 0);
    assert.equal(saved.actor.id, 'window:7'); assert.equal(saved.queryVersion, 1);
    assert.equal(saved.nextCheckAt, '2026-11-13T00:00:00.000Z');
    assert.throws(() => f.save({...f.request, title: 'Changed'}), /request_conflict/);
    const revised = f.save({...f.request, requestId: 'revise', monitorId: saved.id, expectedRevision: 1,
      query: {...f.request.query, search: {...f.request.query.search, query: 'Changed query'}}});
    assert.equal(revised.queryVersion, 2); assert.equal(revised.revision, 2);
    assert.equal(f.history(saved, 'versions').total, 2);
    assert.equal(f.monitors.version(f.project.id, saved.id, 1).query.search.query, 'Synthetic fixture');
    assert.throws(() => f.save({...f.request, requestId: 'stale', monitorId: saved.id, expectedRevision: 1}), /version_changed/);
  } finally {await f.dispose();}
});

test('first successful search establishes baseline; new identities deduplicate and never mutate workflow', async () => {
  const f = scene();
  try {
    const workflow = f.repository.getWorkflow(f.project.id), monitor = f.save();
    const baseline = await f.check(monitor, 'baseline');
    assert.equal(baseline.status, 'complete'); assert.equal(baseline.alertCount, 0);
    assert.equal(f.monitors.checkpoint(monitor, 'crossref').baseline, true);
    const execution = f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(baseline.sources[0].executionId);
    assert.equal(execution.owner, `monitor:${monitor.id}`); assert.equal(execution.project_id, f.project.id);
    assert.equal(baseline.sources[0].requests[0].method, 'GET');
    assert.equal(new Headers(f.calls[0].init.headers).has('authorization'), false);
    f.ids = ['baseline', 'new']; f.advance();
    const second = await f.check(monitor, 'second');
    assert.equal(second.alertCount, 1); assert.equal(f.history(monitor, 'alerts').records[0].identity, 'doi:10.1234/new');
    const calls = f.calls.length;
    assert.deepEqual(await f.check(monitor, 'second'), second); assert.equal(f.calls.length, calls);
    assert.equal((await f.check(monitor)).alertCount, 0); assert.equal(f.history(monitor, 'alerts').total, 1);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
    for (const table of ['research_library', 'research_evidence', 'research_artifacts'])
      assert.equal(f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
    const alerts = f.history(monitor, 'alerts').records;
    assert.throws(() => f.monitors.acknowledge({projectId: f.project.id, monitorId: monitor.id,
      alertId: alerts[0].id, expectedRevision: 0}), /human_required/);
    const ack = f.human('acknowledge', () => f.monitors.acknowledge({projectId: f.project.id,
      monitorId: monitor.id, alertId: alerts[0].id, expectedRevision: 0}));
    assert.equal(ack.acknowledgement.actor.id, 'window:7');
    assert.equal(f.history(monitor, 'alerts').records[0].acknowledgement.revision, 1);
    f.ids = []; await f.check(monitor);
    assert.equal(f.history(monitor, 'alerts').total, 1);
  } finally {await f.dispose();}
});

test('incoming update notices and retraction are visible on first check; unknown never clears them', async () => {
  let retracted = true, notices = [notice()];
  const f = scene(url => url.includes('openalex') ? Response.json({id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1234/target', title: 'Synthetic target', is_retracted: retracted}) :
    Response.json({message: {'total-results': notices.length, items: notices}}));
  try {
    const monitor = f.save({...f.request, query: f.target()}), check = await f.check(monitor);
    assert.equal(check.status, 'complete'); assert.equal(check.alertCount, 2);
    const correction = f.history(monitor, 'alerts').records.find(value => value.kind === 'correction');
    assert.equal(correction.subjectDoi, '10.1234/target'); assert.equal(correction.noticeDoi, '10.1234/notice');
    const url = new URL(f.calls[1].url);
    assert.equal(url.searchParams.get('filter'), 'updates:10.1234/target');
    assert.equal(url.searchParams.get('rows'), '100');
    retracted = false; notices = []; f.advance();
    assert.equal((await f.check(monitor)).alertCount, 0);
    assert.equal(f.history(monitor, 'alerts').total, 2);
    assert.throws(() => api.readMonitorUpdates('crossref', '10.1234/target', 0, {message: {
      'total-results': 1, items: [{...notice(), 'update-to': [{...notice()['update-to'][0], DOI: '10.1234/foreign'}]}]
    }}), /identity_mismatch/);
  } finally {await f.dispose();}
});

test('search safety observations survive first baseline and the same new DOI across providers creates one alert', async () => {
  let ids = ['baseline'], retracted = true;
  const f = scene(url => url.includes('openalex') ? Response.json({meta: {count: ids.length},
    results: ids.map((id, index) => ({id: `https://openalex.org/W${index + 1}`, title: `Synthetic ${id}`,
      doi: `https://doi.org/10.1234/${id}`, is_retracted: retracted, authorships: []}))}) : Response.json(crossref(ids)));
  try {
    const monitor = f.save({...f.request, query: {kind: 'search', search: {...f.request.query.search, sources: ['openalex', 'crossref']}}});
    assert.equal((await f.check(monitor)).alertCount, 1);
    assert.equal(f.history(monitor, 'alerts').records[0].kind, 'retraction');
    retracted = false; ids = ['baseline', 'new']; f.advance();
    const second = await f.check(monitor);
    assert.equal(second.status, 'complete'); assert.equal(second.alertCount, 1);
    assert.equal(f.history(monitor, 'alerts').total, 2);
    assert.equal((await f.check(monitor)).alertCount, 0);
  } finally {await f.dispose();}
});

test('archiving or target revision drift blocks new reads, and a transactional source drift rolls back alerts and checkpoints', async () => {
  const f = scene();
  try {
    const monitor = f.save(); await f.check(monitor);
    f.ids = ['baseline', 'new']; f.advance();
    f.db.exec(`CREATE TRIGGER monitor_insert_drift AFTER INSERT ON research_monitor_alerts BEGIN
      UPDATE research_monitors SET revision=revision+1 WHERE id=NEW.monitor_id;
    END;`);
    const failed = await f.check(monitor);
    assert.equal(failed.status, 'failed'); assert.match(failed.errorCode, /storage_invalid/);
    assert.equal(f.history(monitor, 'alerts').total, 0);
    assert.equal(f.monitors.get(f.project.id, monitor.id).revision, monitor.revision);
    f.db.exec('DROP TRIGGER monitor_insert_drift');
    assert.equal((await f.check(monitor)).alertCount, 1);
    const target = f.target(), updates = f.save({...f.request, requestId: 'updates', query: target});
    f.db.prepare('UPDATE research_library SET revision=revision+1 WHERE id=?').run(target.itemId);
    const calls = f.calls.length;
    await assert.rejects(f.check(updates), /target_changed/); assert.equal(f.calls.length, calls);
    assert.equal(f.history(updates, 'versions').total, 1);
  } finally {await f.dispose();}
});

test('provider full pages advance checkpoint only after validation, with stable notice dedup', async () => {
  let page = Array.from({length: 100}, (_, index) => notice('correction', `10.1234/n${index}`));
  const f = scene(url => url.includes('openalex') ? Response.json({id: 'https://openalex.org/W1',
    doi: '10.1234/target', title: 'Synthetic target', is_retracted: false}) :
    Response.json({message: {'total-results': 101, items: page}}));
  try {
    const monitor = f.save({...f.request, query: f.target()});
    assert.equal((await f.check(monitor)).alertCount, 100);
    assert.equal(f.monitors.checkpoint(monitor, 'crossref').offset, 100);
    assert.equal(f.history(monitor, 'alerts').records.length, 20);
    assert.equal(f.history(monitor, 'alerts').nextOffset, 20);
    page = [notice('correction', '10.1234/n100')]; f.advance();
    assert.equal((await f.check(monitor)).alertCount, 1);
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get('offset'), '100');
    assert.equal(f.monitors.checkpoint(monitor, 'crossref').offset, 0);
    page = [notice('correction', '10.1234/n0')]; f.advance();
    assert.equal((await f.check(monitor)).alertCount, 0);
    assert.equal(f.history(monitor, 'alerts').total, 101);
  } finally {await f.dispose();}
});

test('429/schema failures retain per-source receipts without advancing failed checkpoints', async () => {
  let mode = '429';
  const f = scene(url => url.includes('openalex') ? Response.json({id: 'https://openalex.org/W1',
    doi: '10.1234/target', title: 'Synthetic target', is_retracted: true}) : mode === '429' ?
    new Response('', {status: 429, headers: {'retry-after': '1'}}) : Response.json({message: {items: [{DOI: 'bad'}]}}));
  try {
    const monitor = f.save({...f.request, query: f.target()}), first = await f.check(monitor);
    assert.equal(first.status, 'partial'); assert.equal(first.alertCount, 1);
    assert.match(first.sources[1].errorCode, /429/);
    assert.deepEqual(f.monitors.checkpoint(monitor, 'crossref'), {baseline: false, offset: 0});
    mode = 'schema'; f.advance();
    const changed = await f.check(monitor);
    assert.equal(changed.status, 'partial'); assert.equal(changed.alertCount, 0);
    assert.equal(changed.sources[1].material, null); assert.equal(changed.sources[1].status, 'error');
    assert.deepEqual(f.monitors.checkpoint(monitor, 'crossref'), {baseline: false, offset: 0});
  } finally {await f.dispose();}
});

test('cancel records terminal state; pause and query changes fence active results', async () => {
  let release, started;
  let gate = new Promise(resolve => {started = resolve;});
  const f = scene((_url, init) => new Promise((resolve, reject) => {
    release = () => resolve(Response.json(crossref()));
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
    started();
  }));
  try {
    let monitor = f.save();
    const pending = f.check(monitor, 'pending');
    await gate;
    const running = f.history(monitor, 'checks').records[0];
    assert.equal(running.status, 'running');
    assert.throws(() => f.service.cancel({projectId: f.project.id, monitorId: monitor.id, checkId: running.id}), /human_required/);
    assert.deepEqual(f.human('cancel', () => f.service.cancel({projectId: f.project.id, monitorId: monitor.id, checkId: running.id})), {cancelled: true});
    assert.equal((await pending).status, 'cancelled');
    assert.equal(f.history(monitor, 'alerts').total, 0);
    gate = new Promise(resolve => {started = resolve;});
    const changed = f.check(monitor, 'change');
    await gate;
    monitor = f.human('control', () => f.service.control({projectId: f.project.id, monitorId: monitor.id,
      requestId: 'pause', expectedRevision: monitor.revision, action: 'pause'}));
    release();
    assert.equal((await changed).status, 'interrupted'); assert.equal(monitor.status, 'paused');
    assert.deepEqual(f.monitors.checkpoint(monitor, 'crossref'), {baseline: false, offset: 0});
    assert.equal(f.monitors.get(f.project.id, monitor.id).status, 'paused');
  } finally {await f.dispose();}
});

test('crash recovery preserves check key, query history and incomplete status without duplicate reads', async () => {
  const f = scene();
  try {
    const monitor = f.save(), started = f.monitors.begin(monitor, 'manual:crash', 'manual', null);
    f.monitors.recover();
    assert.equal(f.monitors.check(f.project.id, monitor.id, started.id).status, 'interrupted');
    const replay = await f.check(monitor, 'crash');
    assert.equal(replay.id, started.id); assert.equal(replay.status, 'interrupted'); assert.equal(f.calls.length, 0);
    assert.equal(f.history(monitor, 'alerts').total, 0);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.equal(f.monitors.schedulable().length, 0);
    assert.equal(f.history(monitor, 'checks').total, 1);
    await assert.rejects(f.check(monitor, 'new'), /project_archived/);
    assert.deepEqual(await f.check(monitor, 'crash'), replay);
  } finally {await f.dispose();}
});

test('physical scope and rehashed query substitution cannot redirect monitor history', async () => {
  const f = scene();
  try {
    const monitor = f.save(), check = await f.check(monitor);
    const foreign = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/roc-monitor-foreign'});
    assert.throws(() => f.monitors.get(foreign.id, monitor.id), /not_found/);
    const altered = api.sealMonitor({...check, monitorId: 'foreign'});
    f.db.prepare('UPDATE research_monitor_checks SET snapshot_json=? WHERE id=?').run(JSON.stringify(altered), check.id);
    assert.throws(() => f.monitors.check(f.project.id, monitor.id, check.id), /storage_invalid/);
    f.db.prepare('UPDATE research_monitor_checks SET snapshot_json=? WHERE id=?').run(JSON.stringify(check), check.id);
    const source = check.sources[0], events = source.material.events.map(value => ({...value, identity: 'doi:10.1234/substitute'}));
    f.db.prepare('UPDATE research_monitor_checks SET snapshot_json=? WHERE id=?').run(JSON.stringify(api.sealMonitor({
      ...check, sources: [{...source, material: {...source.material, events}}]
    })), check.id);
    assert.throws(() => f.monitors.check(f.project.id, monitor.id, check.id), /storage_invalid/);
  } finally {await f.dispose();}
});

test('query changes reset ordinary baseline but retain earlier alerts and historic query source versions', async () => {
  const f = scene();
  try {
    const monitor = f.save(); await f.check(monitor);
    f.ids = ['baseline', 'new']; f.advance(); await f.check(monitor);
    const revised = f.save({...f.request, requestId: 'revised', monitorId: monitor.id, expectedRevision: monitor.revision});
    f.ids.push('other'); f.advance();
    assert.equal((await f.check(revised)).alertCount, 0);
    assert.equal(f.history(monitor, 'alerts').total, 1);
    assert.equal(f.history(monitor, 'checks').records[0].queryVersion, 2);
    assert.equal(f.history(monitor, 'checks').records.at(-1).queryVersion, 1);
  } finally {await f.dispose();}
});

test('durable search history rejects same-project different-query substitution after candidate expiry', async () => {
  const f = scene();
  try {
    const monitor = f.save(), original = await f.check(monitor);
    const other = f.save({...f.request, requestId: 'other', query: {kind: 'search',
      search: {...f.request.query.search, query: 'Different query', yearFrom: 2020}}});
    const replacement = await f.check(other);
    f.db.prepare('DELETE FROM research_literature_searches').run();
    assert.deepEqual(f.monitors.check(f.project.id, monitor.id, original.id), original);
    const substitute = api.sealMonitor({...original, sources: replacement.sources});
    f.db.prepare('UPDATE research_monitor_checks SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify(substitute), original.id);
    assert.throws(() => f.monitors.check(f.project.id, monitor.id, original.id), /storage_invalid/);
    f.db.prepare('UPDATE research_monitor_checks SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify(original), original.id);
    f.db.prepare('UPDATE research_literature_search_executions SET request_json=? WHERE id=?')
      .run(JSON.stringify({request: {...f.request.query.search, projectId: f.project.id, query: 'Substituted'}, strategy: null}),
        original.sources[0].executionId);
    assert.throws(() => f.monitors.check(f.project.id, monitor.id, original.id), /storage_invalid/);
  } finally {await f.dispose();}
});

test('terminal persistence failure propagates both causes and leaves recoverable durable running identity', async () => {
  const f = scene();
  try {
    const monitor = f.save();
    f.db.exec(`CREATE TRIGGER monitor_terminal_failure BEFORE UPDATE ON research_monitor_checks
      WHEN NEW.status!='running' BEGIN SELECT RAISE(ABORT,'synthetic_monitor_storage_fault'); END;`);
    await assert.rejects(f.check(monitor, 'storage-fault'), error => {
      assert.equal(error.message, 'research_monitor_record_failed');
      assert.equal(error.errors.length, 2);
      for (const cause of error.errors) assert.match(cause.message, /synthetic_monitor_storage_fault/);
      return true;
    });
    assert.equal(f.history(monitor, 'checks').records[0].status, 'running');
    assert.equal(f.history(monitor, 'alerts').total, 0);
    assert.deepEqual(f.monitors.checkpoint(monitor, 'crossref'), {baseline: false, offset: 0});
    f.db.exec('DROP TRIGGER monitor_terminal_failure');
    f.monitors.recover();
    const calls = f.calls.length, replay = await f.check(monitor, 'storage-fault');
    assert.equal(replay.status, 'interrupted'); assert.equal(f.calls.length, calls);
  } finally {await f.dispose();}
});

test('migration 58 installs monitors without rewriting earlier observation rows', () => {
  const db = new Database(':memory:');
  try {
    const earlier = api.researchMigrations.filter(migration => migration.version <= 57);
    api.applyDatabaseMigrations(db, {dbName: 'research', migrations: earlier, now: () => timestamp});
    db.prepare(`INSERT INTO research_projects(id,title,description,status,current_stage,created_at,updated_at)
      VALUES (?,?,?,'active','reading',?,?)`).run('retained-project', 'Original project', '', timestamp, timestamp);
    db.prepare(`INSERT INTO research_openreview_observations(id,project_id,request_id,query_json,snapshot_json,created_at)
      VALUES (?,?,?,?,?,?)`).run('retained-observation', 'retained-project', 'original-request',
      '{"kind":"note","id":"original-note"}', '{"original":"observation"}', timestamp);
    const original = db.prepare('SELECT * FROM research_openreview_observations').all();
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyDatabaseMigrations(db, {dbName: 'research',
      migrations: api.researchMigrations.filter(migration => migration.version <= 58)});
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 58);
    assert.deepEqual(db.prepare('SELECT * FROM research_openreview_observations').all(), original);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=57 ORDER BY version').all(), ledger);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'research_monitor%' AND type='table'").all();
    assert.equal(tables.length, 7);
  } finally {db.close();}
});
