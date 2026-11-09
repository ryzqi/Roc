import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewFullTextFixture} from './fixtures/research-review-fulltext.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const actor={kind:'user',id:'synthetic-fulltext-selector'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const scene=(options,selectedApi)=>createReviewFullTextFixture(api,options,selectedApi);

test('actual managed original and parsed source bind to title-included hit with source hashes and no duplicate paper library or eligibility writes',async()=>{
  const f=await scene();
  try {
    const library=f.db.prepare('SELECT * FROM research_library').all(),title=f.freezing.getPhase(f.phase);
    const binding=await f.fulltexts.save(f.retrieved(),actor);
    assert.deepEqual(binding.snapshot.hit,f.corpus.snapshot.hits[0]);assert.deepEqual(binding.snapshot.searchSource,f.corpus.snapshot.sources[0]);
    assert.deepEqual(binding.snapshot.actor,actor);assert.equal(binding.snapshot.source.documentId,f.document.id);
    assert.equal(binding.snapshot.source.libraryItemId,f.document.libraryItemId);assert.equal(binding.snapshot.source.sourceHash,hash(f.original));
    assert.equal(binding.snapshot.source.parse.hash,hash(JSON.stringify(f.collected.data.content)));
    assert.equal(binding.snapshot.source.parse.parserFingerprint,f.collected.data.content.parserFingerprint);
    assert.equal(binding.snapshot.source.parse.coordinateHash,f.repository.documents.coordinates(f.document.id,'fulltext-parse').snapshotHash);
    assert.equal(binding.referenceStatus,'current');assert.equal(binding.currentProtocol,true);
    assert.equal(binding.snapshotHash,hash(JSON.stringify(binding.snapshot)));
    const before=f.changes();assert.deepEqual(f.fulltexts.get(f.bindingGet(binding.snapshot.id)),binding);
    assert.deepEqual(f.fulltexts.list(f.get),[binding]);assert.deepEqual(f.fulltexts.history({...f.get,hitId:binding.snapshot.request.hitId}),[binding]);
    assert.deepEqual(await f.fulltexts.verifyCurrent({...f.bindingGet(binding.snapshot.id),expectedBindingHash:binding.snapshotHash}),binding);
    assert.equal(f.changes(),before);assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(),library);
    assert.deepEqual(f.freezing.getPhase(f.phase),title);assert.equal(f.repository.evidence.list(f.project.id).length,0);
  }finally{await f.cleanup();}
});

test('source-only binding remains fixed across reparse, while explicitly selected parsed source becomes superseded without rewriting history',async()=>{
  const f=await scene();
  try {
    const sourceOnly=await f.fulltexts.save(f.retrieved(0,'original-only',{...f.selection,parseId:null,parseHash:null}),actor);
    const parsed=await f.fulltexts.save(f.retrieved(2,'parsed-source'),actor);assert.equal(sourceOnly.snapshot.source.parse,null);
    f.reparse();
    const before=f.changes(),historical=f.fulltexts.get(f.bindingGet(parsed.snapshot.id));
    assert.deepEqual(historical,{...parsed,referenceStatus:'superseded'});
    assert.deepEqual(f.fulltexts.get(f.bindingGet(sourceOnly.snapshot.id)),sourceOnly);
    assert.deepEqual(await f.fulltexts.verifyCurrent({...f.bindingGet(sourceOnly.snapshot.id),expectedBindingHash:sourceOnly.snapshotHash}),sourceOnly);
    await assert.rejects(f.fulltexts.verifyCurrent({...f.bindingGet(parsed.snapshot.id),expectedBindingHash:parsed.snapshotHash}),/research_review_fulltext_version_conflict/);
    assert.deepEqual(await f.fulltexts.save(parsed.snapshot.request,actor),historical);
    assert.equal(f.changes(),before);
  }finally{await f.cleanup();}
});

test('not-retrieved is an explicit human gap and later retrieval appends exact parent lineage rather than creating an exclusion',async()=>{
  const f=await scene();
  try {
    const gap=await f.fulltexts.save(f.notRetrieved(),actor),original=f.db.prepare('SELECT * FROM research_review_fulltext_bindings').all();
    assert.equal(gap.snapshot.source,null);assert.equal(gap.referenceStatus,'not_retrieved');assert.equal(gap.snapshot.request.outcome.kind,'not_retrieved');
    await assert.rejects(f.fulltexts.verifyCurrent({...f.bindingGet(gap.snapshot.id),expectedBindingHash:gap.snapshotHash}),/research_review_fulltext_not_retrieved/);
    const next={...f.retrieved(0,'now-retrieved'),parentBindingId:gap.snapshot.id,expectedParentHash:gap.snapshotHash,revisionReason:'User obtained and inspected the actual source.'};
    const retrieved=await f.fulltexts.save(next,actor);assert.equal(retrieved.snapshot.version,2);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE id=?').all(gap.snapshot.id),original);
    const before=f.changes();assert.deepEqual(await f.fulltexts.save(next,actor),retrieved);
    assert.deepEqual(await f.fulltexts.save(gap.snapshot.request,actor),{...gap,isLatest:false});
    await assert.rejects(f.fulltexts.save({...next,requestId:'stale-parent'},actor),/research_review_fulltext_version_conflict/);
    await assert.rejects(f.fulltexts.save(next,{kind:'user',id:'other'}),/research_review_request_conflict/);
    assert.deepEqual(f.fulltexts.history({...f.get,hitId:gap.snapshot.request.hitId}),[{...gap,isLatest:false},retrieved]);assert.equal(f.changes(),before);
    assert.equal(f.freezing.getPhase(f.phase).counts.excluded,1);
  }finally{await f.cleanup();}
});

test('unfrozen/excluded hits, another project, wrong source/parse hashes and strict forged inputs refuse without binding writes',async()=>{
  const f=await scene();
  try {
    const other=f.repository.createProject({title:'Other fulltext project',description:'Synthetic',workspacePath:'/tmp/other-fulltext'});
    const before=f.changes(),valid=f.retrieved();
    await assert.rejects(f.fulltexts.save(f.retrieved(1,'excluded'),actor),/research_review_fulltext_hit_not_included/);
    await assert.rejects(f.fulltexts.save({...valid,projectId:other.id},actor),/research_review_project_mismatch/);
    await assert.rejects(f.fulltexts.save({...valid,expectedTitleFreezeHash:'a'.repeat(64)},actor),/research_review_screening_version_conflict/);
    await assert.rejects(f.fulltexts.save(f.retrieved(0,'wrong-source',{...f.selection,sourceHash:'a'.repeat(64)}),actor),/research_document_source_changed/);
    await assert.rejects(f.fulltexts.save(f.retrieved(0,'wrong-parse',{...f.selection,parseHash:'a'.repeat(64)}),actor),/research_document_preview_parse_changed/);
    for(const input of [{...valid,actor},f.retrieved(0,'missing-pair',{...f.selection,parseHash:null}),{...f.notRetrieved(),outcome:{kind:'not_retrieved',reason:''}},
      {...valid,expectedParentHash:'a'.repeat(64)}])await assert.rejects(f.fulltexts.save(input,actor));
    assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
  }finally{await f.cleanup();}
  const pending=await scene({freeze:false,document:false});
  try{await assert.rejects(pending.fulltexts.save(pending.notRetrieved(),actor),/research_review_screening_not_frozen/);}
  finally{await pending.cleanup();}
});

test('original byte/coordinate failures and reparse during actual asynchronous verification cannot acknowledge a new source binding',async()=>{
  const f=await scene();
  try {
    await writeFile(f.sourcePath,Buffer.from('corrupt original'));const before=f.changes();
    await assert.rejects(f.fulltexts.save(f.retrieved(),actor),/research_document_source_changed/);
    assert.equal(f.changes(),before);await writeFile(f.sourcePath,f.original);
    const original=f.service.preview.bind(f.service);
    f.service.preview=async request=>{const preview=await original(request);f.reparse();return preview;};
    await assert.rejects(f.fulltexts.save(f.retrieved(),actor),/research_review_fulltext_source_changed/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
    f.service.preview=original;
    const now={...f.selection,parseId:'fulltext-reparse'};
    const bound=await f.fulltexts.save(f.retrieved(0,'new-parse-selected',now),actor);assert.equal(bound.snapshot.source.parse.id,'fulltext-reparse');
    await writeFile(f.sourcePath,Buffer.from('later corruption'));
    const saved=f.changes();await assert.rejects(f.fulltexts.verifyCurrent({...f.bindingGet(bound.snapshot.id),expectedBindingHash:bound.snapshotHash}),/research_document_source_changed/);
    assert.deepEqual(f.fulltexts.get(f.bindingGet(bound.snapshot.id)),bound);assert.equal(f.changes(),saved);
  }finally{await f.cleanup();}
});

test('binding corruption and post-insert current parse drift fail or roll back without changing original title decisions',async()=>{
  const f=await scene();
  try {
    f.db.exec("CREATE TRIGGER drift_fulltext_parse AFTER INSERT ON research_review_fulltext_bindings BEGIN UPDATE research_documents SET current_parse_id=NULL; END;");
    await assert.rejects(f.fulltexts.save(f.retrieved(),actor),/research_review_fulltext_source_changed/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
    assert.equal(f.repository.documents.get(f.document.id).currentParseId,'fulltext-parse');
    f.db.exec('DROP TRIGGER drift_fulltext_parse');
    const binding=await f.fulltexts.save(f.retrieved(),actor),row=f.db.prepare('SELECT * FROM research_review_fulltext_bindings').get();
    const changed=JSON.parse(row.snapshot_json);changed.source.parse.parserFingerprint='a'.repeat(64);const json=JSON.stringify(changed);
    f.db.prepare('UPDATE research_review_fulltext_bindings SET snapshot_json=?,snapshot_hash=?').run(json,hash(json));
    const before=f.changes();assert.throws(()=>f.fulltexts.get(f.bindingGet(binding.snapshot.id)),/research_review_fulltext_snapshot_invalid/);
    assert.equal(f.changes(),before);assert.equal(f.freezing.getPhase(f.phase).counts.included,7);
  }finally{await f.cleanup();}
});

test('coordinate metadata replaced after real preview cannot become an acknowledged binding or current verification',async()=>{
  const f=await scene();
  try {
    const original=f.service.preview.bind(f.service);
    const row=f.db.prepare('SELECT * FROM research_document_parse_coordinates WHERE parse_id=?').get(f.selection.parseId);
    const changed=JSON.parse(row.snapshot_json);changed.artifact.sha256='a'.repeat(64);
    const json=JSON.stringify(changed),digest=hash(json);
    const replace=()=>{
      f.db.prepare('UPDATE research_document_parse_coordinates SET snapshot_json=?,snapshot_hash=? WHERE parse_id=?')
        .run(json,digest,f.selection.parseId);
      f.db.prepare('UPDATE research_document_parses SET coordinate_snapshot_hash=? WHERE id=?').run(digest,f.selection.parseId);
    };
    const restore=()=>{
      f.db.prepare('UPDATE research_document_parse_coordinates SET snapshot_json=?,snapshot_hash=? WHERE parse_id=?')
        .run(row.snapshot_json,row.snapshot_hash,f.selection.parseId);
      f.db.prepare('UPDATE research_document_parses SET coordinate_snapshot_hash=? WHERE id=?').run(row.snapshot_hash,f.selection.parseId);
    };
    f.service.preview=async request=>{const preview=await original(request);replace();return preview;};
    await assert.rejects(f.fulltexts.save(f.retrieved(),actor),/research_review_fulltext_source_changed/);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
    restore();f.service.preview=original;
    const binding=await f.fulltexts.save(f.retrieved(),actor);
    f.service.preview=async request=>{const preview=await original(request);replace();return preview;};
    await assert.rejects(f.fulltexts.verifyCurrent({...f.bindingGet(binding.snapshot.id),expectedBindingHash:binding.snapshotHash}),
      /research_review_fulltext_snapshot_invalid/);
    restore();assert.deepEqual(f.fulltexts.get(f.bindingGet(binding.snapshot.id)),binding);
  }finally{await f.cleanup();}
});

test('historical protocol, unlinked source and archive retain fixed binding history but do not authorize new source decisions',async()=>{
  const f=await scene();
  try {
    const binding=await f.fulltexts.save(f.retrieved(),actor);
    f.repository.library.link(f.document.libraryItemId,f.project.id,false,{notify:false});
    const unlinked=f.fulltexts.get(f.bindingGet(binding.snapshot.id));assert.deepEqual(unlinked,{...binding,referenceStatus:'superseded'});
    const before=f.changes();await assert.rejects(f.fulltexts.verifyCurrent({...f.bindingGet(binding.snapshot.id),expectedBindingHash:binding.snapshotHash}),/research_review_fulltext_version_conflict/);
    assert.equal(f.changes(),before);f.repository.library.link(f.document.libraryItemId,f.project.id,true,{notify:false});
    f.repository.systematicReviews.save({projectId:f.project.id,requestId:'later',protocolId:f.protocol.version.protocolId,
      expectedVersionId:f.protocol.version.id,expectedVersionHash:f.protocol.versionHash,body:f.protocol.version.body,deviationReason:'Later review protocol.'},actor);
    const historical=f.fulltexts.get(f.bindingGet(binding.snapshot.id));assert.deepEqual(historical,{...binding,currentProtocol:false});
    const readonly=f.changes();await assert.rejects(f.fulltexts.save(f.notRetrieved(2,'old-protocol-new'),actor),/research_review_screening_version_conflict/);
    assert.equal(f.changes(),readonly);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.deepEqual(f.fulltexts.get(f.bindingGet(binding.snapshot.id)),historical);
    await assert.rejects(f.fulltexts.save(f.notRetrieved(2,'archive'),actor),/research_project_archived/);
  }finally{await f.cleanup();}
});

test('generated fulltext source API binds actual main sender through asynchronous byte verification and reads exact source history readonly',async()=>{
  const f=await scene();
  try {
    const registry=new api.CapabilityRegistry();
    for(const descriptor of api.researchReviewFullTextCapabilities)registry.declare('research',descriptor);
    api.registerResearchReviewFullTextCapabilities({pluginId:'research',capabilities:registry},f.fulltexts);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)}),request=f.retrieved(),before=f.changes();
    await assert.rejects(registry.invoke('research.reviewFullText.save',request),error=>error.code==='research_human_required');
    assert.throws(()=>api.parseIpcRequestArgs('roc:research:review-fulltext-save',[{...request,actor}]));
    const noSender=await bridge.invoke('research.saveReviewFullTextBinding',[request]);assert.equal(noSender.ok,false);
    assert.equal(noSender.error.code,'research_sender_required');assert.equal(f.changes(),before);
    const saved=await bridge.invoke('research.saveReviewFullTextBinding',[request],111);
    assert.equal(saved.ok,true,JSON.stringify(saved));assert.deepEqual(saved.data.snapshot.actor,{kind:'user',id:'window:111'});
    const readonly=f.changes(),read=await bridge.invoke('research.getReviewFullTextBinding',[f.bindingGet(saved.data.snapshot.id)],111);
    const list=await bridge.invoke('research.listReviewFullTextBindings',[f.get],111);
    const history=await bridge.invoke('research.getReviewFullTextBindingHistory',[{...f.get,hitId:saved.data.snapshot.request.hitId}],111);
    assert.equal(read.ok,true);assert.equal(list.ok,true);assert.equal(history.ok,true);
    assert.deepEqual(read.data,saved.data);assert.deepEqual(list.data,[saved.data]);assert.deepEqual(history.data,[saved.data]);assert.equal(f.changes(),readonly);
  }finally{await f.cleanup();}
});

test('SQLite reopen preserves reviewed records without network requests or writes',async()=>{
  const f=await scene(),directory=await mkdtemp(join(tmpdir(),'roc-fulltext-reopen-'));
  let db,reviews,service;
  try {

    const tables=['research_documents','research_document_parses','research_library','research_review_screening_plans',
      'research_review_screening_decisions','research_review_screening_freezes','research_review_corpora','research_review_protocol_versions'];
    const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
    const originalColumns=tables.map(table=>f.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
    api.applyResearchDatabaseSchema(f.db);
    tables.forEach((table,index)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all()
      .map(row=>Object.fromEntries(originalColumns[index].map(key=>[key,row[key]]))),before[index]));
    assert.equal(f.db.prepare('SELECT full_freeze_hash FROM research_review_screening_plans').pluck().get(),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
    const binding=await f.fulltexts.save(f.retrieved(),actor),path=join(directory,'research.sqlite');await f.db.backup(path);
    db=new Database(path);db.pragma('foreign_keys = ON');const repository=new api.ResearchRepository(db,f.tasks,()=>f.time);
    reviews=new api.ResearchReviewSearchService(db,repository,{search:async()=>{throw new Error('readonly_must_not_request');}},error=>f.errors.push(error),()=>{},()=>f.time);
    const corpora=new api.ResearchReviewCorpusRepository(db,repository,reviews,()=>f.time),dedup=new api.ResearchReviewDeduplicationRepository(db,repository,corpora,()=>f.time);
    const plans=new api.ResearchReviewScreeningRepository(db,repository,corpora,dedup,()=>f.time),decisions=new api.ResearchReviewScreeningDecisions(db,repository,corpora,dedup,plans,()=>f.time);
    const arbitration=new api.ResearchReviewScreeningArbitration(db,repository,decisions,()=>f.time),freezing=new api.ResearchReviewScreeningFreeze(db,repository,arbitration,()=>f.time);
    service=new api.ResearchDocumentService(repository,{},f.root);const fulltexts=new api.ResearchReviewFullTextRepository(db,repository,corpora,freezing,service,()=>f.time);
    const changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(fulltexts.get(f.bindingGet(binding.snapshot.id)),binding);
    assert.deepEqual(await fulltexts.verifyCurrent({...f.bindingGet(binding.snapshot.id),expectedBindingHash:binding.snapshotHash}),binding);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);assert.equal(f.calls.length,4);assert.equal(f.errors.length,0);
  }finally{await service?.shutdown();await reviews?.shutdown();db?.close();await f.cleanup();await rm(directory,{recursive:true,force:true});}
});
