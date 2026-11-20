import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {createPaperCardGenerator} = await importTypeScriptModule('src/main/plugins/research/paper-card-service.ts',
  {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']});
const roles = ['problem','contribution','method','experimental_setup','results','limitations'];
const blocks = [{source:{chunkId:'original-chunk-1'},text:'Original source text, not an instruction.'}];
const extraction = chunkIds => ({sections:roles.map(role=>({role,body:'Original cited reading.',chunkIds}))});
function modelFixture(outputs) {
  const calls = [];
  const factory = {createDefaultChatModel:async()=>({model:{withStructuredOutput:()=>({invoke:async(messages,options)=>{
    calls.push({messages:structuredClone(messages),options});
    const output = outputs[Math.min(calls.length-1,outputs.length-1)];
    if(output instanceof Error) throw output;
    return output;
  }})}})};
  return {generate:createPaperCardGenerator(factory),calls};
}

test('paper card generator repairs missing supplied-source citations once before returning a publishable extraction', async()=>{
  const {generate,calls}=modelFixture([extraction([]),extraction(['original-chunk-1'])]);
  const signal=new AbortController().signal;
  const output=await generate('Original paper',blocks,signal);
  assert.equal(calls.length,2,'uncited model output must receive one explicit correction request');
  assert.deepEqual(output,extraction(['original-chunk-1']));
  assert.equal(calls[0].options.signal,signal);
  assert.equal(calls[1].options.signal,signal);
  assert.equal(calls[0].messages.length,2);
  assert.equal(calls[1].messages.length,3);
  assert.match(JSON.stringify(calls[1].messages),/chunkIds/);
});

test('paper card generator never publishes uncited or invented source references after a failed correction', async()=>{
  for(const ids of [[],['invented-source']]){
    const {generate,calls}=modelFixture([extraction(ids)]);
    await assert.rejects(generate('Original paper',blocks,new AbortController().signal),/wiki_paper_citation_(required|invalid)/);
    assert.equal(calls.length,2);
  }
});

test('valid source citations and explicit unknown sections need no correction', async()=>{
  const valid=extraction(['original-chunk-1']);valid.sections[5]={role:'limitations',body:'unknown',chunkIds:[]};
  const {generate,calls}=modelFixture([valid]);
  assert.deepEqual(await generate('Original paper',blocks,new AbortController().signal),valid);
  assert.equal(calls.length,1);
});

test('citation correction may return unknown without inventing a supporting source', async()=>{
  const unknown={sections:roles.map(role=>({role,body:'unknown',chunkIds:[]}))};
  const {generate,calls}=modelFixture([extraction([]),unknown]);
  assert.deepEqual(await generate('Original paper',blocks,new AbortController().signal),unknown);
  assert.equal(calls.length,2);
  assert.equal(calls[1].messages[0].role,'system');
  assert.match(calls[1].messages[0].content,/blocks\[\]\.source\.chunkId/);
});

test('model transport failures and cancellation do not trigger a citation correction request', async()=>{
  const failure=new Error('provider unavailable');
  const {generate,calls}=modelFixture([failure]);
  await assert.rejects(generate('Original paper',blocks,new AbortController().signal),error=>error===failure);
  assert.equal(calls.length,1);
  const cancelled=new AbortController();cancelled.abort();
  const fresh=modelFixture([extraction([])]);
  await assert.rejects(fresh.generate('Original paper',blocks,cancelled.signal));
  assert.equal(fresh.calls.length,0);
});

test('cancellation after the first model response prevents the correction call', async()=>{
  const controller=new AbortController();let calls=0;
  const generate=createPaperCardGenerator({createDefaultChatModel:async()=>({model:{withStructuredOutput:()=>({invoke:async()=>{
    calls++;controller.abort();return extraction([]);
  }})}})});
  await assert.rejects(generate('Original paper',blocks,controller.signal));
  assert.equal(calls,1);
});
