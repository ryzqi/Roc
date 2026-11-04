import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const timestamp='2026-11-04T00:00:00.000Z';

function importedDocument(f) {
  const sourceHash=hash('synthetic original PDF');
  return f.repository.documents.import({id:'locator-document',libraryItemId:null,projectId:f.project.id,
    filename:'fixture.pdf',mediaType:'pdf',sourcePath:'documents/fixture.pdf',sourceHash,size:22,
    entry:{metadata:{id:'locator-literature',source:'local',externalId:'locator-fixture',doi:null,
      title:'Locator fixture',authors:['Synthetic Author'],abstract:null,publishedYear:2026,citationCount:null,
      url:null,openAccessUrl:null,importedAt:timestamp,updatedAt:timestamp},
      bibliography:{citationKey:'locator2026',entryType:'article',fields:{title:'Locator fixture'},preambles:[],
        csl:null,title:'Locator fixture',authors:['Synthetic Author'],doi:null,publishedYear:2026,abstract:null,url:null}}
  },false).document;
}
function parsedContent(document,blocks) {
  return {outputPath:'/tmp/synthetic-locator-output',files:{},content:{
    contractVersion:4,engine:'paddleocr.js',engineVersion:'synthetic-locator-test',parserVersion:'roc-research-parser/2',
    parserFingerprint:hash('synthetic parser'),modelManifest:'',runtime:{node:'synthetic'},tier:'compact',
    parseMode:'native-text',device:'cpu',sourceHash:document.sourceHash,pageCount:4,
    content:blocks.map(block=>block.text).join('\n\n'),blocks,assets:[],
    artifacts:{middleJson:'artifacts/middle.json',markdown:'artifacts/document.md',structuredContent:'artifacts/structured.json'},
    warnings:[]}};
}
function block(id,{text='A repeated retained paragraph.',page=2,locations,locator='page:2'}={}) {
  return {id,kind:'paragraph',label:'Synthetic paragraph',text,locator,imageAssetId:null,
    locations:locations??[{page,bbox:[1,2,30,40],coordinateOrigin:'TOPLEFT'}]};
}
function publishParse(f,document,parseId,blocks) {
  const content=parsedContent(document,blocks);
  f.repository.documents.begin(document.id,parseId);
  f.repository.documents.complete(document.id,parseId,content, null);
  return content;
}
const capture=(f,parseId,index=0)=>f.repository.evidence.capture({projectId:f.project.id,chunkId:`document:${parseId}:chunk:${index}`});

test('capture preserves exact imported document parse source and ordered block coordinates, including duplicate prose',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    const content=publishParse(f,document,'locator-parse',[
      block('blank',{text:'',locations:[]}),block('same-first',{page:1}),block('same-second',{page:3})]);
    const evidence=capture(f,'locator-parse',1);
    const inspected=f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
    assert.deepEqual(inspected.sourceLocator,{
      documentId:document.id,parseId:'locator-parse',knowledgeDocumentId:'document:locator-parse',blockId:'same-second',
      sourceHash:document.sourceHash,parseHash:hash(JSON.stringify(f.repository.documents.parsed(document.id,'locator-parse').data.content)),parserFingerprint:content.content.parserFingerprint,
      rawLocator:'page:2',locations:[{page:3,bbox:[1,2,30,40],coordinateOrigin:'TOPLEFT'}]});
    assert.equal(capture(f,'locator-parse',1).id,evidence.id);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(),1);
    const artifact=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Locator view',path:null});
    f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
      content:'Synthetic unreviewed hypothesis',status:'hypothesis',evidenceIds:[evidence.id]});
    const result=f.repository.inspectArtifact({projectId:f.project.id,artifactId:artifact.id,expectedVersion:null});
    assert.deepEqual(result.snapshot.evidence[0].sourceLocator,inspected.sourceLocator);
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    f.repository.inspectArtifact({projectId:f.project.id,artifactId:artifact.id,expectedVersion:result.snapshot.version});
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{f.close();}
});

test('a document block without coordinates preserves empty locations; arbitrary knowledge has no managed-document locator',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);publishParse(f,document,'no-region',[block('no-region',{locations:[]})]);
    const evidence=capture(f,'no-region');
    assert.deepEqual(f.repository.evidence.inspectEvidence(evidence.id,f.project.id).sourceLocator.locations,[]);
    f.repository.knowledge.upsertFromSource({id:'unmanaged-source',projectId:f.project.id,sourceType:'experiment',
      sourceId:'synthetic-run',title:'Recorded result',content:'A recorded result.',embeddingPolicy:'none',
      chunks:[{content:'A recorded result.',locator:'output/results.csv:line:2'}]});
    const raw=f.repository.evidence.capture({projectId:f.project.id,chunkId:'unmanaged-source:chunk:0'});
    const inspected=f.repository.evidence.inspectEvidence(raw.id,f.project.id);
    assert.equal(inspected.sourceLocator,null);
    assert.equal(inspected.evidence.locator,'output/results.csv:line:2');
  }finally{f.close();}
});

test('reparse keeps old evidence and its immutable source coordinates while new evidence captures the new parse',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);publishParse(f,document,'old-parse',[block('old-block',{page:1})]);
    const old=capture(f,'old-parse'),first=f.repository.evidence.inspectEvidence(old.id,f.project.id);
    publishParse(f,document,'new-parse',[block('new-block',{page:4})]);
    const latest=capture(f,'new-parse'),history=f.repository.evidence.inspectEvidence(old.id,f.project.id);
    assert.equal(history.referenceStatus,'superseded');
    assert.deepEqual(history.sourceLocator,first.sourceLocator);
    assert.equal(history.evidence.excerpt,old.excerpt);
    assert.throws(()=>f.repository.evidence.getEvidence(old.id,f.project.id),/research_evidence_reference_superseded/u);
    assert.notEqual(latest.id,old.id);
    assert.equal(f.repository.evidence.inspectEvidence(latest.id,f.project.id).sourceLocator.parseId,'new-parse');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(),2);
  }finally{f.close();}
});

test('same-document reparse proposes exact raw block targets without replacing evidence or upgrading a hypothesis',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'migration-old',[block('old-block',{page:1})]);
    const old=capture(f,'migration-old');
    const artifact=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Migration hypothesis',path:null});
    const claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:artifact.id,subjectType:'claim',
      content:'An unreviewed inference.',status:'hypothesis',evidenceIds:[old.id]});
    const originalSource=f.repository.evidence.inspectEvidence(old.id,f.project.id);
    const target=block('new-block',{page:4});
    publishParse(f,document,'migration-new',[block('empty',{text:'',locations:[]}),target]);
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    const [candidate]=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id});
    assert.equal(candidate.targetStatus,'current');
    assert.equal(candidate.proposal.status,'needs_review');
    assert.equal(candidate.proposal.match,'exact_text');
    assert.equal(candidate.proposal.sourceDigest,api.relationSourceDigest(candidate.proposal.source));
    assert.deepEqual(candidate.proposal.source.sourceLocator,originalSource.sourceLocator);
    assert.equal(candidate.proposal.source.referenceStatus,'superseded');
    assert.deepEqual(candidate.proposal.targets,[{chunkId:'document:migration-new:chunk:0',block:target}]);
    assert.equal(candidate.proposal.targetParseHash,hash(JSON.stringify(f.repository.documents.parsed(document.id,'migration-new').data.content)));
    assert.deepEqual(f.repository.evidence.getClaim(claim.id),claim);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    f.db.transaction(()=>f.repository.evidence.sourceMigrations.proposeForParse(document.id,'migration-new'))();
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.deepEqual(f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id}),[candidate]);
  }finally{f.close();}
});

test('duplicate target paragraphs remain ambiguous in original indexed order, without choosing a nearby page',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'duplicate-old',[block('old',{page:2})]);
    const old=capture(f,'duplicate-old');
    const first=block('first',{page:1}),second=block('second',{page:3});
    publishParse(f,document,'duplicate-new',[first,block('blank',{text:' ',locations:[]}),second]);
    const [candidate]=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id});
    assert.equal(candidate.proposal.match,'ambiguous');
    assert.deepEqual(candidate.proposal.targets,[{chunkId:'document:duplicate-new:chunk:0',block:first},
      {chunkId:'document:duplicate-new:chunk:1',block:second}]);
    assert.equal(candidate.proposal.status,'needs_review');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);
  }finally{f.close();}
});

test('whitespace matching is explicit, changed prose has no target, and later reparse preserves stale proposals',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'whitespace-old',[block('old')]);
    const old=capture(f,'whitespace-old');
    const normalized=block('normalized',{text:'  A repeated\n retained paragraph.  ',locations:[]});
    publishParse(f,document,'whitespace-new',[normalized]);
    const [first]=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id});
    assert.equal(first.proposal.match,'normalized_text');
    assert.equal(first.proposal.matchingRule,'exact_text_then_whitespace/1');
    assert.deepEqual(first.proposal.targets[0].block,normalized);
    publishParse(f,document,'changed-prose',[block('changed',{text:'A different scientific statement.'})]);
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    const [stale,unmatched]=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id});
    assert.equal(stale.targetStatus,'stale');
    assert.deepEqual(stale.proposal,first.proposal);
    assert.equal(unmatched.targetStatus,'current');
    assert.equal(unmatched.proposal.match,'no_match');
    assert.deepEqual(unmatched.proposal.targets,[]);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{f.close();}
});

test('migration persistence failure rolls back the parse, index and invalidation together',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'rollback-old',[block('old')]);
    const old=capture(f,'rollback-old'),original=f.repository.evidence.inspectEvidence(old.id,f.project.id);
    const externalWrites=[];
    f.repository.setKnowledgeWriter(async input=>{
      externalWrites.push(input.id);
      return f.repository.knowledge.upsertFromSource(input);
    });
    f.repository.documents.begin(document.id,'rollback-new');
    f.db.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON research_source_migration_proposals
      BEGIN SELECT RAISE(ABORT,'synthetic_migration_insert_failed'); END`);
    assert.throws(()=>f.repository.documents.complete(document.id,'rollback-new',parsedContent(document,[block('new')]), null),
      /synthetic_migration_insert_failed/u);
    assert.equal(f.repository.documents.get(document.id).currentParseId,'rollback-old');
    assert.deepEqual(f.repository.evidence.inspectEvidence(old.id,f.project.id),original);
    assert.equal(f.repository.evidence.getEvidence(old.id,f.project.id).id,old.id);
    assert.ok(f.db.prepare("SELECT id FROM research_knowledge_chunks WHERE id='document:rollback-old:chunk:0'").get());
    assert.equal(f.db.prepare("SELECT id FROM research_knowledge_chunks WHERE id='document:rollback-new:chunk:0'").get(),undefined);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_source_migration_proposals').pluck().get(),0);
    f.repository.flushKnowledgeFromSource();
    assert.deepEqual(externalWrites,[]);
    assert.equal(f.db.prepare("SELECT id FROM research_knowledge_chunks WHERE id='document:rollback-new:chunk:0'").get(),undefined);
  }finally{f.close();}
});

test('migration reads refuse foreign sources and corrupt snapshots or current target versions without writes',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'scope-old',[block('old')]);
    const old=capture(f,'scope-old');
    publishParse(f,document,'scope-new',[block('new')]);
    const other=f.repository.createProject({title:'Other migration scope',description:'Synthetic',workspacePath:'/tmp/other-migration'});
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.throws(()=>f.repository.evidence.sourceMigrations.list({projectId:other.id,evidenceId:old.id}),
      /research_evidence_project_mismatch/u);
    assert.throws(()=>f.repository.evidence.sourceMigrations.proposeForParse(document.id,'scope-new'),
      /research_source_migration_transaction_required/u);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    const row=f.db.prepare('SELECT id,snapshot_json FROM research_source_migration_proposals').get();
    f.db.prepare("UPDATE research_source_migration_proposals SET snapshot_json=json_set(snapshot_json,'$.targets[0].block.text','Forged target') WHERE id=?").run(row.id);
    const damaged=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.throws(()=>f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id}),
      /research_source_migration_snapshot_invalid/u);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),damaged);
    f.db.prepare('UPDATE research_source_migration_proposals SET snapshot_json=? WHERE id=?').run(row.snapshot_json,row.id);
    f.db.prepare('UPDATE research_documents SET source_hash=? WHERE id=?').run(hash('Changed source'),document.id);
    const sourceChanged=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.throws(()=>f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id}),
      /research_source_migration_source_changed/u);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),sourceChanged);
    f.db.prepare('UPDATE research_documents SET source_hash=? WHERE id=?').run(document.sourceHash,document.id);
    f.db.prepare("UPDATE research_document_parses SET data_json=json_set(data_json,'$.content.blocks[0].text','Changed same parse') WHERE id='scope-new'").run();
    const changed=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.throws(()=>f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:old.id}),
      /research_source_migration_target_changed/u);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),changed);
  }finally{f.close();}
});

test('DB21 to25 retains captured sources and claims without inventing migration proposals or decisions',()=>{
  const db=new Database(':memory:'),agentDb=new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=21)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const tasks=new api.ResearchTaskRepository(agentDb,()=>timestamp);
    const repository=new api.ResearchRepository(db,tasks,()=>timestamp);
    const project=repository.createProject({title:'Historical source migration',description:'Synthetic DB21 fixture',workspacePath:'/tmp/source-migration-history'});
    db.prepare("UPDATE research_projects SET current_stage='reading' WHERE id=?").run(project.id);
    db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='reading'").run(project.id);
    const f={db,repository,project},document=importedDocument(f);
    publishParse(f,document,'history-parse',[block('history-block')]);
    const evidence=capture(f,'history-parse');
    const artifact=repository.createArtifact({projectId:project.id,stage:'reading',kind:'reading_notes',title:'Historical hypothesis',path:null});
    repository.evidence.createClaim({projectId:project.id,artifactId:artifact.id,subjectType:'claim',
      content:'Historical unreviewed inference.',status:'hypothesis',evidenceIds:[evidence.id]});
    const sourcesBefore=db.prepare('SELECT * FROM research_evidence').all();
    const claimsBefore=db.prepare('SELECT * FROM research_claims').all();
    const locationsBefore=db.prepare('SELECT * FROM research_evidence_source_locators').all();
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),25);
    assert.deepEqual(db.prepare('SELECT * FROM research_evidence').all(),sourcesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM research_claims').all(),claimsBefore);
    assert.deepEqual(db.prepare('SELECT * FROM research_evidence_source_locators').all(),locationsBefore);
    assert.deepEqual(repository.evidence.sourceMigrations.list({projectId:project.id,evidenceId:evidence.id}),[]);
    assert.equal(db.prepare('SELECT count(*) FROM research_source_migration_decisions').pluck().get(),0);
    const before=db.prepare('SELECT total_changes()').pluck().get();
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{db.close();agentDb.close();}
});

test('DB22 to25 preserves pending proposal snapshots and prior scientific records without inventing user decisions',()=>{
  const db=new Database(':memory:'),agentDb=new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=22)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agentDb,()=>timestamp),()=>timestamp);
    const project=repository.createProject({title:'Historical pending proposal',description:'Synthetic DB22 fixture',workspacePath:'/tmp/pending-migration-history'});
    db.prepare("UPDATE research_projects SET current_stage='reading' WHERE id=?").run(project.id);
    db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='reading'").run(project.id);
    const f={db,repository,project},document=importedDocument(f);
    publishParse(f,document,'pending-old',[block('old')]);
    const evidence=capture(f,'pending-old');
    const artifact=repository.createArtifact({projectId:project.id,stage:'reading',kind:'reading_notes',title:'Historical claim',path:null});
    repository.evidence.createClaim({projectId:project.id,artifactId:artifact.id,subjectType:'claim',
      content:'Historical unreviewed claim.',status:'supported',evidenceIds:[evidence.id]});
    publishParse(f,document,'pending-new',[block('new',{page:3})]);
    const tables=['research_evidence','research_evidence_source_locators','research_claims','research_claim_revisions',
      'research_evidence_relations','research_evidence_relation_revisions','research_source_migration_proposals'];
    const original=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(original.at(-1).length,1);
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),25);
    for (const [index,table] of tables.entries()) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),original[index]);
    assert.equal(db.prepare('SELECT count(*) FROM research_source_migration_decisions').pluck().get(),0);
    const before=db.prepare('SELECT total_changes()').pluck().get();
    const [inspection]=repository.evidence.sourceMigrations.list({projectId:project.id,evidenceId:evidence.id});
    assert.equal(inspection.decision,null);
    assert.equal(inspection.proposalHash,original.at(-1)[0].snapshot_hash);
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{db.close();agentDb.close();}
});

test('DB23 to25 preserves actual captured migration decisions and creates no inferred replacement lineage',()=>{
  const db=new Database(':memory:'),agentDb=new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=23)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agentDb,()=>timestamp),()=>timestamp);
    const project=repository.createProject({title:'Historical user migration decision',description:'Synthetic DB23 fixture',workspacePath:'/tmp/replacement-migration-history'});
    db.prepare("UPDATE research_projects SET current_stage='reading' WHERE id=?").run(project.id);
    db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='reading'").run(project.id);
    const f={db,repository,project},document=importedDocument(f);
    publishParse(f,document,'decision-history-old',[block('old')]);
    const evidence=capture(f,'decision-history-old');
    const artifact=repository.createArtifact({projectId:project.id,stage:'reading',kind:'reading_notes',title:'Historical claim',path:null});
    repository.evidence.createClaim({projectId:project.id,artifactId:artifact.id,subjectType:'claim',
      content:'Historical supported declaration.',status:'supported',evidenceIds:[evidence.id]});
    publishParse(f,document,'decision-history-new',[block('new',{page:3})]);
    const [inspection]=repository.evidence.sourceMigrations.list({projectId:project.id,evidenceId:evidence.id});
    repository.evidence.sourceMigrations.decide({projectId:project.id,proposalId:inspection.proposal.id,
      requestId:'synthetic-historical-capture',action:'capture',chunkId:'document:decision-history-new:chunk:0',
      expectedProposalHash:inspection.proposalHash,expectedSourceDigest:inspection.proposal.sourceDigest,
      expectedTargetParseHash:inspection.proposal.targetParseHash,note:null},{kind:'user',id:'synthetic-recorded-user'});
    const tables=['research_evidence','research_evidence_source_locators','research_claims','research_claim_revisions',
      'research_evidence_relations','research_evidence_relation_revisions','research_source_migration_proposals','research_source_migration_decisions'];
    const original=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(original.at(-1).length,1);
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),25);
    for (const [index,table] of tables.entries()) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),original[index]);
    assert.equal(db.prepare('SELECT count(*) FROM research_source_replacements').pluck().get(),0);
    const before=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(repository.evidence.sourceReplacements.list({projectId:project.id,evidenceId:evidence.id}),[]);
    api.applyResearchDatabaseSchema(db,()=>timestamp);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{db.close();agentDb.close();}
});

test('zero geometry preserves a page-only location and out-of-range pages or inverted regions cannot be captured',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f);
    publishParse(f,document,'zero-geometry',[block('logical-page',{locations:[{page:2,bbox:[0,0,0,0],coordinateOrigin:'TOPLEFT'}]})]);
    const evidence=capture(f,'zero-geometry');
    assert.deepEqual(f.repository.evidence.inspectEvidence(evidence.id,f.project.id).sourceLocator.locations,
      [{page:2,bbox:null,coordinateOrigin:null}]);
    publishParse(f,document,'bad-page',[block('bad-page',{page:5})]);
    assert.throws(()=>capture(f,'bad-page'),/research_evidence_source_page_invalid/u);
    publishParse(f,document,'bad-region',[block('bad-region',{locations:[{page:1,bbox:[40,20,1,2],coordinateOrigin:'TOPLEFT'}]})]);
    assert.throws(()=>capture(f,'bad-region'),/research_evidence_source_region_invalid/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);
  }finally{f.close();}
});

test('changed source block or parse identity rolls back capture; existing captured locator cannot be silently rewritten',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const document=importedDocument(f),content=publishParse(f,document,'guarded-parse',[block('guarded')]);
    const update=value=>f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?')
      .run(JSON.stringify(value),'guarded-parse');
    const wrongSource=structuredClone(content);wrongSource.content.sourceHash=hash('changed source');update(wrongSource);
    assert.throws(()=>capture(f,'guarded-parse'),/research_evidence_source_hash_invalid/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(),0);
    const wrongBlock=structuredClone(content);wrongBlock.content.blocks[0].text='Other saved prose.';update(wrongBlock);
    assert.throws(()=>capture(f,'guarded-parse'),/research_evidence_source_block_invalid/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),0);
    update(content);const original=capture(f,'guarded-parse');
    const captured=f.repository.evidence.inspectEvidence(original.id,f.project.id).sourceLocator;
    const changed=structuredClone(content);changed.content.blocks[0].locations[0].page=3;update(changed);
    assert.throws(()=>capture(f,'guarded-parse'),/research_evidence_source_locator_conflict/u);
    assert.deepEqual(f.repository.evidence.inspectEvidence(original.id,f.project.id).sourceLocator,captured);
  }finally{f.close();}
});

test('19 to 20 migration preserves historical raw evidence claim state and absence of captured document coordinates',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  const agentDb=new Database(':memory:');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=19)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agentDb,()=>timestamp),()=>timestamp);
    const project=repository.createProject({title:'Historical locator',description:'Migration fixture',workspacePath:'/tmp/locator-migration'});
    const artifact=repository.createArtifact({projectId:project.id,stage:'discovery',kind:'search_strategy',title:'Historical claim',path:null});
    db.prepare(`INSERT INTO research_evidence (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
      VALUES ('historical-evidence',?,'historical-knowledge','historical:chunk:0','file','historical-source','historical-version','Historical excerpt','p1',?,?,?)`)
      .run(project.id,'Retained old prose.',hash('Retained old prose.'),timestamp);
    db.prepare(`INSERT INTO research_claims (id,project_id,artifact_id,subject_type,content,status,evidence_ids_json,version,created_at,updated_at)
      VALUES ('historical-claim',?,?,'claim','Old saved claim','supported','[\"historical-evidence\"]',1,?,?)`)
      .run(project.id,artifact.id,timestamp,timestamp);
    const locatorMigrations=api.researchMigrations.filter(m=>m.version<=20);
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:locatorMigrations,now:()=>timestamp});
    const inspected=repository.evidence.inspectEvidence('historical-evidence',project.id);
    assert.equal(inspected.evidence.locator,'p1');assert.equal(inspected.sourceLocator,null);
    assert.equal(repository.evidence.getClaim('historical-claim').status,'supported');
    assert.equal(db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(),0);
    const changes=db.prepare('SELECT total_changes()').pluck().get();
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:locatorMigrations,now:()=>timestamp});
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
  }finally{db.close();agentDb.close();}
});
