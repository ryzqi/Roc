import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import * as esbuild from 'esbuild';
import {createResearchFixture} from './fixtures/research-test-kit.mjs';

const unusedAttachmentPicker = async () => assert.fail('Native attachment grants are separately verified');

const unusedAttachmentDocuments = {importPrepared: async () => assert.fail('Attachment document imports are separately verified')};

let directory, api;
const at='2026-11-04T00:00:00.000Z';
const scope={serverId:'synthetic-sync-instance',library:{kind:'user',id:0}};
before(async()=>{
  directory=mkdtempSync(join(tmpdir(),'roc-zotero-sync-'));
  symlinkSync(join(process.cwd(),'node_modules'),join(directory,'node_modules'),'dir');
  const outfile=join(directory,'api.mjs');
  await esbuild.build({stdin:{contents:`
    export {ResearchRepository} from './src/main/plugins/research/repository';
    export {ResearchTaskRepository} from './src/main/plugins/research/research-task-repository';
    export {applyResearchDatabaseSchema,agentMigrations,researchMigrations} from './src/main/infrastructure/database-schemas';
    export {applyDatabaseMigrations} from './src/main/infrastructure/database-migrations';
    export {LiteratureImportService} from './src/main/plugins/research/literature-import-service';
    export {ResearchLibraryService} from './src/main/plugins/research/library-service';
    export {readResearchBibliography} from './src/main/plugins/research/bibliography';
    export {ZoteroAdapter} from './src/main/plugins/research/zotero-adapter';
    export {withLiteratureContext} from './src/main/services/literature-context';
    export {registerZoteroCapabilities} from './src/main/plugins/research/zotero-capabilities';
    export {registerLiteratureImportCapabilities} from './src/main/plugins/research/literature-import-capabilities';
    export {createPluginCapabilityAdapter} from './src/main/ipc/plugin-capability-adapter';
  `,resolveDir:process.cwd()},outfile,bundle:true,packages:'external',platform:'node',format:'esm',
    loader:{'.md':'text'},logLevel:'silent'});
  api=await import(outfile);
});
after(()=>rmSync(directory,{recursive:true,force:true}));
function item(index,version=8){
  const key='ITEM'+String(index).padStart(4,'0'),title='Synthetic '+index;
  return {key,version,data:{key,version,itemType:'journalArticle',title,creators:[],collections:[],tags:[]},
    csljson:JSON.stringify([{id:key,type:'article-journal',title}])};
}
function fixture(){
  const f=createResearchFixture(api);
  let records=[item(0),item(1),item(2)],version=20,serverId=scope.serverId,error=null,defer=null,time=at,workerCalls=0;
  const requests=[];
  const adapter=new api.ZoteroAdapter(async(url,init)=>{
    const query=new URL(url).searchParams;
    requests.push({url,init});
    assert.equal(init.method,'GET');
    if(error) throw error;
    if(defer) await defer();
    const filtered=records.filter(item=>query.get('since')===null || item.version>Number(query.get('since')));
    return Response.json(filtered.slice(Number(query.get('start')),Number(query.get('start'))+Number(query.get('limit'))),
      {headers:{'Zotero-API-Version':'3','Zotero-Server-ID':serverId,'Zotero-Schema-Version':'40',
        'Last-Modified-Version':String(version),'Total-Results':String(filtered.length)}});
  },()=>time);
  const library=new api.ResearchLibraryService(f.repository.library,{async readBibliography(input){
    workerCalls++;return (await api.readResearchBibliography(input)).entries;
  }},join(directory,'worker-'+crypto.randomUUID()));
  const createService=(db=f.db,repository=f.repository)=>new api.LiteratureImportService(db,repository.library,{},library,async()=>{},()=>time);
  let service=createService();
  const context={owner:'thread:sync',projectId:f.project.id};
  const run=(work,overrides={})=>api.withLiteratureContext({...context,...overrides},work);
  return {...f,adapter,requests,context,run,createService,get service(){return service;},
    setService:value=>{service=value;},
    source:options=>{
      if(options.records!==undefined) records=options.records;
      if(options.version!==undefined) version=options.version;
      if(options.serverId!==undefined) serverId=options.serverId;
      if('error' in options) error=options.error;
      if('defer' in options) defer=options.defer;
      if(options.time!==undefined) time=options.time;
    },
    workers:()=>workerCalls,
    start:options=>run(()=>service.startZoteroSync({...scope,collectionKey:null,mode:'incremental',limit:2,...options})),
    read:state=>run(()=>service.readZoteroSync({syncId:state.syncId})),
    page:(state,replacePreviewId=null)=>run(()=>service.captureZoteroSyncPage({syncId:state.syncId,expectedRevision:state.revision,replacePreviewId},adapter)),
    control:(state,action)=>run(()=>service.controlZoteroSync({syncId:state.syncId,expectedRevision:state.revision,action})),
    ack:(state,preview,importedKeys=[],skipped=[])=>run(()=>service.acknowledgeZoteroSync({
      syncId:state.syncId,expectedRevision:state.revision,previewId:preview.previewId,importedKeys,skipped})),
    skipAll:(state,preview)=>run(()=>service.acknowledgeZoteroSync({
      syncId:state.syncId,expectedRevision:state.revision,previewId:preview.previewId,importedKeys:[],
      skipped:preview.sourcePage.records.map(item=>({itemKey:item.key,reason:'User excluded from this scope'}))})),
    add:(preview,keys)=>run(()=>service.add({requestId:crypto.randomUUID(),
      entries:keys.map(itemKey=>({kind:'zotero',previewId:preview.previewId,itemKey}))})),
    async dispose(){await service.shutdown();await library.shutdown();await adapter.shutdown();f.close();}
  };
}

test('reviewed-page receipt advances offset atomically; complete batch alone advances version and next since',async()=>{
  const f=fixture();
  try{
    const start=f.start();
    assert.equal(f.requests.length,0);
    const first=await f.page(start);
    assert.equal(first.sync.revision,1);
    assert.equal(first.sync.checkpointVersion,null);
    assert.throws(()=>f.ack(first.sync,first.preview,['ITEM0000']),/page_incomplete/u);
    assert.throws(()=>f.ack(first.sync,first.preview,['ITEM0000'],[{itemKey:'ITEM0001',reason:'Excluded'}]),/receipt_missing/u);
    assert.deepEqual(f.read(first.sync),first.sync);
    assert.equal((await f.add(first.preview,['ITEM0000'])).status,'completed');
    const acknowledged=f.ack(first.sync,first.preview,['ITEM0000'],[{itemKey:'ITEM0001',reason:'Excluded'}]);
    assert.equal(acknowledged.nextOffset,2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_checkpoints').pluck().get(),0);
    const second=await f.page(acknowledged);
    const secondQuery=new URL(f.requests[1].url).searchParams;
    assert.equal(secondQuery.get('start'),'2');
    assert.equal(f.requests[1].init.headers['Zotero-Server-ID'],scope.serverId);
    const complete=f.skipAll(second.sync,second.preview);
    assert.equal(complete.status,'completed');
    assert.equal(complete.checkpointVersion,20);
    assert.equal(f.workers(),1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_pages').pluck().get(),2);
    f.source({records:[item(0,21),item(1),item(2)],version:21});
    const next=f.start();
    assert.equal(next.since,20);
    const changed=await f.page(next);
    assert.deepEqual(changed.preview.sourcePage.records.map(item=>item.key),['ITEM0000']);
    assert.equal(new URL(f.requests[2].url).searchParams.get('since'),'20');
    assert.equal(f.skipAll(changed.sync,changed.preview).checkpointVersion,21);
    assert.equal(f.start({mode:'full'}).since,null);
  }finally{await f.dispose();}
});

test('pause survives actual database reopen with pending source and original offset; no automatic HTTP or import',async()=>{
  const f=fixture();
  let diskDb;
  try{
    const first=await f.page(f.start());
    const state=f.skipAll(first.sync,first.preview);
    const second=await f.page(state);
    const paused=f.control(second.sync,'pause');
    await f.service.shutdown();
    const dbPath=join(directory,'restart-'+crypto.randomUUID()+'.sqlite');
    await f.db.backup(dbPath);
    diskDb=new Database(dbPath);
    applyOfflineResearchSchema(api, diskDb,()=>at);
    const repository=new api.ResearchRepository(diskDb,f.tasks,()=>at);
    f.setService(f.createService(diskDb,repository));
    assert.deepEqual(f.read(paused),paused);
    assert.equal(f.requests.length,2);
    assert.equal(f.workers(),0);
    assert.throws(()=>f.ack(paused,second.preview),/state_conflict/u);
    const resumed=f.control(paused,'resume');
    assert.equal(resumed.nextOffset,2);
    assert.equal(resumed.pendingPreviewId,second.preview.previewId);
    assert.equal(f.skipAll(resumed,second.preview).checkpointVersion,20);
  }finally{await f.dispose();diskDb?.close();}
});

test('pause during HTTP refuses late capture; failed connection keeps the same checkpoint and retry position',async()=>{
  const f=fixture();
  try{
    let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    f.source({defer:()=>{entered();return new Promise(resolve=>{release=resolve;});}});
    const start=f.start();
    const pending=f.page(start);
    const refusal=assert.rejects(pending,/zotero_cancelled/u);
    await started;
    await assert.rejects(f.page(start),/page_in_progress/u);
    assert.equal(f.requests.length,1);
    const paused=f.control(start,'pause');
    release();
    await refusal;
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(),0);
    assert.equal(f.read(paused).nextOffset,0);
    const resumed=f.control(paused,'resume');
    f.source({defer:null,error:new Error('Synthetic connection lost')});
    await assert.rejects(f.page(resumed),/zotero_unreachable/u);
    assert.deepEqual(f.read(resumed),resumed);
    f.source({error:null});
    const page=await f.page(resumed);
    assert.equal(page.preview.sourcePage.offset,0);
  }finally{await f.dispose();}
});

test('explicit recapture replaces expired selection; old page and stale revision cannot advance',async()=>{
  const f=fixture();
  try{
    const start=f.start();
    const first=await f.page(start);
    await assert.rejects(f.page(first.sync),/page_pending/u);
    f.source({time:'2026-11-12T00:00:00.000Z'});
    assert.throws(()=>f.skipAll(first.sync,first.preview),/preview_expired/u);
    const replacement=await f.page(first.sync,first.preview.previewId);
    assert.notEqual(replacement.preview.previewId,first.preview.previewId);
    assert.throws(()=>f.skipAll(first.sync,first.preview),/revision_conflict/u);
    assert.throws(()=>f.skipAll(replacement.sync,first.preview),/page_mismatch/u);
    assert.equal(f.skipAll(replacement.sync,replacement.preview).nextOffset,2);
  }finally{await f.dispose();}
});

test('checkpoint, page receipt and session update roll back together; previously imported paper remains',async()=>{
  const f=fixture();
  try{
    const captured=await f.page(f.start({limit:50}));
    await f.add(captured.preview,['ITEM0000']);
    f.db.exec(`CREATE TRIGGER refuse_sync_checkpoint BEFORE INSERT ON research_zotero_sync_checkpoints
      BEGIN SELECT RAISE(ABORT,'synthetic checkpoint failure'); END;`);
    const decisions=[{itemKey:'ITEM0001',reason:'Excluded'},{itemKey:'ITEM0002',reason:'Excluded'}];
    assert.throws(()=>f.ack(captured.sync,captured.preview,['ITEM0000'],decisions),/synthetic checkpoint failure/u);
    assert.deepEqual(f.read(captured.sync),captured.sync);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_pages').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_checkpoints').pluck().get(),0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),1);
    f.db.exec('DROP TRIGGER refuse_sync_checkpoint');
    assert.equal(f.ack(captured.sync,captured.preview,['ITEM0000'],decisions).status,'completed');
  }finally{await f.dispose();}
});

test('version rollback and instance change require new checkpoint establishment and retain completed history',async()=>{
  const f=fixture();
  try{
    const full=await f.page(f.start({limit:50}));
    f.skipAll(full.sync,full.preview);
    f.source({version:19,records:[]});
    const regressed=f.start();
    await assert.rejects(f.page(regressed),/version_regressed/u);
    assert.equal(f.read(regressed).status,'reset_required');
    assert.equal(f.read(regressed).checkpointVersion,20);
    const changed=f.start();
    f.source({version:21,serverId:'new-instance'});
    await assert.rejects(f.page(changed),/zotero_server_changed/u);
    assert.equal(f.read(changed).status,'reset_required');
    assert.equal(f.db.prepare('SELECT library_version FROM research_zotero_sync_checkpoints').pluck().get(),20);
    const newInstance=f.start({serverId:'new-instance'});
    assert.equal(newInstance.since,null);
    assert.equal(newInstance.checkpointVersion,null);
  }finally{await f.dispose();}
});

test('version changes between pages refuse completion without advancing last complete checkpoint',async()=>{
  const f=fixture();
  try{
    const first=await f.page(f.start());
    const state=f.skipAll(first.sync,first.preview);
    f.source({version:21});
    await assert.rejects(f.page(state),/zotero_library_version_changed/u);
    assert.equal(f.read(state).status,'reset_required');
    assert.equal(f.read(state).nextOffset,2);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_checkpoints').pluck().get(),0);
  }finally{await f.dispose();}
});

test('explicit rebaseline permits a lower instance checkpoint while retaining old source decisions and import version guards',async()=>{
  const f=fixture();
  try{
    const captured=await f.page(f.start({limit:50}));
    await f.add(captured.preview,['ITEM0000']);
    const old=f.ack(captured.sync,captured.preview,['ITEM0000'],[
      {itemKey:'ITEM0001',reason:'Excluded'},{itemKey:'ITEM0002',reason:'Excluded'}]);
    const library=f.db.prepare('SELECT * FROM research_library').all();
    f.source({version:19,records:[item(0,7)]});
    const ordinary=f.start({mode:'full'});
    await assert.rejects(f.page(ordinary),/version_regressed/u);
    const explicit=f.start({mode:'rebaseline'});
    assert.equal(explicit.since,null);
    const restored=await f.page(explicit);
    await assert.rejects(f.add(restored.preview,['ITEM0000']),/zotero_object_version_regressed/u);
    assert.equal(f.workers(),1);
    const completed=f.skipAll(restored.sync,restored.preview);
    assert.equal(completed.checkpointVersion,19);
    assert.equal(f.read(old).checkpointVersion,20);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(),library);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_pages').pluck().get(),2);
    assert.equal(f.start().since,19);
  }finally{await f.dispose();}
});

test('actual sender IPC scopes sync state and receipts; foreign project and owner cannot read or advance',async()=>{
  const f=fixture();
  try{
    const handlers=new Map();
    api.registerZoteroCapabilities({pluginId:'fixture',capabilities:{register(_plugin,descriptor,handler){
      handlers.set(descriptor.name,handler);
    }}},f.adapter,f.service,unusedAttachmentPicker,unusedAttachmentDocuments);
    api.registerLiteratureImportCapabilities({pluginId:'fixture',capabilities:{register(_plugin,descriptor,handler){
      handlers.set(descriptor.name,handler);
    }}},f.service);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
    const envelope={...scope,projectId:f.project.id,collectionKey:null,mode:'incremental',limit:2};
    const call=async(method,input,windowId=7)=>bridge.invoke('research.'+method,[input],windowId);
    const startedResult=await call('startZoteroSync',envelope);
    assert.equal(startedResult.ok,true,JSON.stringify(startedResult));
    const started=startedResult.data;
    const read={syncId:started.syncId,projectId:f.project.id};
    const find={...scope,projectId:f.project.id,collectionKey:null};
    assert.deepEqual((await call('findZoteroSync',find)).data,started);
    assert.equal((await call('findZoteroSync',find,8)).data,null);
    assert.equal((await call('findZoteroSync',{...find,collectionKey:'COLL0000'})).data,null);
    assert.deepEqual((await call('readZoteroSync',read)).data,started);
    assert.equal((await call('readZoteroSync',read,8)).error.code,'zotero_sync_not_found');
    assert.equal((await call('readZoteroSync',{...read,projectId:null})).error.code,'zotero_sync_not_found');
    assert.equal((await call('readZoteroSync',{syncId:started.syncId})).ok,false);
    const capturedResult=await call('captureZoteroSyncPage',{...read,expectedRevision:0,replacePreviewId:null});
    assert.equal(capturedResult.ok,true,JSON.stringify(capturedResult));
    const captured=capturedResult.data;
    const missing=await call('acknowledgeZoteroSync',{...read,expectedRevision:1,
      previewId:captured.preview.previewId,importedKeys:['ITEM0000','ITEM0001'],skipped:[]});
    assert.equal(missing.error.code,'zotero_sync_import_receipt_missing');
    const imported=await call('addLiterature',{projectId:f.project.id,requestId:'sync-bridge-import',
      entries:[{kind:'zotero',previewId:captured.preview.previewId,itemKey:'ITEM0000'}]});
    assert.equal(imported.ok,true,JSON.stringify(imported));
    assert.equal(imported.data.status,'completed');
    const restored=await call('readZoteroSyncPage',read);
    assert.equal(restored.ok,true,JSON.stringify(restored));
    assert.deepEqual(restored.data.importedKeys,['ITEM0000']);
    assert.equal(restored.data.sync.revision,1);
    assert.equal((await call('readZoteroSyncPage',read,8)).error.code,'zotero_sync_not_found');
    const ack=await call('acknowledgeZoteroSync',{...read,expectedRevision:1,
      previewId:captured.preview.previewId,importedKeys:['ITEM0000'],skipped:[{itemKey:'ITEM0001',reason:'Excluded'}]});
    assert.equal(ack.ok,true,JSON.stringify(ack));
    assert.equal(ack.data.nextOffset,2);
    assert.equal(f.requests.length,1);
    assert.equal(f.workers(),1);
  }finally{await f.dispose();}
});

test('duplicate source objects across pages and inconsistent totals cannot become a completed checkpoint',async()=>{
  const f=fixture();
  try{
    const first=await f.page(f.start());
    const state=f.skipAll(first.sync,first.preview);
    f.source({records:[item(0),item(1),item(0)]});
    await assert.rejects(f.page(state),/page_duplicate/u);
    assert.equal(f.read(state).status,'reset_required');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_previews').pluck().get(),1);
    const next=await f.page(f.start());
    const acknowledged=f.skipAll(next.sync,next.preview);
    f.source({records:[item(0),item(1),item(2),item(3)]});
    await assert.rejects(f.page(acknowledged),/total_changed/u);
    assert.equal(f.read(acknowledged).status,'reset_required');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_zotero_sync_checkpoints').pluck().get(),0);
  }finally{await f.dispose();}
});

test('empty page completes a real version; duplicate decisions, active scope and damaged stored state fail explicitly',async()=>{
  const f=fixture();
  try{
    const start=f.start();
    assert.throws(()=>f.start(),/already_active/u);
    const captured=await f.page(start);
    assert.throws(()=>f.ack(captured.sync,captured.preview,['ITEM0000'],[{itemKey:'ITEM0000',reason:'Duplicate'}]),/duplicate_decision/u);
    const paused=f.control(captured.sync,'pause');
    assert.equal(f.control(paused,'abandon').status,'reset_required');
    f.source({records:[],version:25});
    const empty=await f.page(f.start());
    assert.equal(f.ack(empty.sync,empty.preview).checkpointVersion,25);
    const next=f.start();
    f.db.prepare('UPDATE research_zotero_syncs SET state_json=? WHERE id=?').run('{"unknown":true}',next.syncId);
    assert.throws(()=>f.read(next),/storage_invalid/u);
  }finally{await f.dispose();}
});

test('lookup finds the newest scoped session with tied clock timestamps and pending receipts remain readonly',async()=>{
  const f=fixture();
  try{
    const find={...scope,collectionKey:null};
    assert.equal(f.run(()=>f.service.findZoteroSync(find)),null);
    const first=f.start();
    f.control(first,'abandon');
    const second=f.start();
    assert.equal(f.run(()=>f.service.findZoteroSync(find)).syncId,second.syncId);
    const captured=await f.page(second);
    assert.throws(()=>f.run(()=>f.service.readZoteroSyncPage({syncId:first.syncId})),/page_missing/u);
    await f.add(captured.preview,['ITEM0000']);
    const changes=f.db.prepare('SELECT total_changes()').pluck().get();
    const read=f.run(()=>f.service.readZoteroSyncPage({syncId:second.syncId}));
    assert.deepEqual(read.importedKeys,['ITEM0000']);
    assert.deepEqual(read.sync,captured.sync);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),changes);
    assert.equal(f.requests.length,1);
    assert.equal(f.workers(),1);
  }finally{await f.dispose();}
});

test('migration14 to15 preserves existing preview and applied migration receipts without fabricated checkpoints',()=>{
  const db=new Database(':memory:');
  try{
    const dbName='plugin:@roc/plugin-research';
    api.applyDatabaseMigrations(db,{dbName,migrations:api.researchMigrations.filter(m=>m.version<=14),now:()=>at});
    db.prepare('INSERT INTO research_zotero_previews VALUES (?,?,?,?,?,?,?)')
      .run('old-preview','old-owner',null,null,at,'2026-11-11T00:00:00.000Z','{"original":true}');
    const old=db.prepare('SELECT * FROM schema_migrations WHERE db_name=? ORDER BY version').all(dbName);
    api.applyDatabaseMigrations(db,{dbName,migrations:api.researchMigrations.filter(m=>m.version<=15),now:()=>at});
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE db_name=? AND version<=14 ORDER BY version').all(dbName),old);
    assert.equal(db.prepare('SELECT snapshot_json FROM research_zotero_previews').pluck().get(),'{"original":true}');
    assert.equal(db.prepare('SELECT count(*) FROM research_zotero_sync_checkpoints').pluck().get(),0);
    assert.equal(db.prepare('SELECT max(version) FROM schema_migrations WHERE db_name=?').pluck().get(dbName),15);
  }finally{db.close();}
});
