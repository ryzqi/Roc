import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {ResearchRerankerService} = await importTypeScriptModule('src/main/plugins/research/reranker-service.ts', {platform:'node',tempDir:resolve('.runtime')});
const {routeScientificQuery,selectDiverse} = await importTypeScriptModule('src/main/plugins/research/query-routing.ts', {platform:'node',tempDir:resolve('.runtime')});

test('semantic provider validates scores, preserves cancellation and falls back on timeout/config absence', async()=>{
  const values=new Map(), secrets=new Map(), signal=new AbortController().signal;
  const context={config:{get:key=>values.get(key)??null,set:(key,value)=>values.set(key,value)},
    secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>secrets.set(key,value),clear:key=>secrets.delete(key)},
    logger:{warn(){}}};
  const service=new ResearchRerankerService(context,async(_url,init)=>{
    const input=JSON.parse(init.body);
    assert.equal(input.query,'same inference budget');
    assert.equal(input.documents.length,2);
    return Response.json({results:[{index:1,relevance_score:0.9},{index:0,relevance_score:0.1}]});
  });
  assert.equal((await service.rank('q',['a'],signal)).receipt.status,'config_missing');
  const config={endpoint:'https://fixture.invalid/rerank',model:'cross-encoder',enabled:true,timeoutMs:100,apiKey:'secret'};
  const saved=await service.saveConfig(config);
  assert.equal(saved.apiKey,undefined);
  assert.ok(!JSON.stringify([...values.values()]).includes('"secret"'));
  assert.deepEqual((await service.rank('same inference budget',['cost rises','same cost'],signal)).scores,[0.1,0.9]);
  const slow=new ResearchRerankerService(context,async(_url,init)=>new Promise((_,reject)=>{
    init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }));
  // Keep the event loop alive while AbortSignal.timeout's unref timer fires.
  const keepAlive=setInterval(()=>{},1000);
  try {
    assert.equal((await slow.rank('q',['a'],signal)).receipt.status,'timeout');
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(slow.rank('q',['a'],cancelled.signal));
  } finally {clearInterval(keepAlive);}
  assert.deepEqual(routeScientificQuery('compare models',null),{intent:'comparison',documentId:null,diversify:true});
  assert.equal(routeScientificQuery('compare models','paper').diversify,false);
  const hits=['a','a','a','b','c'].map(documentId=>({documentId}));
  assert.deepEqual(selectDiverse(hits,4,true).map(hit=>hit.documentId),['a','a','b','c']);
});
