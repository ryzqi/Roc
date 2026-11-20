import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {fuseScientificCandidates,compareScientificRelevance}=await importTypeScriptModule(
  'src/main/plugins/research/scientific-retrieval-fusion.ts',{platform:'node',tempDir:'.runtime/tmp'});
const hash=value=>createHash('sha256').update(value).digest('hex');
function candidate(id,rank=1,method='fts') {
  return {id,generationId:'generation',paperId:'paper',documentId:'document',objectId:id,chunkId:id,
    objectType:'paragraph',selection:null,title:'Source',sectionPath:[],semanticRoles:[],content:id,contentHash:hash(id),
    sourceLocator:null,sources:[],relationIds:[],object:{kind:'text'},
    signals:[{channel:'text',method,rank,score:0}],score:0};
}
test('RRF uses independent ranks, retains source identities and does not count duplicate channel lists',()=>{
  const a=candidate('a',2),dense=candidate('a',3,'dense'),b=candidate('b',1);
  const original=structuredClone([a,dense,b]);
  const merged=fuseScientificCandidates([[a,b],[dense],[a,dense]]);
  assert.deepEqual(merged.map(c=>c.id),['a','b']);
  assert.equal(merged[0].score,1/62+1/63);
  assert.equal(merged[0].signals.length,2);
  assert.equal(merged[0].contentHash,a.contentHash);
  assert.deepEqual([a,dense,b],original);
  assert.throws(()=>fuseScientificCandidates([[a],[{...a,content:'changed'}]]),/identity_conflict/);
});
test('object, exact identifier and role preferences resolve ties without overriding higher relevance',()=>{
  const plan={intents:['table'],filters:{sectionRoles:['method']}};
  const text=candidate('a-text'),table={...candidate('z-table'),objectType:'table_row_group',
    object:{kind:'table',number:'3',caption:'Original',rows:[],columns:[],cells:[],footnotes:[]}};
  assert.equal(fuseScientificCandidates([[text,table]],plan)[0].id,'z-table');
  assert.equal(fuseScientificCandidates([[text,{...table,signals:[{channel:'table',method:'exact',rank:2,score:1}]}]],plan)[0].id,'a-text');
  assert.ok(compareScientificRelevance(.02,.01,false,true)<0);
  assert.ok(compareScientificRelevance(.02,.02,false,true)>0);
});
