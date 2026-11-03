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
    export {applyResearchDatabaseSchema, agentMigrations} from './src/main/infrastructure/database-schemas';
    export {applyDatabaseMigrations} from './src/main/infrastructure/database-migrations';
    export {LiteratureImportService} from './src/main/plugins/research/literature-import-service';
    export {ResearchLibraryService} from './src/main/plugins/research/library-service';
    export {readResearchBibliography} from './src/main/plugins/research/bibliography';
    export {ZoteroAdapter} from './src/main/plugins/research/zotero-adapter';
    export {withLiteratureContext} from './src/main/services/literature-context';
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
function fixture(initial) {
  const f = createResearchFixture(api);
  let source = initial, time = timestamp, workerCalls = 0;
  const urls = [], events = [];
  const adapter = new api.ZoteroAdapter(async (url, init) => {
    urls.push(url);
    assert.equal(init.method, 'GET');
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
