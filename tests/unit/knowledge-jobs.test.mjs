import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const input = {id:'durable',projectId:null,sourceType:'literature',sourceId:'fixture',title:'Fixture',content:'old',
  chunks:[{content:'old',locator:null}],embeddingPolicy:'none'};
test('source embedding jobs survive absent workers, expose failures and retry without replaying source content',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    f.repository.knowledge.upsertFromSource(input);
    f.repository.queueKnowledgeFromSource(input);
    f.repository.flushKnowledgeFromSource();
    assert.equal(f.repository.knowledgeJobs.list(null)[0].status,'queued');
    f.repository.knowledgeJobs.start(async()=>null);
    await f.repository.knowledgeJobs.idle();
    assert.equal(f.repository.knowledgeJobs.list(null)[0].status,'blocked');
    await f.repository.knowledgeJobs.shutdown();
  } finally {f.close();}
});

test('restart recovery, failure retry, source replacement and deletion fence outstanding workers',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const jobs=f.repository.knowledgeJobs;
    f.repository.knowledge.upsertFromSource(input); jobs.enqueue(input.id);
    f.db.prepare("UPDATE research_knowledge_jobs SET status='running'").run();
    let fail=true;
    jobs.start(async()=>{if(fail) throw new Error('private provider payload'); return {configId:'test',revision:1};});
    await jobs.idle();
    let job=jobs.list(null)[0];
    assert.equal(job.status,'failed'); assert.doesNotMatch(job.error,/private/);
    fail=false; jobs.retry(job.documentId,job.generation); await jobs.idle();
    assert.equal(jobs.list(null)[0].status,'ready');
    assert.equal(jobs.list(null)[0].attempts,2);
    let release, entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const pending=new Promise(resolve=>{release=resolve;});
    let calls=0;
    jobs.start(async()=>{calls++; if(calls===1){entered();await pending;}return {configId:'test',revision:1};});
    jobs.enqueue(input.id);jobs.wake();await started;
    f.repository.knowledge.upsertFromSource({...input,content:'new',chunks:[{content:'new',locator:null}]});
    jobs.enqueue(input.id); release(); await jobs.idle();
    assert.equal(calls,2);
    assert.equal(jobs.list(null)[0].status,'ready');
    assert.equal(f.repository.knowledge.knowledgeDocument(input.id).content,'new');
    assert.throws(()=>jobs.retry(job.documentId,job.generation),/job_changed/);
    f.db.prepare('DELETE FROM research_knowledge_documents WHERE id=?').run(input.id);
    assert.deepEqual(jobs.list(null),[]);
    assert.throws(()=>f.db.transaction(()=>{f.repository.knowledge.upsertFromSource(input);jobs.enqueue(input.id);throw new Error('rollback');})(),/rollback/);
    assert.deepEqual(jobs.list(null),[]);
    await jobs.shutdown();
  } finally {f.close();}
});

test('shutdown cancels the active job and keeps it queued for recovery',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const jobs=f.repository.knowledgeJobs;
    f.repository.knowledge.upsertFromSource(input);jobs.enqueue(input.id);
    let entered; const started=new Promise(resolve=>{entered=resolve;});
    jobs.start(async(_id,signal)=>{entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('cancelled');});
    await started; await jobs.shutdown();
    assert.equal(jobs.list(null)[0].status,'queued');
  } finally {f.close();}
});

test('durable jobs invoke the real embedding service and store only current chunks',async()=>{
  const {ResearchEmbeddingService}=await importTypeScriptModule('src/main/plugins/research/embedding-service.ts',{platform:'node'});
  const f=createResearchFixture(api,'reading');
  let service;
  try {
    const knowledge=f.repository.knowledge,jobs=f.repository.knowledgeJobs;
    knowledge.saveEmbeddingConfig({id:'test',name:'test',baseUrl:'https://fixture.invalid',model:'fixture',dimensions:2,enabled:true},'fixture-key');
    service=new ResearchEmbeddingService(knowledge,{embed:async({texts})=>texts.map(()=>[1,0])},
      {secrets:{get:async()=> 'synthetic-key'},logger:{warn(){}}});
    knowledge.upsertFromSource(input);jobs.enqueue(input.id);
    jobs.start((id,signal)=>service.embedDocument(id,null,signal));await jobs.idle();
    assert.equal(jobs.list(null)[0].status,'ready');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get(),1);
    knowledge.saveEmbeddingConfig({id:'test',name:'test',baseUrl:'https://fixture.invalid',model:'fixture-new',dimensions:2,enabled:true},'fixture-key');
    jobs.configurationChanged(); await jobs.idle();
    assert.ok(f.db.prepare('SELECT space_key FROM research_knowledge_embeddings').all().some(row=>row.space_key.includes('2')));
    await jobs.shutdown();
  } finally {await service?.shutdown();f.close();}
});
