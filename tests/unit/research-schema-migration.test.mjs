import {seedHistoricalResearch as seed, seedHistoricalPaperAssets} from '../fixtures/research-historical-database.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {convertHistorical, validateHistorical, verifyPair, fingerprintTable}
  from '../../scripts/database/research-migration-lib.mjs';
import {prepareResearchMigration, assertOffline, hashFile} from '../../scripts/database/migrate-research-schema.mjs';
import {verifyResearchMigration} from '../../scripts/database/verify-research-migration.mjs';

const {acquireDatabaseMaintenanceLease} = await importTypeScriptModule('src/main/infrastructure/database-maintenance-lease.ts',
  {platform: 'node'});
const [{ScientificIndexRepository},{buildPaperIR},{assessPdfQuality}]=await Promise.all([
  importTypeScriptModule('src/main/plugins/research/scientific-index-repository.ts',{platform:'node'}),
  importTypeScriptModule('src/main/plugins/research/paper-ir-builder.ts',{platform:'node'}),
  importTypeScriptModule('src/main/plugins/research/pdf-quality-assessor.ts',{platform:'node'})
]);


for (const version of [71, 72, 73]) test(`v${version} conversion preserves every business row, locator, revision and binary vector`, () => {
  const source = seed(':memory:', version), target = new Database(':memory:');
  try {
    const before = source.serialize(), result = convertHistorical(source, target);
    assert.deepEqual(source.serialize(), before);
    assert.equal(target.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 74);
    assert.ok(Object.keys(result.tables).length > 70);
    assert.ok(result.addedTables.length > 0);
    assert.equal(target.prepare('SELECT count(*) FROM research_wiki_pages').pluck().get(),
      source.prepare('SELECT count(*) FROM research_wiki_pages').pluck().get(), 'copy must not replay evidence-insert effects');
    for (const name of ['research_knowledge_chunks_fts','research_knowledge_documents_fts','research_knowledge_keywords','research_wiki_fts']) {
      assert.ok(target.prepare(`SELECT count(*) FROM ${name} WHERE ${name} MATCH 'historicaltoken'`).pluck().get() > 0);
    }
    assert.equal(target.prepare('SELECT id FROM research_wiki_sections').safeIntegers().pluck().get(), 9007199254740993n);
    assert.deepEqual(fingerprintTable(target, 'research_wiki_jobs'), fingerprintTable(source, 'research_wiki_jobs'));
  } finally {source.close(); target.close();}
});

for (const version of [71,72,73]) test(`v${version} converted database rebuilds scientific generations from retained source objects`, () => {
  const source=seed(':memory:',version), target=new Database(':memory:');
  try {
    convertHistorical(source,target);
    const history=['research_evidence','research_evidence_source_metadata','research_evidence_source_locators',
      'research_claims','research_claim_revisions','research_evidence_relations','research_wiki_revisions'];
    const before=history.map(name=>fingerprintTable(target,name));
    const blocks=[{id:'body',kind:'paragraph',text:'Original historicaltoken retained method.',label:'paragraph',
      locator:'page 1',imagePath:null,locations:[{page:1,bbox:[10,10,100,30],coordinateOrigin:'TOPLEFT'}]}];
    const content={sourceHash:'a'.repeat(64),parserFingerprint:'b'.repeat(64),blocks,
      quality:assessPdfQuality({pages:[{page:1,regions:[],coordinateFrame:{kind:'image',page:1,
        width:200,height:200,unit:'raster-pixel',coordinateOrigin:'TOPLEFT'}}],blocks})};
    const ir=buildPaperIR({identity:{paperId:'paper',documentId:'d',parseId:'retained-parse',
      knowledgeDocumentId:'d',sourceHash:content.sourceHash,parserFingerprint:content.parserFingerprint},content});
    const store=new ScientificIndexRepository(target,()=> '2026-11-17T00:00:00.000Z');
    const first=store.begin({ir,projectId:'p',embedding:null,source:{kind:'project',fileId:'f',artifactId:'retained-parse'}});
    store.publish(first.id,()=>({paperIR:first.snapshot.paperIR,embedding:null}));
    const initial=store.chunks(first.id,'p');
    const second=store.begin({ir,projectId:'p',embedding:null,source:{kind:'project',fileId:'f',artifactId:'retained-parse'}});
    store.publish(second.id,()=>({paperIR:second.snapshot.paperIR,embedding:null}));
    assert.deepEqual(store.chunks(second.id,'p'),initial);
    assert.equal(store.active('p','d').id,second.id);
    assert.equal(store.get(first.id).status,'retired');
    assert.ok(target.prepare("SELECT count(*) FROM research_scientific_fts WHERE research_scientific_fts MATCH 'historicaltoken'").pluck().get()>0);
    assert.deepEqual(history.map(name=>fingerprintTable(target,name)),before);
    assert.deepEqual(target.pragma('foreign_key_check'),[]);
  } finally {target.close();source.close();}
});

test('same-version altered DDL, wrong identity/hash, missing metadata and unsupported versions refuse', () => {
  for (const sql of ['DROP INDEX research_wiki_project', "UPDATE schema_metadata SET db_name='agent'",
    "UPDATE schema_metadata SET schema_checksum='wrong'", 'DROP TABLE schema_metadata',
    'UPDATE schema_metadata SET current_version=70']) {
    const db = seed(':memory:', 71);
    try {db.exec(sql); const before = db.serialize(); assert.throws(() => validateHistorical(db)); assert.deepEqual(db.serialize(), before);}
    finally {db.close();}
  }
});

test('offline preparation uses native backup and reopens current candidate while preserving source bytes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-historical-migration-')));
  try {
    const parent = join(root, 'plugin-data/data/plugins/@roc'); mkdirSync(parent, {recursive: true});
    const path = join(parent, 'plugin-research.db'); seed(path, 71).close();
    const hash = hashFile(path), directory = join(root, 'migration');
    const receipt = await prepareResearchMigration({dataRoot: root, output: directory});
    assert.equal(receipt.sourceHash, hash); assert.equal(hashFile(path), hash);
    assert.deepEqual(verifyResearchMigration(directory), receipt);
    assert.deepEqual(verifyPair(path, join(directory, 'candidate.db')), receipt.verification);
    const changed = new Database(join(directory, 'candidate.db'));
    changed.exec("UPDATE research_wiki_revisions SET snapshot_json='{}' WHERE page_id='wiki' AND revision=1"); changed.close();
    assert.throws(() => verifyResearchMigration(directory), /migration_candidate_changed/);
    assert.throws(() => verifyPair(path, join(directory, 'candidate.db')), /migration_content_changed:research_wiki_revisions/);
    assert.equal(hashFile(path), hash);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('v73 offline conversion preserves the original PDF bytes, parse artifacts and persisted artifact locators', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-v73-paper-preservation-')));
  try {
    const parent = join(root, 'plugin-data/data/plugins/@roc'); mkdirSync(parent, {recursive: true});
    const path = join(parent, 'plugin-research.db'), source = seed(path, 73);
    const assets = seedHistoricalPaperAssets(source, root); source.close();
    const sourceHash = hashFile(path), pdfHash = hashFile(assets.pdfPath), artifactHash = hashFile(assets.artifactPath);
    const migration = join(root, 'migration');
    const receipt = await prepareResearchMigration({dataRoot: root, output: migration});
    assert.equal(receipt.fromVersion, 73); assert.equal(receipt.toVersion, 74);
    assert.equal(hashFile(path), sourceHash);
    assert.equal(hashFile(assets.pdfPath), pdfHash); assert.equal(pdfHash, assets.pdfHash);
    assert.equal(hashFile(assets.artifactPath), artifactHash); assert.equal(artifactHash, assets.artifactHash);
    const target = new Database(join(migration, 'candidate.db'), {readonly:true});
    try {
      assert.equal(target.prepare('SELECT source_path FROM research_documents WHERE id=?').pluck().get('d'),
        'project-files/source.pdf');
      assert.equal(target.prepare('SELECT current_parse_id FROM research_documents WHERE id=?').pluck().get('d'), 'old-parse');
      assert.equal(target.prepare('SELECT id FROM research_document_parses WHERE document_id=?').pluck().get('d'), 'old-parse');
      assert.equal(target.prepare('SELECT path FROM research_artifacts WHERE id=?').pluck().get('parse-artifact'),
        'project-files/artifacts/structured.json');
      assert.deepEqual(JSON.parse(target.prepare('SELECT locator_json FROM research_evidence_source_locators WHERE evidence_id=?')
        .pluck().get('e')), {documentId:'d',parseId:'old-parse',page:3,bbox:[1,2,3,4],
          artifactPath:'project-files/artifacts/structured.json'});
    } finally {target.close();}
    assert.deepEqual(verifyPair(path, join(migration, 'candidate.db')), receipt.verification);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('active connection, maintenance lease and any WAL/SHM sidecar block before copying the source', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-historical-occupied-')));
  let lease;
  try {
    const pluginRoot = join(root, 'plugin-data'), parent = join(pluginRoot, 'data/plugins/@roc');
    mkdirSync(parent, {recursive: true}); const path = join(parent, 'plugin-research.db');
    const db = seed(path, 72);
    assert.throws(() => assertOffline(path), /migration_database_in_use/); db.close();
    for (const suffix of ['-wal','-shm','-journal']) {
      writeFileSync(path + suffix, ''); assert.throws(() => assertOffline(path), /migration_sidecars_present/);
      rmSync(path + suffix);
    }
    lease = acquireDatabaseMaintenanceLease({rootDir: pluginRoot, owner: {kind: 'cli', pid: process.pid}});
    const before = readFileSync(path);
    await assert.rejects(prepareResearchMigration({dataRoot: root, output: join(root, 'refused')}), /database_maintenance_locked/);
    assert.deepEqual(readFileSync(path), before);
  } finally {lease?.release(); rmSync(root, {recursive: true, force: true});}
});
