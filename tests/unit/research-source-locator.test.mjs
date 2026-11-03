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
  f.repository.documents.complete(document.id,parseId,content);
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
