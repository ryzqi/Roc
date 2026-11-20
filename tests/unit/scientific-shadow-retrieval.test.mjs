import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';
let api, Shadow, register;
async function loadCapabilityRegistry() {
  // Same native-dependency boundary as scientific-extraction-service.test.mjs.
  const result = await build({entryPoints:['src/main/plugins/research/research-plugin-knowledge.ts'],
    bundle:true,format:'cjs',platform:'node',packages:'external',write:false,logLevel:'silent'});
  const directory=resolve('.runtime/tmp'), file=join(directory,`shadow-capabilities-${randomUUID()}.cjs`);
  await mkdir(directory,{recursive:true});
  await writeFile(file,result.outputFiles[0].text);
  try {return (await import(pathToFileURL(file).href)).default;}
  finally {await rm(file,{force:true});}
}
before(async () => {
  const modules = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-shadow-retrieval.ts', {platform:'node'}),
    loadCapabilityRegistry()]);
  api = modules[0]; Shadow = modules[1].ScientificShadowRetrieval; register = modules[2].registerResearchKnowledge;
});
after(() => api?.dispose());
const request = f => ({query:'Original method Table 3 Equation (7) Figure 2', projectId:f.project.id,
  embeddingConfigId:null, limit:20, rerank:'none'});
const policy = f => ({projectIds:[f.project.id], timeoutMs:10000, concurrency:1});
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('actual capability returns legacy result once while shadow reads PDF/IR/FTS/vector under SQLite query_only', async () => {
  const f = await scientificSearchFixture(api), events=[]; let foreground, calls=0;
  const shadow = new Shadow({search:async (...args)=>{calls++; return foreground=await f.embeddings.search(...args);}},
    f.router, ()=>policy(f), event=>events.push(event));
  try {
    const handlers=new Map();
    register({capabilities:{register:(_plugin,descriptor,handler)=>handlers.set(descriptor.name,handler)}},
      {researchRepository:f.repository,researchEmbeddings:f.embeddings,scientificRetrieval:f.router,shadowRetrieval:shadow});
    f.db.pragma('query_only = ON');
    const before=f.db.serialize(), changes=f.db.prepare('SELECT total_changes() AS n').get().n;
    const source=await readFile(f.source), ir=await readFile(join(f.root,f.data.paperIR.path));
    const result=await handlers.get('research.knowledge.search')(request(f));
    assert.equal(result,foreground);assert.equal(calls,1);assert.equal(events.length,0);
    assert.ok(result.hits.length>0);
    await shadow.settle();
    assert.equal(events.length,1);const event=events[0];
    assert.equal(event.status,'compared');assert.ok(event.scientific.ranked.length>0);
    assert.ok(event.overlap.common>0);assert.equal(event.recall,null);
    assert.equal(f.calls(),2); // One query embedding per search; no extraction or compilation.
    assert.equal(event.legacy.ranked.length,result.hits.length);
    assert.ok(event.scientific.ranked.some(r=>r.kind==='equation'));
    assert.ok(!JSON.stringify(event).includes('Original method'));
    assert.deepEqual(f.db.serialize(),before);
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);
    assert.deepEqual(await readFile(f.source),source);assert.deepEqual(await readFile(join(f.root,f.data.paperIR.path)),ir);
  } finally {await shadow.shutdown();f.db.pragma('query_only = OFF');await f.close();}
});

test('disabled, invalid, global, other-project and unmatched-document policies never expand shadow scope', async () => {
  const f=await scientificSearchFixture(api), events=[];let setting=null, searches=0;
  const shadow=new Shadow(f.embeddings,{snapshots:f.router.snapshots,search:async (...args)=>{searches++;return f.router.search(...args);}},
    ()=>setting,e=>events.push(e));
  try {
    for (setting of [null,{}, {projectIds:['foreign']}, {...policy(f),concurrency:0}]) await shadow.search(request(f));
    await shadow.settle();assert.equal(searches,0);assert.equal(events.length,0);
    setting=policy(f);
    await shadow.search({...request(f),projectId:null});await shadow.settle();assert.equal(searches,0);
    await assert.rejects(shadow.search({...request(f),documentId:'not-a-current-knowledge-document'}),
      /research_knowledge_project_mismatch/);await shadow.settle();
    assert.equal(events.at(-1).reason,'no_scientific_generation');assert.equal(searches,0);
    await shadow.search({...request(f),documentId:f.ir.identity.knowledgeDocumentId});await shadow.settle();
    assert.equal(searches,1);assert.equal(events.at(-1).status,'compared');
  } finally {await shadow.shutdown();await f.close();}
});

test('capacity bounds, timeout, cancellation and shutdown await background settlement without delaying foreground', async () => {
  const f=await scientificSearchFixture(api);
  try {
    const old=await f.embeddings.search(request(f));
    for (const mode of ['timeout','cancel','shutdown']) {
      const entered=deferred(), release=deferred(), events=[];let aborted=false, settled=false;
      const shadow=new Shadow({search:async()=>old},{snapshots:f.router.snapshots,search:async(_request,signal)=>{
        signal.addEventListener('abort',()=>{aborted=true;release.resolve();},{once:true});entered.resolve();
        await release.promise;await new Promise(resolve=>setImmediate(resolve));settled=true;signal.throwIfAborted();
      }},()=>({...policy(f),timeoutMs:mode==='timeout'?15:10000}),e=>events.push(e));
      const controller=new AbortController();
      try {
        assert.equal(await shadow.search(request(f),controller.signal),old);await entered.promise;
        assert.equal(await shadow.search(request(f)),old);assert.equal(events[0].reason,'capacity');
        if(mode==='cancel') controller.abort();
        if(mode==='shutdown') await shadow.shutdown();else await shadow.settle();
        assert.equal(aborted,true);assert.equal(settled,true);
        assert.equal(events.at(-1).status,mode==='timeout'?'timeout':'cancelled');
      } finally {release.resolve();await shadow.shutdown();}
      await assert.rejects(shadow.search(request(f)),/shadow_closed/);
    }
  } finally {await f.close();}
});

test('source changes reject shadow; errors and diagnostic failures preserve the exact legacy result', async () => {
  const f=await scientificSearchFixture(api), events=[];let shadow;
  try {
    const old=await f.embeddings.search(request(f)), before=f.db.serialize(), entered=deferred(), release=deferred();
    f.provider(async texts=>{entered.resolve();await release.promise;return texts.map(()=>[1,0,0]);});
    shadow=new Shadow({search:async()=>old},f.router,()=>policy(f),event=>events.push(event));
    assert.equal(await shadow.search(request(f)),old);await entered.promise;
    await writeFile(f.source,Buffer.from('changed source'));release.resolve();await shadow.settle();
    assert.equal(events[0].status,'failed');assert.equal(events[0].scientific.status,'error');
    assert.deepEqual(f.db.serialize(),before);await shadow.shutdown();
    shadow=new Shadow({search:async()=>old},f.router,()=>policy(f),()=>{throw new Error('diagnostic failure');});
    assert.equal(await shadow.search(request(f)),old);await shadow.settle();
    assert.equal(hash(await readFile(f.source)),hash(Buffer.from('changed source')));
  } finally {await shadow?.shutdown();await f.close();}
});

test('foreground failure is returned unchanged and retained in comparison diagnostics', async () => {
  const f=await scientificSearchFixture(api), events=[], failure=new Error('research_fixture_failed');
  const shadow=new Shadow({search:async()=>{throw failure;}},f.router,()=>policy(f),event=>events.push(event));
  try {
    await assert.rejects(shadow.search(request(f)),error=>error===failure);await shadow.settle();
    assert.equal(events[0].legacy.status,'error');assert.equal(events[0].legacy.error,failure.message);
    assert.equal(events[0].scientific.status,'ok');assert.equal(events[0].overlap,null);
  } finally {await shadow.shutdown();await f.close();}
});
