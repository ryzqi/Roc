import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {polishRequest,parsePolishReplacement,verifyPolishSource,startPolishRun} = await importTypeScriptModule('src/renderer/latex/inline-polish.ts');
const source={requestId:'request-1',projectId:'project-1',workspacePath:'/workspace',filePath:'main.tex',
  from:0,to:4,original:'Text',draft:'Text and notes',baseline:'Text and notes'};
const ok=data=>({ok:true,data});

function fixture({replayEvents=[],snapshot,mode='plan'}={}) {
  const listeners=new Set(),starts=[],accepted=[],completed=[],failed=[];
  let resolveStart;
  const receipt={runId:'run-1',threadId:'thread-1',mode};
  const client={api:{chat:{
    onRunEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    startRun:input=>{starts.push(input);return new Promise(resolve=>{resolveStart=resolve;});},
    replayRunEvents:async()=>ok({kind:snapshot===undefined?'events':'replay_gap',runId:'run-1',
      ...(snapshot===undefined?{}:{snapshot:{state:snapshot}}),events:replayEvents})
  }}};
  const operation=startPolishRun(client,source,{isCurrent:()=>true,accepted:x=>accepted.push(x),completed:x=>completed.push(x),failed:x=>failed.push(x)});
  return {listeners,starts,accepted,completed,failed,operation,receipt,
    accept:()=>resolveStart(ok(receipt)),emit:event=>{for(const listener of listeners)listener(event);}};
}

test('polish uses existing readonly plan, unique dispatch, project binding and bounded response contract',()=>{
  const request=polishRequest(source);
  assert.equal(request.mode,'plan');assert.equal(request.threadId,null);
  assert.equal(request.researchProjectId,'project-1');assert.equal(request.dispatchKey,'request-1');
  assert.deepEqual(request.enabledCapabilities,{mcpServers:[],skills:[]});
  assert.deepEqual(request.responseContract.schema.properties.requestId.enum,['request-1']);
  assert.equal(request.responseContract.schema.additionalProperties,false);
  assert.ok(!request.input.includes('and notes'),'unselected draft text is not attached to this request');
  assert.equal(parsePolishReplacement('{"requestId":"request-1","replacement":"Better"}','request-1'),'Better');
  for(const response of ['plain text','{"requestId":"wrong","replacement":"Better"}',
    '{"requestId":"request-1","replacement":" "}','{"requestId":"request-1","replacement":"Better","write":true}']) {
    assert.throws(()=>parsePolishReplacement(response,'request-1'));
  }
});

test('only accepted run and thread terminal results produce a proposal; live/replay duplicates settle once',async()=>{
  const f=fixture();
  const event={type:'run_completed',runId:'run-1',threadId:'thread-1',assistantMessage:'Reading a reference. Followed by JSON.',
    validatedResponse:'{"requestId":"request-1","replacement":"Better"}'};
  f.emit(event);assert.equal(f.completed.length,0,'before receipt no event is trusted');
  f.accept();await f.operation.started;
  f.emit({...event,runId:'other'});f.emit({...event,threadId:'other'});
  assert.equal(f.completed.length,0);
  f.emit({runId:'run-1',sequence:3,event});f.emit(event);
  assert.equal(f.completed.length,1);assert.equal(f.completed[0].receipt,f.receipt);
  assert.equal(f.listeners.size,0);assert.equal(f.failed.length,0);
});

test('durable replay recovers a completed event that arrived before start returned',async()=>{
  const event={type:'run_completed',runId:'run-1',threadId:'thread-1',assistantMessage:'Read-only tool narration.',
    validatedResponse:'{"requestId":"request-1","replacement":"Better"}'};
  const f=fixture({replayEvents:[{runId:'run-1',sequence:1,event}]});
  f.accept();await f.operation.started;
  assert.equal(f.completed.length,1);assert.equal(f.listeners.size,0);
});

test('disposal during dispatch never adopts a late receipt or emits a proposal',async()=>{
  const f=fixture();f.operation.dispose();f.accept();await f.operation.started;
  assert.equal(f.accepted.length,0);assert.equal(f.completed.length,0);assert.equal(f.listeners.size,0);
});

test('only a validated final response is accepted, never a JSON-looking aggregate or malformed final output',async()=>{
  for(const validatedResponse of [undefined,'invalid','{"requestId":"other","replacement":"Better"}']) {
    const f=fixture();f.accept();await f.operation.started;
    f.emit({type:'run_completed',runId:'run-1',threadId:'thread-1',
      assistantMessage:'{"requestId":"request-1","replacement":"Better"}',validatedResponse});
    assert.equal(f.completed.length,0);assert.equal(f.failed.length,1);assert.equal(f.listeners.size,0);
  }
});

test('replay-gap completion uses the validated response and rejects legacy, failed and mismatched snapshots',async()=>{
  const valid={runId:'run-1',threadId:'thread-1',status:'completed',assistantMessage:'Reading. JSON follows.',
    validatedResponse:'{"requestId":"request-1","replacement":"Better"}'};
  const scenarios=[{snapshot:valid,success:true},
    {snapshot:{...valid,validatedResponse:undefined}},
    {snapshot:{...valid,status:'failed',errorMessage:'Model failed'}},
    {snapshot:{...valid,status:'cancelled',errorMessage:null}},
    {snapshot:{...valid,runId:'other'}},{snapshot:{...valid,threadId:'other'}}];
  for(const scenario of scenarios) {
    const f=fixture(scenario);f.accept();await f.operation.started;
    assert.equal(f.completed.length,scenario.success?1:0);
    assert.equal(f.failed.length,scenario.success?0:1);assert.equal(f.listeners.size,0);
  }
});

test('malformed output, failure, cancellation and an unexpected writable mode remove observers without a proposal',async()=>{
  for(const kind of ['run_completed','run_failed','run_cancelled','wrong-mode']) {
    const f=fixture({mode:kind==='wrong-mode'?'chat':'plan'});f.accept();await f.operation.started;
    f.emit({type:kind,runId:'run-1',threadId:'thread-1',assistantMessage:'not JSON',message:'Model failed'});
    assert.equal(f.failed.length,1);assert.equal(f.completed.length,0);assert.equal(f.listeners.size,0);
  }
});

test('source validation rejects disk changes, truncation and workspace changes; invalidated work stops before file reads',async()=>{
  let reads=0,workspace='/workspace',content=source.baseline,truncated=false;
  const client={api:{workspace:{getCurrent:async()=>ok({path:workspace})},files:{preview:async()=>{
    reads++;return ok({relativePath:'main.tex',kind:'text',content,truncated});
  }}}};
  assert.equal(await verifyPolishSource(client,source,()=>true),true);
  assert.equal(await verifyPolishSource(client,source,()=>false),false);assert.equal(reads,1);
  content='external edit';await assert.rejects(verifyPolishSource(client,source,()=>true),/原文件已变化/u);
  content=source.baseline;truncated=true;await assert.rejects(verifyPolishSource(client,source,()=>true),/原文件已变化/u);
  workspace='/other';await assert.rejects(verifyPolishSource(client,source,()=>true),/工作目录已变化/u);
});
