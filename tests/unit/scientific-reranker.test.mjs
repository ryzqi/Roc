import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';
let api, rerank;
before(async () => {
  [api, rerank] = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-reranker.ts', {platform:'node',tempDir:'.runtime/tmp'})]);
});
after(() => api?.dispose());
const {ResearchRerankerService} = await importTypeScriptModule('src/main/plugins/research/reranker-service.ts',
  {platform:'node',tempDir:'.runtime/tmp'});
async function provider(fetchImpl, enabled = true) {
  const values = new Map(), secrets = new Map();
  const service = new ResearchRerankerService({
    config:{get:key=>values.get(key)??null,set:(key,value)=>values.set(key,value)},
    secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>secrets.set(key,value),clear:key=>secrets.delete(key)},
    logger:{warn(){}}
  }, fetchImpl);
  await service.saveConfig({endpoint:'https://fixture.invalid/rerank',model:'fixture',apiKey:'fixture-secret',enabled,timeoutMs:100});
  return service;
}
test('structured Cohere input preserves cells, formulas and source identity while provider scores reorder hits', async () => {
  let documents;
  const service = await provider(async (_url, init) => {
    const body = JSON.parse(init.body); documents = body.documents;
    assert.equal(body.top_n, documents.length);
    for (const text of documents) for (const key of ['paperTitle','sectionPath','semanticRoles','objectType','caption','content','metadata','relations']) {
      assert.ok(text.includes(`${key}:`));
    }
    const index = documents.findIndex(text => text.includes('"text":"91"'));
    assert.ok(index >= 0);
    assert.ok(documents.some(text => text.includes('x = y \\\\tag{7}')));
    return Response.json({results: documents.map((_text, i) => ({
      index:i,relevance_score:i===index?.95:.1,id:'forged',content:'provider changed source'
    })).reverse()});
  });
  const f = await scientificSearchFixture(api,{embedded:false,reranker:service});
  try {
    const query = 'Compare Dataset C F1 Table 3 and Equation (7)';
    const original = await f.router.search({...f.request(query),rerank:'none'});
    const ranked = await f.router.search(f.request(query));
    assert.equal(ranked.ranking.method,'reranker');
    assert.equal(ranked.ranking.reranker.status,'succeeded');
    assert.equal(ranked.ranking.rerank.scores.length,ranked.candidates.length);
    assert.deepEqual(ranked.candidates,original.candidates);
    assert.ok(ranked.hits[0].object.cells.some(cell=>cell.text==='91'));
    assert.ok(ranked.hits.every(hit=>JSON.stringify(hit)===JSON.stringify(original.candidates.find(c=>c.id===hit.id))));
    assert.ok(!JSON.stringify(ranked).includes('forged'));
    await f.router.assertCurrent(ranked);
  } finally {await f.close();}
});
test('HTTP failure, malformed provider indexes, disabled config and timeout retain the actual RRF order and reason', async () => {
  for (const kind of ['http','indexes','disabled','timeout']) {
    const service = await provider(async (_url, init) => {
      if (kind==='http') return new Response('',{status:429});
      if (kind==='indexes') return Response.json({results:[{index:0,relevance_score:.9},{index:0,relevance_score:.5}]});
      return await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
    },kind!=='disabled');
    const f = await scientificSearchFixture(api,{embedded:false,reranker:service});
    const keepAlive = setInterval(()=>{},1000);
    try {
      const request = f.request('Table 3');
      const expected = await f.router.search({...request,rerank:'none'}), actual = await f.router.search(request);
      assert.deepEqual(actual.hits,expected.hits);assert.deepEqual(actual.candidates,expected.candidates);
      assert.equal(actual.ranking.method,'rrf');
      assert.equal(actual.ranking.reranker.status,kind==='disabled'?'disabled':kind==='timeout'?'timeout':'failed');
      assert.deepEqual(actual.ranking.rerank.degradation,[`rerank_${actual.ranking.reranker.status}`]);
    } finally {clearInterval(keepAlive);await f.close();}
  }
});
test('complete-input budgets skip the provider without truncating original candidates', async () => {
  const f = await scientificSearchFixture(api,{embedded:false});
  try {
    const result = await f.router.search({...f.request('Table 3'),rerank:'none'});
    const papers = await f.router.snapshots.capture(f.project.id,[f.generation],new AbortController().signal);
    let calls = 0;
    const service = {rank:async()=>{calls++;throw new Error('must not call');}};
    for (const budget of [{candidates:0,documentTokens:4096,totalTokens:64000},
      {candidates:200,documentTokens:1,totalTokens:64000},{candidates:200,documentTokens:4096,totalTokens:1}]) {
      const actual = await rerank.rerankScientificCandidates(result.plan,result.candidates,papers,service,true,
        new AbortController().signal,budget);
      assert.deepEqual(actual.ordered,result.candidates);assert.equal(actual.method,'rrf');
      assert.ok(actual.rerank.degradation[0].includes('budget_exceeded'));
    }
    assert.equal(calls,0);
  } finally {await f.close();}
});
test('cancellation and source changes across the provider wait reject the request', async () => {
  for (const kind of ['cancel','source','parse']) {
    let enter, release;const entered = new Promise(resolve=>{enter=resolve;});
    const wait = new Promise(resolve=>{release=resolve;});
    const service = {rank:async(_query,documents,signal)=>{
      enter();await wait;signal.throwIfAborted();
      return {scores:documents.map(()=>.5),receipt:{status:'succeeded',model:'fixture',configHash:null,elapsedMs:1}};
    }};
    const f = await scientificSearchFixture(api,{embedded:false,reranker:service});
    try {
      const controller = new AbortController(), operation = f.router.search(f.request('Table 3'),controller.signal);
      const rejected = assert.rejects(operation,/cancel|source_changed|source_size|source_hash/);
      await entered;
      if (kind==='cancel') controller.abort(new Error('fixture-cancel'));
      if (kind==='source') await writeFile(f.source,Buffer.concat([f.bytes,Buffer.from('\n% changed')]));
      if (kind==='parse') await f.publish();
      release();await rejected;
    } finally {release?.();await f.close();}
  }
});
