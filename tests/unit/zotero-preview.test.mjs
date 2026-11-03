import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import * as esbuild from 'esbuild';
import {createResearchFixture} from './fixtures/research-test-kit.mjs';

let directory, api;
const timestamp = '2026-11-03T00:00:00.000Z';
const headers = {'Zotero-API-Version': '3', 'Zotero-Server-ID': 'preview-instance',
  'Zotero-Schema-Version': '40', 'Last-Modified-Version': '9', 'Total-Results': '25'};
const request = {serverId: 'preview-instance', library: {kind: 'user', id: 0}, expectedLibraryVersion: null,
  offset: 0, limit: 25, collectionKey: null, since: null};
const records = Array.from({length: 25}, (_, index) => {
  const key = `ITEM${String(index).padStart(4, '0')}`;
  return {key, version: 8, data: {key, version: 8, itemType: 'journalArticle',
    title: `Synthetic preview ${index}`, tags: [{tag: 'external'}], collections: [], DOI: '10.1234/same',
    unknownFutureField: {retained: true}}};
});
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-zotero-preview-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'api.mjs');
  await esbuild.build({stdin: {contents: `
    export {ResearchRepository} from './src/main/plugins/research/repository';
    export {ResearchTaskRepository} from './src/main/plugins/research/research-task-repository';
    export {applyResearchDatabaseSchema, agentMigrations, researchMigrations} from './src/main/infrastructure/database-schemas';
    export {applyDatabaseMigrations} from './src/main/infrastructure/database-migrations';
    export {LiteratureImportService} from './src/main/plugins/research/literature-import-service';
    export {ZoteroAdapter} from './src/main/plugins/research/zotero-adapter';
    export {registerZoteroCapabilities} from './src/main/plugins/research/zotero-capabilities';
    export {withLiteratureContext} from './src/main/services/literature-context';
  `, resolveDir: process.cwd()}, outfile, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', loader: {'.md': 'text'}, logLevel: 'silent'});
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));
function fixture() {
  const f = createResearchFixture(api);
  let time = timestamp, calls = 0;
  const adapter = new api.ZoteroAdapter(async () => {
    calls++;
    return Response.json(records, {headers});
  }, () => time);
  const service = new api.LiteratureImportService(f.db, f.repository.library, {}, {},
    async () => assert.fail('preview cannot publish a library change'), () => time);
  const context = {owner: 'thread:preview', projectId: f.project.id, runId: null};
  return {...f, adapter, service, context, calls: () => calls, setTime: value => {time = value;},
    run: (operation, overrides = {}) => api.withLiteratureContext({...context, ...overrides}, operation)};
}

test('owned preview freezes all original objects before review, paginates readback and survives service restart', async () => {
  const f = fixture();
  try {
    const handlers = new Map();
    api.registerZoteroCapabilities({pluginId: 'fixture', capabilities: {register(_owner, descriptor, handler) {
      handlers.set(descriptor.name, handler);
    }}}, f.adapter, f.service);
    const snapshot = await f.run(() => handlers.get('research.zotero.preview')(request));
    assert.equal(snapshot.sourcePage.records.length, 20);
    assert.equal(snapshot.capturedTotal, 25);
    assert.equal(snapshot.nextPreviewOffset, 20);
    assert.equal(snapshot.sourcePage.nextOffset, null);
    assert.equal(f.calls(), 1);
    const saved = f.db.prepare('SELECT * FROM research_zotero_previews WHERE id=?').get(snapshot.previewId);
    assert.equal(saved.owner, f.context.owner);
    assert.equal(saved.project_id, f.project.id);
    const full = JSON.parse(saved.snapshot_json);
    const {contentHash, ...body} = full;
    assert.equal(contentHash, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.deepEqual(full.sourcePage.records, records);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
    await f.service.shutdown();
    const reopened = new api.LiteratureImportService(f.db, f.repository.library, {}, {}, async () => {}, () => timestamp);
    reopened.recover();
    const next = f.run(() => reopened.readZoteroPreview({previewId: snapshot.previewId, offset: 20}));
    assert.deepEqual(next.sourcePage.records, records.slice(20));
    assert.equal(next.contentHash, contentHash);
    assert.equal(next.nextPreviewOffset, null);
    assert.equal(f.calls(), 1);
    await reopened.shutdown();
  } finally {await f.adapter.shutdown(); f.db.close(); f.agentDb.close();}
});

test('preview owner/project/expiry and complete-body corruption fail without re-fetching or library writes', async () => {
  const f = fixture();
  try {
    const snapshot = await f.run(() => f.service.previewZotero(request, f.adapter));
    const read = () => f.service.readZoteroPreview({previewId: snapshot.previewId});
    assert.throws(() => f.run(read, {owner: 'thread:other'}), /zotero_preview_not_found/u);
    assert.throws(() => f.run(read, {projectId: null}), /zotero_preview_not_found/u);
    f.setTime('2026-11-11T00:00:00.000Z');
    assert.throws(() => f.run(read), /zotero_preview_expired/u);
    f.setTime(timestamp);
    const row = JSON.parse(f.db.prepare('SELECT snapshot_json FROM research_zotero_previews WHERE id=?').pluck().get(snapshot.previewId));
    row.sourcePage.records[24].data.title = 'corrupted omitted record';
    f.db.prepare('UPDATE research_zotero_previews SET snapshot_json=? WHERE id=?').run(JSON.stringify(row), snapshot.previewId);
    assert.throws(() => f.run(read), /zotero_preview_integrity_invalid/u);
    assert.equal(f.calls(), 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
  } finally {await f.service.shutdown(); await f.adapter.shutdown(); f.db.close(); f.agentDb.close();}
});

test('failed capture write and invalid remote page publish no preview or library result', async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER refuse_zotero_preview BEFORE INSERT ON research_zotero_previews BEGIN SELECT RAISE(ABORT,'fixture_preview_disk_error'); END");
    await assert.rejects(f.run(() => f.service.previewZotero(request, f.adapter)), /fixture_preview_disk_error/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(), 0);
    f.db.exec('DROP TRIGGER refuse_zotero_preview');
    const invalid = new api.ZoteroAdapter(async () => Response.json([], {headers}));
    await assert.rejects(f.run(() => f.service.previewZotero(request, invalid)), /zotero_page_incomplete/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
    await invalid.shutdown();
  } finally {await f.service.shutdown(); await f.adapter.shutdown(); f.db.close(); f.agentDb.close();}
});

test('preview shutdown drains even a late adapter and cannot publish a captured snapshot', async () => {
  const f = fixture();
  let release, started;
  const received = new Promise(resolve => {started = resolve;});
  const late = {async items(_input, signal) {
    started();
    await new Promise(resolve => {release = resolve;});
    assert.equal(signal.aborted, true);
    return {serverId: request.serverId, library: request.library, libraryVersion: 9, offset: 0, total: 25,
      nextOffset: null, responseHash: 'a'.repeat(64), fetchedAt: timestamp, records};
  }};
  try {
    const pending = f.run(() => f.service.previewZotero(request, late));
    const refusal = assert.rejects(pending, /literature_import_closed/u);
    await received;
    let finished = false;
    const shutdown = f.service.shutdown().then(() => {finished = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await shutdown;
    await refusal;
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(), 0);
  } finally {await f.adapter.shutdown(); f.db.close(); f.agentDb.close();}
});

test('DB12 upgrade preserves historical library data and creates no fictional Zotero previews', () => {
  const db = new Database(':memory:');
  try {
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(migration => migration.version <= 12)});
    const metadata = {id: 'local:historical', source: 'local', externalId: 'historical', doi: '10.1234/historical',
      title: 'Synthetic retained history', authors: [], abstract: null, publishedYear: null, citationCount: null,
      url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
    const bibliography = {citationKey: 'historical', entryType: 'article', fields: {title: metadata.title},
      preambles: [], csl: null, title: metadata.title, authors: [], doi: metadata.doi, publishedYear: null,
      abstract: null, url: null};
    db.prepare(`INSERT INTO research_library(id,identity_key,metadata_json,bibliography_json,sources_json,
      revision,archived,created_at,updated_at) VALUES ('historical','doi:10.1234/historical',?,?,?,1,0,?,?)`)
      .run(JSON.stringify(metadata), JSON.stringify(bibliography), JSON.stringify([{metadata, bibliography, providerRecord: null}]),
        timestamp, timestamp);
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const before = db.prepare('SELECT * FROM research_library').all();
    api.applyResearchDatabaseSchema(db);
    assert.equal(db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(), 0);
    assert.deepEqual(db.prepare('SELECT * FROM research_library').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=12 ORDER BY version').all(), ledger);
  } finally {db.close();}
});
