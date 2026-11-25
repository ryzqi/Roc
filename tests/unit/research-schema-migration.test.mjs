import {seedHistoricalResearch as seed, seedHistoricalPaperAssets} from '../fixtures/research-historical-database.mjs';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {after, test} from 'node:test';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {convertHistorical, validateHistorical, verifyPair, fingerprintTable, targetSchema}
  from '../../scripts/database/research-migration-lib.mjs';
import {prepareResearchMigration, assertAgentReferencesUnchanged, assertOffline, hashFile} from '../../scripts/database/migrate-research-schema.mjs';
import {verifyResearchMigration} from '../../scripts/database/verify-research-migration.mjs';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

const {acquireDatabaseMaintenanceLease} = await importTypeScriptModule('src/main/infrastructure/database-maintenance-lease.ts',
  {platform: 'node'});
const [{ScientificIndexRepository},{buildPaperIR},{assessPdfQuality}]=await Promise.all([
  importTypeScriptModule('src/main/plugins/research/scientific-index-repository.ts',{platform:'node'}),
  importTypeScriptModule('src/main/plugins/research/paper-ir-builder.ts',{platform:'node'}),
  importTypeScriptModule('src/main/plugins/research/pdf-quality-assessor.ts',{platform:'node'})
]);
const taskApi = await loadResearchTestApi();
after(() => taskApi.dispose());
function seedAgent(path, executionId) {
  const db = new Database(path); taskApi.applyAgentDatabaseSchema(db);
  new taskApi.ResearchTaskRepository(db).linkOwned({kind: 'experiment', executionId, projectId: 'p',
    ownerRunId: null, goal: 'Retained Agent history', snapshot: {executionId}});
  db.close();
}

function seedExecution(db, id, engine) {
  db.prepare(`INSERT INTO research_experiment_runs
    (id,project_id,label,command,parameters_json,environment_json,status,outputs_json,started_at,ended_at)
    VALUES(?,'p',?,'[]','{}','{}','completed','[]','old','old')`).run(id, engine);
  db.prepare(`INSERT INTO research_experiment_executions
    (run_id,project_id,request_id,status,snapshot_json,root_path,created_at) VALUES(?,'p',?,'completed',?,'/historical','old')`)
    .run(id, id, JSON.stringify({id, request: {engine}, artifactId: null}));
  db.prepare(`INSERT INTO research_experiment_results(id,project_id,run_id,request_id,snapshot_json,snapshot_hash,created_at)
    VALUES(?,'p',?,?,'{}','historical-result-hash','old')`).run(`${id}-result`, id, `${id}-result`);
}

test('v75 migration removes authorized isolated R/Julia history and fingerprints every retained result', () => {
  const source = seed(':memory:', 75), target = new Database(':memory:');
  try {
    for (const engine of ['r', 'julia', 'typescript']) seedExecution(source, `${engine}-execution`, engine);
    const before = source.serialize(), result = convertHistorical(source, target);
    assert.deepEqual(source.serialize(), before);
    assert.deepEqual(target.prepare('SELECT id FROM research_experiment_runs').pluck().all(), ['typescript-execution']);
    assert.deepEqual(target.prepare('SELECT id FROM research_experiment_results').pluck().all(), ['typescript-execution-result']);
    for (const name of ['research_experiment_runs', 'research_experiment_executions', 'research_experiment_results']) {
      assert.equal(result.removedRows[name].count, 2);
      assert.equal(result.removedRows[name].reason, 'authorized_removed_r_julia_history');
      assert.equal(result.tables[name].count, 1);
    }
    assert.equal(target.prepare('SELECT count(*) FROM research_python_environments').pluck().get(), 0);
    assert.equal(target.prepare('SELECT count(*) FROM research_python_environment_operations').pluck().get(), 0);
    assert.deepEqual(target.pragma('foreign_key_check'), []);
  } finally {source.close(); target.close();}
});

test('old Python receipts and executions refuse before initializing a candidate', () => {
  for (const kind of ['receipt', 'execution']) {
    const source = seed(':memory:', 75), target = new Database(':memory:');
    try {
      if (kind === 'receipt') source.prepare(`INSERT INTO research_python_environment_selections
        (id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES('old-python','p','old','{}','old','old')`).run();
      else seedExecution(source, 'old-python-execution', 'python');
      const original = source.serialize();
      assert.throws(() => convertHistorical(source, target), kind === 'receipt'
        ? /migration_python_receipts_require_archive/u : /migration_python_history_requires_archive/u);
      assert.deepEqual(source.serialize(), original);
      assert.equal(target.prepare('SELECT count(*) FROM sqlite_master').pluck().get(), 0);
    } finally {source.close(); target.close();}
  }
});

test('referenced R/Julia history refuses before candidate creation and leaves all source data intact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-migration-linked-history-')));
  try {
    const parent = join(root, 'plugin-data/data/plugins/@roc'); mkdirSync(parent, {recursive: true});
    const path = join(parent, 'plugin-research.db'), source = seed(path, 75);
    seedExecution(source, 'r-linked-execution', 'r');
    source.prepare(`INSERT INTO research_provenance
      (id,project_id,artifact_id,subject_type,subject_id,source_type,source_id,created_at)
      VALUES('linked-provenance','p','a','experiment','r-linked-execution','experiment','r-linked-execution','old')`).run();
    source.close(); const before = hashFile(path), directory = join(root, 'migration');
    await assert.rejects(prepareResearchMigration({dataRoot: root, output: directory}),
      /migration_unsupported_history_referenced:research_provenance/u);
    assert.equal(existsSync(join(directory, 'candidate.db')), false);
    assert.equal(hashFile(path), before);
    assert.equal(existsSync(join(directory, 'backup.db')), true);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('actual Agent task links reject R/Julia removal before candidate creation without modifying either database', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-migration-agent-reference-')));
  try {
    const parent = join(root, 'plugin-data/data/plugins/@roc'); mkdirSync(parent, {recursive: true});
    const path = join(parent, 'plugin-research.db'), agentPath = join(parent, 'plugin-agent.db');
    const source = seed(path, 75); seedExecution(source, 'r-agent-linked', 'r'); source.close();
    seedAgent(agentPath, 'r-agent-linked');
    const before = [hashFile(path), hashFile(agentPath)], directory = join(root, 'migration');
    await assert.rejects(prepareResearchMigration({dataRoot: root, output: directory}),
      /migration_unsupported_history_referenced:agent:research_task/u);
    assert.equal(existsSync(join(directory, 'candidate.db')), false);
    assert.deepEqual([hashFile(path), hashFile(agentPath)], before);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('R/Julia removal binds the offline Agent snapshot or its absence and detects later history drift', async () => {
  for (const exists of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-migration-agent-fence-')));
    try {
      const parent = join(root, 'plugin-data/data/plugins/@roc'); mkdirSync(parent, {recursive: true});
      const path = join(parent, 'plugin-research.db'), agentPath = join(parent, 'plugin-agent.db');
      const source = seed(path, 75); seedExecution(source, 'r-isolated', 'r'); source.close();
      if (exists) seedAgent(agentPath, 'retained-typescript');
      const before = hashFile(path), directory = join(root, 'migration');
      const receipt = await prepareResearchMigration({dataRoot: root, output: directory});
      assert.deepEqual(receipt.agentReferences, {sourcePath: agentPath, sourceHash: exists ? hashFile(agentPath) : null});
      assert.deepEqual(verifyResearchMigration(directory), receipt);
      assertAgentReferencesUnchanged(root, receipt.agentReferences);
      seedAgent(agentPath, 'r-isolated');
      assert.throws(() => assertAgentReferencesUnchanged(root, receipt.agentReferences), /migration_agent_source_changed/u);
      assert.equal(hashFile(path), before);
      if (exists) {
        writeFileSync(join(directory, 'agent-reference-snapshot.db'), 'changed');
        assert.throws(() => verifyResearchMigration(directory), /migration_agent_snapshot_changed/u);
      }
    } finally {rmSync(root, {recursive: true, force: true});}
  }
});


for (const version of [71, 72, 73, 74, 75]) test(`v${version} conversion preserves every business row, locator, revision and binary vector`, () => {
  const source = seed(':memory:', version), target = new Database(':memory:');
  try {
    const before = source.serialize(), result = convertHistorical(source, target);
    assert.deepEqual(source.serialize(), before);
    assert.equal(target.prepare('SELECT current_version FROM schema_metadata').pluck().get(), targetSchema.version);
    assert.ok(Object.keys(result.tables).length > 70);
    if (version < 75) assert.ok(result.addedTables.includes('research_proposals'));
    assert.ok(result.addedTables.includes('research_python_environments'));
    assert.ok(result.addedTables.includes('research_python_environment_operations'));
    assert.deepEqual(result.removedRows, {});
    assert.equal(result.removedTables[0].name, 'research_python_environment_selections');
    assert.equal(target.prepare('SELECT count(*) FROM research_wiki_pages').pluck().get(),
      source.prepare('SELECT count(*) FROM research_wiki_pages').pluck().get(), 'copy must not replay evidence-insert effects');
    for (const name of ['research_knowledge_chunks_fts','research_knowledge_documents_fts','research_knowledge_keywords','research_wiki_fts']) {
      assert.ok(target.prepare(`SELECT count(*) FROM ${name} WHERE ${name} MATCH 'historicaltoken'`).pluck().get() > 0);
    }
    assert.equal(target.prepare('SELECT id FROM research_wiki_sections').safeIntegers().pluck().get(), 9007199254740993n);
    assert.deepEqual(fingerprintTable(target, 'research_wiki_jobs'), fingerprintTable(source, 'research_wiki_jobs'));
  } finally {source.close(); target.close();}
});

for (const version of [71,72,73,74,75]) test(`v${version} converted database rebuilds scientific generations from retained source objects`, () => {
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
    assert.equal(receipt.fromVersion, 73); assert.equal(receipt.toVersion, targetSchema.version);
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
