import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import {createResearchFixture} from './fixtures/research-test-kit.mjs';

let directory, api;
const timestamp = '2026-11-03T00:00:00.000Z';
const request = {serverId: 'import-instance', library: {kind: 'user', id: 0}, expectedLibraryVersion: null,
  offset: 0, limit: 30, collectionKey: null, since: null};
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-zotero-import-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'api.mjs');
  await esbuild.build({stdin: {contents: `
    export {ResearchRepository} from './src/main/plugins/research/repository';
    export {ResearchTaskRepository} from './src/main/plugins/research/research-task-repository';
    export {applyResearchDatabaseSchema, agentMigrations, researchMigrations} from './src/main/infrastructure/database-schemas';
    export {applyDatabaseMigrations} from './src/main/infrastructure/database-migrations';
    export {LiteratureImportService} from './src/main/plugins/research/literature-import-service';
    export {ResearchLibraryService} from './src/main/plugins/research/library-service';
    export {readResearchBibliography} from './src/main/plugins/research/bibliography';
    export {ZoteroAdapter} from './src/main/plugins/research/zotero-adapter';
    export {withLiteratureContext} from './src/main/services/literature-context';
    export {registerZoteroCapabilities} from './src/main/plugins/research/zotero-capabilities';
    export {registerLiteratureImportCapabilities} from './src/main/plugins/research/literature-import-capabilities';
    export {createPluginCapabilityAdapter} from './src/main/ipc/plugin-capability-adapter';
  `, resolveDir: process.cwd()}, outfile, bundle: true, packages: 'external', platform: 'node',
    format: 'esm', loader: {'.md': 'text'}, logLevel: 'silent'});
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));
function item(key, overrides = {}) {
  const title = overrides.title ?? `Synthetic ${key}`;
  const doi = overrides.doi ?? '10.1234/SAME';
  const version = overrides.version ?? 8;
  const csl = {id: key, type: 'article-journal', title, DOI: doi, author: [{literal: 'Synthetic Author'}],
    issued: {'date-parts': [[2024, 2, 3]]}, 'container-title': 'Journal of Synthetic Data', volume: '5', issue: '2', page: '1-4'};
  return {key, version, data: {key, version, itemType: 'journalArticle', title, DOI: doi,
    creators: [{creatorType: 'author', name: 'Synthetic Author'}], tags: [{tag: 'external-tag'}],
    collections: ['COLL2345'], unknownFutureField: {retained: true}}, csljson: JSON.stringify([csl])};
}
function fixture(initial, schemaApi = api) {
  const f = createResearchFixture(schemaApi);
  let source = initial, time = timestamp, workerCalls = 0;
  const urls = [], events = [];
  const adapter = new api.ZoteroAdapter(async (url, init) => {
    urls.push(url);
    assert.equal(init.method, 'GET');
    const key = new URL(url).pathname.match(/\/items\/([A-Z0-9]{8})$/u)?.[1];
    if (key !== undefined) {
      const found = source.find(item => item.key === key);
      const headers = {'Zotero-API-Version': '3', 'Zotero-Server-ID': request.serverId, 'Zotero-Schema-Version': '40'};
      return found === undefined ? new Response('Not found', {status: 404, headers}) :
        Response.json(found, {headers: {...headers, 'Last-Modified-Version': String(found.version)}});
    }
    return Response.json(source, {headers: {'Zotero-API-Version': '3', 'Zotero-Server-ID': request.serverId,
      'Zotero-Schema-Version': '40', 'Last-Modified-Version': '20', 'Total-Results': String(source.length)}});
  }, () => time);
  const library = new api.ResearchLibraryService(f.repository.library, {
    async readBibliography(input) {
      workerCalls++;
      return (await api.readResearchBibliography(input)).entries;
    }
  }, join(directory, `jobs-${crypto.randomUUID()}`));
  const service = new api.LiteratureImportService(f.db, f.repository.library, {}, library,
    async event => {events.push(structuredClone(event));}, () => time);
  const context = {owner: 'thread:zotero', projectId: f.project.id};
  const run = (operation, overrides = {}) => api.withLiteratureContext({...context, ...overrides}, operation);
  return {...f, library, service, adapter, urls, events, workerCalls: () => workerCalls,
    setSource: value => {source = value;}, setTime: value => {time = value;}, run,
    async preview() {return run(() => service.previewZotero(request, adapter));},
    async add(preview, keys, requestId) {return run(() => service.add({requestId,
      entries: keys.map(itemKey => ({kind: 'zotero', previewId: preview.previewId, itemKey}))}));},
    async dispose() {await service.shutdown(); await library.shutdown(); await adapter.shutdown(); f.close();}
  };
}

test('same DOI objects have independent mappings; real CSL codec preserves journal fields and idempotent replay', async () => {
  const originals = [item('ITEM2345'), item('ITEM6789')];
  const f = fixture(originals);
  try {
    const preview = await f.preview();
    assert.equal(new URL(f.urls[0]).searchParams.get('include'), 'data,csljson');
    assert.equal(preview.schemaVersion, 2);
    const result = await f.add(preview, originals.map(value => value.key), 'zotero-first');
    assert.equal(result.status, 'completed');
    assert.equal(result.counts.created, 1);
    assert.equal(result.counts.alreadyPresent, 1);
    assert.equal(result.requestedCount, 2);
    assert.notEqual(result.items[0].entryKey, result.items[1].entryKey);
    assert.equal(result.items[0].libraryItemId, result.items[1].libraryItemId);
    const saved = f.repository.library.get(result.items[0].libraryItemId);
    assert.equal(saved.metadata.source, 'zotero');
    assert.equal(saved.metadata.doi, '10.1234/same');
    assert.equal(saved.bibliography.fields.journal, 'Journal of Synthetic Data');
    assert.equal(saved.bibliography.fields.volume, '5');
    assert.equal(saved.bibliography.publishedYear, 2024);
    assert.equal(saved.sources.length, 2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_objects').pluck().get(), 2);
    const sources = f.run(() => f.service.readZoteroSources({id: saved.id, limit: 1}));
    assert.equal(sources.total, 2);
    assert.equal(sources.nextOffset, 1);
    assert.deepEqual(sources.records[0].item, originals[0]);
    assert.equal(sources.records[0].operationId, result.operationId);
    assert.equal(sources.records[0].libraryVersion, 20);
    assert.equal(f.run(() => f.service.readZoteroSources({id: saved.id, offset: 1})).records[0].itemKey, originals[1].key);
    assert.equal(f.run(() => f.service.readZoteroSources({id: saved.id}), {owner: 'thread:other'}).total, 0);
    const before = f.db.prepare('SELECT * FROM research_library').all();
    const replay = await f.add(preview, originals.map(value => value.key), 'zotero-first');
    assert.deepEqual(replay, result);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.workerCalls(), 2);
    assert.equal(f.urls.length, 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_object_versions').pluck().get(), 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.dispose();}
});

test('owned remote observations report present, collection changes, trash and not-found without deleting or rewriting local data', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    const imported = await f.add(preview, [original.key], 'source-state-import');
    const input = {...preview.sourcePage, operationId: imported.operationId, itemKey: original.key, collectionKey: 'COLL2345'};
    const source = {serverId: input.serverId, library: input.library, operationId: input.operationId,
      itemKey: input.itemKey, collectionKey: input.collectionKey};
    const before = f.db.prepare('SELECT * FROM research_library').all();
    const mappings = f.db.prepare('SELECT * FROM research_zotero_objects').all();
    assert.equal(f.run(() => f.service.readZoteroSourceState(source)), null);
    const first = await f.run(() => f.service.observeZoteroSource(source, f.adapter));
    assert.equal(first.remote.status, 'present');
    assert.equal(first.remote.objectVersion, 8);
    assert.equal('libraryVersion' in first.remote, false);
    assert.equal(first.membership, 'listed');
    assert.equal(first.versionState, 'unchanged');
    assert.deepEqual(f.run(() => f.service.readZoteroSourceState(source)), first);
    const updated = item(original.key, {version: 9});
    updated.data.collections = [];
    f.setSource([updated]);
    const removed = await f.run(() => f.service.observeZoteroSource(source, f.adapter));
    assert.equal(removed.membership, 'not_listed');
    assert.equal(removed.versionState, 'newer');
    updated.data.deleted = true;
    f.setSource([updated]);
    const trash = await f.run(() => f.service.observeZoteroSource(source, f.adapter));
    assert.equal(trash.remote.status, 'trashed');
    assert.equal(trash.membership, 'unknown');
    f.setSource([]);
    f.setTime('2026-11-12T00:00:00.000Z');
    const missing = await f.run(() => f.service.observeZoteroSource(source, f.adapter));
    assert.equal(missing.remote.status, 'not_found');
    assert.equal(missing.remote.objectVersion, null);
    assert.equal(missing.versionState, 'missing');
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_zotero_objects').all(), mappings);
    assert.equal(f.workerCalls(), 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get(), 4);
    assert.deepEqual(f.run(() => f.service.readZoteroSourceState(source)), missing);
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    f.run(() => f.service.readZoteroSourceState(source));
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
  } finally {await f.dispose();}
});

test('source observations retain version regression and same-version field conflict; child membership stays unknown and invalid fields fail', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    const imported = await f.add(preview, [original.key], 'source-versions');
    const source = {serverId: request.serverId, library: request.library, operationId: imported.operationId,
      itemKey: original.key, collectionKey: 'COLL2345'};
    const reversed = structuredClone(original);
    reversed.data = Object.fromEntries(Object.entries(reversed.data).reverse());
    f.setSource([reversed]);
    assert.equal((await f.run(() => f.service.observeZoteroSource(source, f.adapter))).versionState, 'unchanged');
    f.setSource([item(original.key, {title: 'Different same version'})]);
    assert.equal((await f.run(() => f.service.observeZoteroSource(source, f.adapter))).versionState, 'version_conflict');
    f.setSource([item(original.key, {version: 7})]);
    assert.equal((await f.run(() => f.service.observeZoteroSource(source, f.adapter))).versionState, 'regressed');
    const child = item(original.key, {version: 9});
    child.data.itemType = 'attachment'; child.data.parentItem = 'PARENT00'; delete child.data.collections;
    f.setSource([child]);
    assert.equal((await f.run(() => f.service.observeZoteroSource(source, f.adapter))).membership, 'unknown');
    const malformed = item(original.key, {version: 9});
    malformed.data.collections = 'invalid';
    f.setSource([malformed]);
    const count = f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get();
    await assert.rejects(f.run(() => f.service.observeZoteroSource(source, f.adapter)), /zotero_response_invalid/u);
    delete malformed.data.collections;
    await assert.rejects(f.run(() => f.service.observeZoteroSource(source, f.adapter)), /zotero_response_invalid/u);
    malformed.data.deleted = 1;
    await assert.rejects(f.run(() => f.service.observeZoteroSource(source, f.adapter)), /zotero_response_invalid/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get(), count);
    assert.equal(f.workerCalls(), 1);
  } finally {await f.dispose();}
});

test('source state bridge requires owned import receipts before HTTP and rejects damaged stored observations', async () => {
  const f = fixture([item('ITEM2345')]);
  try {
    const handlers = new Map();
    const context = {pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
    api.registerZoteroCapabilities(context, f.adapter, f.service);
    api.registerLiteratureImportCapabilities(context, f.service);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    const preview = (await bridge.invoke('research.previewZotero', [{...request, projectId: f.project.id}], 9)).data;
    const imported = (await bridge.invoke('research.addLiterature', [{projectId: f.project.id, requestId: 'source-bridge',
      entries: [{kind: 'zotero', previewId: preview.previewId, itemKey: 'ITEM2345'}]}], 9)).data;
    const source = {serverId: request.serverId, library: request.library, operationId: imported.operationId,
      itemKey: 'ITEM2345', collectionKey: null, projectId: f.project.id};
    const observed = await bridge.invoke('research.observeZoteroSource', [source], 9);
    assert.equal(observed.ok, true, JSON.stringify(observed));
    const calls = f.urls.length;
    for (const [input, windowId] of [[source, 10], [{...source, projectId: null}, 9], [{...source, operationId: 'missing'}, 9]]) {
      const refusal = await bridge.invoke('research.observeZoteroSource', [input], windowId);
      assert.equal(refusal.error.code, 'zotero_source_observation_not_found');
    }
    assert.equal(f.urls.length, calls);
    const read = await bridge.invoke('research.readZoteroSourceState', [source], 9);
    assert.deepEqual(read, observed);
    assert.equal(f.urls.length, calls);
    const corrupt = {...observed.data, versionState: 'regressed'};
    f.db.prepare('UPDATE research_zotero_source_states SET state_json=? WHERE id=?')
      .run(JSON.stringify(corrupt), observed.data.stateId);
    const damaged = await bridge.invoke('research.readZoteroSourceState', [source], 9);
    assert.equal(damaged.error.code, 'zotero_source_state_storage_invalid');
    assert.equal(damaged.error.retryable, false);
  } finally {await f.dispose();}
});

test('DB15 to16 preserves actual import provenance and migration receipts without inventing source state', async () => {
  const prior = {...api, applyResearchDatabaseSchema(db, now) {
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(row => row.version <= 15), now});
  }};
  const f = fixture([item('ITEM2345')], prior);
  try {
    const preview = await f.preview();
    const imported = await f.add(preview, ['ITEM2345'], 'pre-state-migration');
    const before = f.db.prepare('SELECT * FROM research_library').all();
    const versions = f.db.prepare('SELECT * FROM research_zotero_object_versions').all();
    const receipts = f.db.prepare('SELECT * FROM schema_migrations WHERE db_name=? ORDER BY version').all('plugin:@roc/plugin-research');
    api.applyResearchDatabaseSchema(f.db, () => '2026-11-12T00:00:00.000Z');
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_zotero_object_versions').all(), versions);
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE db_name=? AND version<=15 ORDER BY version').all('plugin:@roc/plugin-research'), receipts);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get(), 0);
    const input = {serverId: request.serverId, library: request.library, operationId: imported.operationId, itemKey: 'ITEM2345', collectionKey: null};
    assert.equal((await f.run(() => f.service.observeZoteroSource(input, f.adapter))).remote.status, 'present');
  } finally {await f.dispose();}
});

test('transport and observation-write failures never become not-found or replace the last valid state', async () => {
  const f = fixture([item('ITEM2345')]);
  const lost = new api.ZoteroAdapter(async () => {throw new Error('Synthetic lost transport');});
  try {
    const preview = await f.preview();
    const imported = await f.add(preview, ['ITEM2345'], 'state-failures');
    const source = {serverId: request.serverId, library: request.library, operationId: imported.operationId,
      itemKey: 'ITEM2345', collectionKey: null};
    const first = await f.run(() => f.service.observeZoteroSource(source, f.adapter));
    await assert.rejects(f.run(() => f.service.observeZoteroSource(source, lost)), /zotero_unreachable/u);
    assert.deepEqual(f.run(() => f.service.readZoteroSourceState(source)), first);
    f.db.exec(`CREATE TRIGGER refuse_source_state BEFORE INSERT ON research_zotero_source_states
      BEGIN SELECT RAISE(ABORT,'synthetic source state failure'); END;`);
    await assert.rejects(f.run(() => f.service.observeZoteroSource(source, f.adapter)), /synthetic source state failure/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get(), 1);
    assert.deepEqual(f.run(() => f.service.readZoteroSourceState(source)), first);
    f.db.exec('DROP TRIGGER refuse_source_state');
  } finally {await lost.shutdown(); await f.dispose();}
});

test('shutdown cancels a pending source response and forbids late observation publication', async () => {
  const f = fixture([item('ITEM2345')]);
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  const streaming = new api.ZoteroAdapter(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      init.signal.addEventListener('abort', () => controller.error(new Error('Synthetic aborted body')), {once: true});
      entered();
    }
  }), {headers: {'Zotero-API-Version': '3', 'Zotero-Server-ID': request.serverId,
    'Zotero-Schema-Version': '40', 'Last-Modified-Version': '8'}}));
  try {
    const preview = await f.preview();
    const imported = await f.add(preview, ['ITEM2345'], 'state-shutdown');
    const source = {serverId: request.serverId, library: request.library, operationId: imported.operationId,
      itemKey: 'ITEM2345', collectionKey: null};
    const pending = f.run(() => f.service.observeZoteroSource(source, streaming));
    const refused = assert.rejects(pending, /zotero_cancelled/u);
    await started;
    await f.service.shutdown();
    await refused;
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_source_states').pluck().get(), 0);
  } finally {await streaming.shutdown(); await f.dispose();}
});

test('actual preload bridge imports a scoped preview and reads durable sources only for the same sender/project', async () => {
  const f = fixture([item('ITEM2345')]);
  try {
    const handlers = new Map();
    const context = {pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {
      handlers.set(descriptor.name, handler);
    }}};
    api.registerZoteroCapabilities(context, f.adapter, f.service);
    api.registerLiteratureImportCapabilities(context, f.service);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    const preview = await bridge.invoke('research.previewZotero', [{...request, projectId: f.project.id}], 88);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const added = await bridge.invoke('research.addLiterature', [{projectId: f.project.id, requestId: 'bridge-source-import',
      entries: [{kind: 'zotero', previewId: preview.data.previewId, itemKey: 'ITEM2345'}]}], 88);
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.data.counts.created, 1);
    const input = {id: added.data.items[0].libraryItemId, projectId: f.project.id};
    const sources = await bridge.invoke('research.getZoteroSources', [input], 88);
    assert.equal(sources.ok, true, JSON.stringify(sources));
    assert.equal(sources.data.total, 1);
    assert.equal(sources.data.records[0].operationId, added.data.operationId);
    assert.deepEqual(sources.data.records[0].item, item('ITEM2345'));
    const reviewInput = {previewId: preview.data.previewId, itemKeys: ['ITEM2345'], projectId: f.project.id};
    const reviewed = await bridge.invoke('research.reviewZotero', [reviewInput], 88);
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.equal(reviewed.data.items[0].objectState, 'unchanged');
    assert.equal(reviewed.data.items[0].previousScopedSource.operationId, added.data.operationId);
    const foreignReview = await bridge.invoke('research.reviewZotero', [reviewInput], 89);
    assert.equal(foreignReview.ok, false);
    assert.equal(foreignReview.error.code, 'zotero_preview_not_found');
    for (const [requestInput, windowId] of [[input, 89], [{...input, projectId: null}, 88]]) {
      const result = await bridge.invoke('research.getZoteroSources', [requestInput], windowId);
      assert.equal(result.ok, true);
      assert.equal(result.data.total, 0);
    }
    const replay = await bridge.invoke('research.addLiterature', [{projectId: f.project.id, requestId: 'bridge-source-import',
      entries: [{kind: 'zotero', previewId: preview.data.previewId, itemKey: 'ITEM2345'}]}], 88);
    assert.deepEqual(replay, added);
    assert.equal(f.workerCalls(), 1);
  } finally {await f.dispose();}
});

test('read-only Zotero review retains both field values, originals and local notes without worker or database writes', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const first = await f.preview();
    const initial = f.run(() => f.service.reviewZotero({previewId: first.previewId, itemKeys: [original.key]}));
    assert.equal(initial.items[0].objectState, 'new');
    assert.equal(initial.items[0].local, null);
    const imported = await f.add(first, [original.key], 'review-first');
    const id = imported.items[0].libraryItemId;
    const bibliography = f.repository.library.get(id).bibliography;
    bibliography.fields.note = 'User-owned local note';
    bibliography.fields.keywords = 'user-owned-keyword';
    f.db.prepare('UPDATE research_library SET bibliography_json=? WHERE id=?').run(JSON.stringify(bibliography), id);
    const updated = item(original.key, {title: 'Changed synthetic title', version: 9});
    f.setSource([updated]);
    const preview = await f.preview();
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    const urls = f.urls.length, workerCalls = f.workerCalls();
    const review = f.run(() => f.service.reviewZotero({previewId: preview.previewId, itemKeys: [original.key]}));
    assert.equal(review.policy, 'retain_existing_fill_missing');
    assert.equal(review.items[0].objectState, 'new_version');
    assert.equal(review.items[0].mappedVersion, 8);
    assert.deepEqual(review.items[0].differences, [{field: 'title', source: updated.data.title, local: original.data.title}]);
    assert.deepEqual(review.items[0].source.item, updated);
    assert.deepEqual(review.items[0].previousScopedSource.item, original);
    assert.equal(review.items[0].local.id, id);
    assert.equal(review.items[0].local.bibliography.fields.note, 'User-owned local note');
    assert.equal(review.items[0].local.bibliography.fields.keywords, 'user-owned-keyword');
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    assert.equal(f.urls.length, urls);
    assert.equal(f.workerCalls(), workerCalls);
    assert.throws(() => f.run(() => f.service.reviewZotero({previewId: preview.previewId, itemKeys: [original.key, original.key]})), /zotero_review_duplicate_key/u);
    const importedUpdate = await f.add(preview, [original.key], 'review-update');
    assert.equal(importedUpdate.status, 'completed');
    assert.equal(f.repository.library.get(id).metadata.title, original.data.title);
    assert.equal(f.repository.library.get(id).bibliography.fields.note, 'User-owned local note');
  } finally {await f.dispose();}
});

test('Zotero review reveals version and object-identity conflicts while prior source originals remain scope isolated', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const old = await f.preview();
    await f.add(old, [original.key], 'review-state-first');
    f.setSource([item(original.key, {title: 'Conflicting same version'})]);
    const conflicting = await f.preview();
    const read = preview => f.run(() => f.service.reviewZotero({previewId: preview.previewId, itemKeys: [original.key]}));
    assert.equal(read(conflicting).items[0].objectState, 'version_conflict');
    assert.deepEqual(read(conflicting).items[0].previousScopedSource.item, original);
    f.setSource([item(original.key, {doi: '10.1234/different', version: 9})]);
    const different = await f.preview();
    assert.equal(read(different).items[0].objectState, 'identity_changed');
    f.setSource([item(original.key, {version: 9})]);
    const next = await f.preview();
    await f.add(next, [original.key], 'review-state-next');
    assert.equal(read(old).items[0].objectState, 'version_regressed');
    assert.equal(read(next).items[0].objectState, 'unchanged');
    const scope = {owner: 'thread:another', projectId: null};
    const foreign = await f.run(() => f.service.previewZotero(request, f.adapter), scope);
    const foreignReview = f.run(() => f.service.reviewZotero({previewId: foreign.previewId, itemKeys: [original.key]}), scope);
    assert.equal(foreignReview.items[0].objectState, 'unchanged');
    assert.equal(foreignReview.items[0].mappedVersion, 9);
    assert.equal(foreignReview.items[0].previousScopedSource, null);
    f.setSource([original]);
    const olderForeign = await f.run(() => f.service.previewZotero(request, f.adapter), scope);
    const olderReview = f.run(() => f.service.reviewZotero({previewId: olderForeign.previewId, itemKeys: [original.key]}), scope);
    assert.equal(olderReview.items[0].objectState, 'version_regressed');
    assert.equal(olderReview.items[0].mappedVersion, 9);
    assert.equal(olderReview.items[0].previousScopedSource, null);
    assert.throws(() => f.run(() => f.service.reviewZotero({previewId: next.previewId, itemKeys: [original.key]}), scope), /zotero_preview_not_found/u);
  } finally {await f.dispose();}
});

test('Zotero review reads the latest scoped receipt beyond the source API page and refuses damaged originals', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    let latest;
    for (let index = 0; index < 55; index++) {
      f.setTime(new Date(Date.parse(timestamp) + index * 1000).toISOString());
      latest = await f.add(preview, [original.key], `review-many-${index}`);
    }
    const read = () => f.run(() => f.service.reviewZotero({previewId: preview.previewId, itemKeys: [original.key]}));
    assert.equal(read().items[0].previousScopedSource.operationId, latest.operationId);
    assert.equal(f.workerCalls(), 1);
    f.db.prepare('UPDATE research_zotero_object_versions SET item_json=?').run(JSON.stringify({...original, version: 9}));
    assert.throws(read, /zotero_object_storage_invalid/u);
  } finally {await f.dispose();}
});

test('Zotero review capability reports ambiguous canonical identity as a nonretryable conflict', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    await f.add(preview, [original.key], 'review-ambiguous-first');
    const otherItem = item('ITEM6789');
    delete otherItem.data.DOI;
    const csl = JSON.parse(otherItem.csljson);
    delete csl[0].DOI;
    otherItem.csljson = JSON.stringify(csl);
    f.setSource([otherItem]);
    const otherPreview = await f.preview();
    const other = await f.add(otherPreview, ['ITEM6789'], 'review-ambiguous-other');
    f.db.prepare('INSERT INTO research_library_aliases(item_id,identity) VALUES (?,?)')
      .run(other.items[0].libraryItemId, 'doi:10.1234/same');
    const handlers = new Map();
    api.registerZoteroCapabilities({pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {
      handlers.set(descriptor.name, handler);
    }}}, f.adapter, f.service);
    await assert.rejects(f.run(() => handlers.get('research.zotero.review')({
      projectId: f.project.id, previewId: preview.previewId, itemKeys: [original.key]
    })), error => error.code === 'research_literature_identity_ambiguous' && error.category === 'conflict' && error.retryable === false);
  } finally {await f.dispose();}
});

test('new object versions retain original tags/collections and local user bibliography fields; source history outlives previews', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const first = await f.add(await f.preview(), [original.key], 'version-first');
    const id = first.items[0].libraryItemId;
    const current = f.repository.library.get(id);
    const bibliography = {...current.bibliography, fields: {...current.bibliography.fields,
      note: 'Local user note', keywords: 'Local user tags'}};
    f.db.prepare('UPDATE research_library SET bibliography_json=? WHERE id=?').run(JSON.stringify(bibliography), id);
    const updated = item(original.key, {version: 9});
    updated.data.tags = [{tag: 'new external tag'}];
    updated.data.collections = [];
    f.setSource([updated]);
    const second = await f.add(await f.preview(), [original.key], 'version-second');
    assert.equal(second.items[0].libraryItemId, id);
    assert.equal(f.repository.library.get(id).bibliography.fields.note, 'Local user note');
    assert.equal(f.repository.library.get(id).bibliography.fields.keywords, 'Local user tags');
    const sources = f.run(() => f.service.readZoteroSources({id}));
    assert.deepEqual(sources.records.map(value => value.item), [original, updated]);
    assert.equal(f.db.prepare('SELECT object_version FROM research_zotero_objects').pluck().get(), 9);
    f.setTime('2026-11-11T00:00:00.000Z');
    assert.equal(f.run(() => f.service.readZoteroSources({id})).records.length, 2);
    assert.equal((await f.add({previewId: sources.records[0].previewId}, [original.key], 'version-first')).operationId, first.operationId);
    const corrupt = {...updated, data: {...updated.data, title: 'Corrupt raw storage'}};
    f.db.prepare('UPDATE research_zotero_object_versions SET item_json=? WHERE object_version=9').run(JSON.stringify(corrupt));
    assert.throws(() => f.run(() => f.service.readZoteroSources({id})), /zotero_object_storage_invalid/u);
  } finally {await f.dispose();}
});

test('version regression/conflicting same-version payload and foreign preview refuse before creating an import job', async () => {
  const original = item('ITEM2345', {version: 9});
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    await f.add(preview, [original.key], 'baseline');
    const rows = () => f.db.prepare('SELECT * FROM research_library').all();
    const before = rows();
    f.setSource([item(original.key, {version: 8})]);
    await assert.rejects(f.add(await f.preview(), [original.key], 'regressed'), /zotero_object_version_regressed/u);
    const changed = {...original, data: {...original.data, tags: [{tag: 'changed without version'}]}};
    f.setSource([changed]);
    await assert.rejects(f.add(await f.preview(), [original.key], 'conflicting'), /zotero_object_version_conflict/u);
    await assert.rejects(f.run(() => f.service.add({requestId: 'foreign', entries: [{kind: 'zotero',
      previewId: preview.previewId, itemKey: original.key}]}), {owner: 'thread:foreign'}), /zotero_preview_not_found/u);
    assert.deepEqual(rows(), before);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_literature_imports').pluck().get(), 1);
    assert.equal(f.workerCalls(), 1);
  } finally {await f.dispose();}
});

test('CSL mismatch is a partial failure; changed mapped DOI rolls back the new paper and original object binding', async () => {
  const good = item('ITEM2345'), bad = item('ITEM6789');
  const badCsl = JSON.parse(bad.csljson); badCsl[0].title = 'Wrong CSL paper'; bad.csljson = JSON.stringify(badCsl);
  const f = fixture([good, bad]);
  try {
    const result = await f.add(await f.preview(), [good.key, bad.key], 'partial');
    assert.equal(result.status, 'partial');
    assert.equal(result.items[1].errorCode, 'zotero_csl_metadata_mismatch');
    assert.equal(result.items[1].retryable, false);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_objects').pluck().get(), 1);
    const before = f.db.prepare('SELECT * FROM research_library').all();
    const binding = f.db.prepare('SELECT * FROM research_zotero_objects').all();
    f.setSource([item(good.key, {version: 9, doi: '10.1234/other'})]);
    const conflict = await f.add(await f.preview(), [good.key], 'changed-identity');
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.items[0].errorCode, 'zotero_object_identity_changed');
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_zotero_objects').all(), binding);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_object_versions').pluck().get(), 1);
  } finally {await f.dispose();}
});

test('object-history write failure atomically rolls back library/source/result success, and notes cannot become papers', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    f.db.exec("CREATE TRIGGER refuse_zotero_history BEFORE INSERT ON research_zotero_object_versions BEGIN SELECT RAISE(ABORT,'zotero_fixture_disk_error'); END");
    const result = await f.add(preview, [original.key], 'write-failure');
    assert.equal(result.status, 'failed');
    assert.equal(result.items[0].libraryItemId, null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_objects').pluck().get(), 0);
    const note = {...original, data: {...original.data, itemType: 'note', note: 'External user note'}};
    f.setSource([note]);
    await assert.rejects(f.add(await f.preview(), [note.key], 'note'), /zotero_item_not_bibliographic/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_literature_imports').pluck().get(), 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.dispose();}
});

test('duplicate selection collapses one object, archived papers stay archived, and old preview projections are refused', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    const result = await f.add(preview, [original.key, original.key], 'duplicate');
    assert.equal(result.requestedCount, 1);
    assert.deepEqual(result.items[0].inputPositions, [0, 1]);
    const saved = f.repository.library.get(result.items[0].libraryItemId);
    f.repository.library.archive(saved.id, saved.revision, true);
    const next = await f.add(preview, [original.key], 'archived');
    assert.equal(next.items[0].disposition, 'skipped_archived');
    assert.equal(f.repository.library.get(saved.id).archived, true);
    assert.equal(f.run(() => f.service.readZoteroSources({id: saved.id})).total, 1);
    const row = JSON.parse(f.db.prepare('SELECT snapshot_json FROM research_zotero_previews WHERE id=?').pluck().get(preview.previewId));
    row.schemaVersion = 1; delete row.projection;
    f.db.prepare('UPDATE research_zotero_previews SET snapshot_json=? WHERE id=?').run(JSON.stringify(row), preview.previewId);
    assert.throws(() => f.run(() => f.service.readZoteroPreview({previewId: preview.previewId})), /zotero_preview_storage_invalid/u);
  } finally {await f.dispose();}
});

test('cancelled CSL work cannot create a paper or object mapping when the worker returns late', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  let release, started;
  const received = new Promise(resolve => {started = resolve;});
  const lateLibrary = new api.ResearchLibraryService(f.repository.library, {
    async readBibliography(input) {
      const entries = (await api.readResearchBibliography(input)).entries;
      started();
      await new Promise(resolve => {release = resolve;});
      return entries;
    }
  }, join(directory, `cancel-jobs-${crypto.randomUUID()}`));
  const service = new api.LiteratureImportService(f.db, f.repository.library, {}, lateLibrary, async () => {});
  try {
    const preview = await f.preview();
    const pending = f.run(() => service.add({requestId: 'cancelled-csl',
      entries: [{kind: 'zotero', previewId: preview.previewId, itemKey: original.key}]}));
    await received;
    const operationId = f.db.prepare('SELECT id FROM research_literature_imports WHERE request_id=?').pluck().get('cancelled-csl');
    f.run(() => service.cancel(operationId));
    release();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.items[0].disposition, 'cancelled');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_objects').pluck().get(), 0);
  } finally {await service.shutdown(); await lateLibrary.shutdown(); await f.dispose();}
});

test('invalid captured CSL reports its exact sanitized failure and cannot be automatically retried as valid input', async () => {
  const original = item('ITEM2345');
  original.csljson = '{invalid';
  const f = fixture([original]);
  try {
    const result = await f.add(await f.preview(), [original.key], 'invalid-csl');
    assert.equal(result.status, 'failed');
    assert.equal(result.items[0].errorCode, 'research_json_invalid');
    assert.equal(result.items[0].retryable, false);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_object_versions').pluck().get(), 0);
  } finally {await f.dispose();}
});

test('a fresh request for the same object version reuses the paper and worker result while retaining scoped import receipts', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const first = await f.add(await f.preview(), [original.key], 'first-request');
    const id = first.items[0].libraryItemId;
    const before = f.db.prepare('SELECT * FROM research_library').all();
    f.setTime('2026-11-03T01:00:00.000Z');
    const later = await f.preview();
    const second = await f.add(later, [original.key], 'fresh-request');
    assert.equal(second.items[0].libraryItemId, id);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.workerCalls(), 1);
    const thirdPreview = await f.run(() => f.service.previewZotero(request, f.adapter), {owner: 'thread:another'});
    const third = await f.run(() => f.service.add({requestId: 'another-owner',
      entries: [{kind: 'zotero', previewId: thirdPreview.previewId, itemKey: original.key}]}), {owner: 'thread:another'});
    assert.equal(third.items[0].libraryItemId, id);
    assert.equal(f.workerCalls(), 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_object_versions').pluck().get(), 1);
    assert.equal(f.run(() => f.service.readZoteroSources({id})).total, 2);
    assert.equal(f.run(() => f.service.readZoteroSources({id}), {owner: 'thread:another'}).total, 1);
  } finally {await f.dispose();}
});

test('reusing a global Zotero object links the requested project after commit without rewriting its bibliography', async () => {
  const original = item('ITEM2345');
  const f = fixture([original]);
  try {
    const preview = await f.preview();
    const entries = [{kind: 'zotero', previewId: preview.previewId, itemKey: original.key}];
    const first = await f.run(() => f.service.add({requestId: 'global-only', entries, destination: 'library_only'}));
    const saved = f.repository.library.get(first.items[0].libraryItemId);
    assert.deepEqual(saved.projectIds, []);
    const before = f.db.prepare('SELECT * FROM research_library').all();
    let premature = 0;
    f.repository.library.onChanged = () => {premature++;};
    const second = await f.run(() => f.service.add({requestId: 'link-project', entries, destination: 'current_project'}));
    assert.equal(second.items[0].disposition, 'linked');
    assert.deepEqual(f.repository.library.get(saved.id).projectIds, [f.project.id]);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.workerCalls(), 1);
    assert.equal(premature, 0);
    assert.equal(f.events.at(-1).operationId, second.operationId);
  } finally {await f.dispose();}
});
