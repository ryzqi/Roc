import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test, after} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import {ChatOpenAI} from '@langchain/openai';

const directory = mkdtempSync(resolve('.runtime/agent-resume-'));
const bundle = join(directory, 'api.mjs');
await build({entryPoints:['tests/unit/fixtures/agent-resume-test-api.ts'],outfile:bundle,
  bundle:true,packages:'external',platform:'node',format:'esm',loader:{'.md':'text'},logLevel:'silent'});
const api = await import(pathToFileURL(bundle).href);
after(() => rmSync(directory, {recursive:true,force:true}));

function open(file, fetch, deepAgentExecutor, checkpointReader) {
  const db = new Database(file);
  api.applyAgentDatabaseSchema(db);
  const memory = new Database(':memory:');
  api.applyMemoryDatabaseSchema(memory);
  const paths = new api.RocPaths(join(directory, 'state')); paths.ensureTree();
  const model = new ChatOpenAI({model:'resume-fixture',apiKey:'fixture',maxRetries:0,maxTokens:512,
    configuration:{baseURL:'http://fixture.invalid/v1',fetch}});
  const handle = {model,modelId:'resume-fixture',
    provider:{id:'fixture',name:'Fixture',type:'openai_compatible',enabled:true,models:[],endpoint:'http://fixture.invalid/v1',credentialRef:null},
    runtime:{providerType:'openai_compatible',baseUrl:null,streaming:false,modelKwargs:{},contextWindowTokens:65536,maxOutputTokens:512}};
  const eventBus = new api.EventBus({error:() => {}});
  const runEventLog = new api.AgentRunEventLog(db);
  const repository = new api.AgentSessionRepository(db,{runEventLog,...(deepAgentExecutor ? {
    // The transport-only executor stands in for a graph that saved its checkpoint.
    checkpointer:checkpointReader ?? {hasCheckpoint:()=>true,readPendingInterrupts:()=>[]}
  } : {})});
  const ledger = new api.RunUsageLedger(db);
  const manifestBase = {schemaVersion:1,requestedCapabilities:{mcpServers:[],skills:[]},
    resolvedCapabilities:{mcpServers:[],skills:[]},skippedCapabilities:[],tools:[],skills:[],mcpServers:[],
    untrustedContextPolicy:'external_content_reference_only'};
  const manifest = {...manifestBase,manifestHash:api.createRunCapabilityManifestHash(manifestBase)};
  const runtime = new api.AgentPluginRuntime({repository,eventBus,runEventLog,executionGrantBroker:api.openExecutionGrantBroker(db),
    deepAgentExecutor:deepAgentExecutor ?? api.createAgentDeepAgentExecutor({executionGrantBroker:api.openExecutionGrantBroker(db),
      usageLedger:ledger,capabilities:new api.CapabilityRegistry(),checkpointer:new api.RocSqliteCheckpointer(db),
      contextArtifactStore:new api.ContextArtifactStore(db),paths,sessionHistory:repository,
      store:new api.RocSqliteStore(memory),toolEffectStore:new api.AgentToolEffectStore(db)}),
    modelFactory:{createDefaultModelHandle:async()=>({providerId:'fixture',modelId:handle.modelId,langChainHandle:handle}),
      createModelHandleByProviderAndModel:async()=>({providerId:'fixture',modelId:handle.modelId,langChainHandle:handle})},
    capabilityPreviewProvider:async()=>({runnable:false,modelId:handle.modelId,builtInTools:[],toolCards:[],skillCards:[],
      subagents:[],interruptOn:{},manifest,reason:'Local transport fixture'})});
  return {db,repository,runtime,ledger,eventBus,async close(){
    for (const {id} of db.prepare("SELECT id FROM agent_runs WHERE status='running'").all()) {
      await runtime.cancelRun({runId:id});
    }
    await runtime.shutdown();db.close();memory.close();
  }};
}

test('cold resume preserves frozen inputs and unknown usage', {timeout:20000}, async () => {
  const requested = Promise.withResolvers();
  const first = open(join(directory,'before.db'),async (_url,init) => {
    requested.resolve();
    return await new Promise((_resolve,reject) => {
      init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
    });
  });
  let reopened;
  try {
    const started = await first.runtime.startRun({input:'Return exactly resumed.',mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]}});
    await requested.promise;
    assert.equal(first.repository.hasCheckpoint(started.runId),true);
    let snapshot = first.repository.getRunExecutionSnapshot(started.runId);
    const beforeCalls = first.db.prepare('SELECT * FROM agent_calls ORDER BY call_id').all();
    assert.equal(beforeCalls.length,1);assert.equal(beforeCalls[0].state,'reserved');
    // Capture the exact crash boundary before abort/shutdown can write a terminal state.
    await first.db.backup(join(directory,'reopened.db'));
    await first.close();
    let requests = 0;
    reopened = open(join(directory,'reopened.db'),async () => {
      requests++;
      const chunk = {id:'resume',object:'chat.completion.chunk',created:0,model:'resume-fixture',
        choices:[{index:0,delta:{role:'assistant',content:'resumed'},finish_reason:'stop'}]};
      const usage = {...chunk,choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
        {headers:{'content-type':'text/event-stream'}});
    });
    const reconciled = reopened.repository.reconcileStartupRuns();
    reopened.ledger.reconcileStartup();
    assert.equal(reconciled.length,1);assert.equal(reconciled[0].id,started.runId);
    assert.equal(reconciled[0].status,'interrupted');
    assert.deepEqual(reopened.repository.getRunExecutionSnapshot(started.runId),snapshot);
    const terminal = Promise.withResolvers();
    reopened.eventBus.subscribe('agent.run.completed',event=>terminal.resolve(event.payload));
    reopened.eventBus.subscribe('agent.run.failed',event=>terminal.reject(new Error(JSON.stringify(event.payload))));
    const result = await reopened.runtime.resumeRun({kind:'checkpoint',runId:started.runId,threadId:started.threadId});
    assert.equal(result.runId,started.runId);assert.equal(result.threadId,started.threadId);
    assert.equal((await terminal.promise).assistantMessage,'resumed');
    assert.equal(requests,1);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get(),1);
    const afterCalls = reopened.db.prepare('SELECT * FROM agent_calls ORDER BY call_id').all();
    assert.equal(afterCalls.length,2);
    assert.deepEqual(afterCalls.find(row=>row.call_id===beforeCalls[0].call_id),{...beforeCalls[0],state:'unknown'});
    assert.equal(afterCalls.find(row=>row.call_id!==beforeCalls[0].call_id).state,'settled');
    await assert.rejects(reopened.runtime.resumeRun({kind:'checkpoint',runId:started.runId,threadId:started.threadId}),/not_interrupted/);
    assert.equal(requests,1);
  } finally {
    if(first.db.open) await first.close();
    if(reopened) await reopened.close();
  }
});

const responseContract = {
  format:'json', schema:{type:'object',properties:{answer:{type:'string',minLength:1}},
    required:['answer'],additionalProperties:false}
};
function streamedResponse(text) {
  // Provider IDs identify graph messages; separate completions must not overwrite one another.
  const chunk={id:`response-contract-${randomUUID()}`,object:'chat.completion.chunk',created:0,model:'resume-fixture',
    choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:'stop'}]};
  const usage={...chunk,choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
    {headers:{'content-type':'text/event-stream'}});
}
function waitForCompletion(fixture) {
  const terminal=Promise.withResolvers();
  fixture.eventBus.subscribe('agent.run.completed',event=>terminal.resolve(event.payload));
  fixture.eventBus.subscribe('agent.run.failed',event=>terminal.reject(new Error(JSON.stringify(event.payload))));
  return terminal.promise;
}
function readRootCheckpoint(db) {
  const row=db.prepare("SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1").get();
  return JSON.parse(row.checkpoint_blob.toString()).channel_values;
}

test('response correction survives a crash and a new run on the same thread gets its own single correction', {timeout:20000}, async()=>{
  const requested=Promise.withResolvers(), beforeRequests=[];
  const first=open(join(directory,'response-before.db'),async(_url,init)=>{
    beforeRequests.push(JSON.parse(init.body));
    if(beforeRequests.length===1) return streamedResponse('Preface. {"answer":"first"}');
    requested.resolve();
    return await new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
    });
  });
  let reopened;
  try {
    const started=await first.runtime.startRun({input:'Return only JSON with answer.',mode:'chat',
      enabledCapabilities:{mcpServers:[],skills:[]},responseContract});
    await requested.promise;
    const snapshot=first.repository.getRunExecutionSnapshot(started.runId);
    assert.deepEqual(snapshot.taskContract.responseContract,responseContract);
    assert.equal(beforeRequests.length,2);
    assert.deepEqual(readRootCheckpoint(first.db).rocResponseCorrection,{runId:started.runId,attempts:1});
    const beforeCalls=first.db.prepare("SELECT state FROM agent_calls WHERE kind='model' ORDER BY rowid").all();
    assert.deepEqual(beforeCalls.map(call=>call.state),['settled','reserved']);
    await first.db.backup(join(directory,'response-reopened.db'));
    await first.close();
    const afterRequests=[];
    reopened=open(join(directory,'response-reopened.db'),async(_url,init)=>{
      afterRequests.push(JSON.parse(init.body));
      return streamedResponse(afterRequests.length<3 ? 'Still invalid. {"answer":"next"}' : '{"answer":"valid"}');
    });
    reopened.repository.reconcileStartupRuns();reopened.ledger.reconcileStartup();
    assert.deepEqual(reopened.repository.getRunExecutionSnapshot(started.runId),snapshot);
    const resumed=waitForCompletion(reopened);
    await reopened.runtime.resumeRun({kind:'checkpoint',runId:started.runId,threadId:started.threadId});
    await resumed;
    assert.equal(afterRequests.length,1,'restart cannot replenish the consumed correction');
    assert.equal(reopened.repository.getRun(started.runId).status,'completed');
    const failed=reopened.repository.taskContracts.readReport(started.runId);
    assert.equal(failed.criteria[0].verdict,'failed');
    assert.equal(failed.criteria[0].verifier,'response_json_schema');
    assert.equal(readRootCheckpoint(reopened.db).messages.filter(message=>
      message.kwargs.id===`roc-response-correction:${started.runId}`).length,1);
    await reopened.runtime.replayRunEvents({runId:started.runId,afterSequence:0});
    assert.equal(reopened.repository.taskContracts.readReport(started.runId).criteria[0].verdict,'failed');
    const newDone=waitForCompletion(reopened);
    const next=await reopened.runtime.startRun({threadId:started.threadId,input:'Return only JSON with answer.',
      mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]},responseContract});
    await newDone;
    assert.notEqual(next.runId,started.runId);assert.equal(next.threadId,started.threadId);
    assert.equal(afterRequests.length,3,'new run gets one correction and then succeeds');
    assert.equal(reopened.repository.taskContracts.readReport(next.runId).status,'satisfied');
    const checkpoint=readRootCheckpoint(reopened.db);
    assert.deepEqual(checkpoint.rocResponseCorrection,{runId:next.runId,attempts:1});
    assert.equal(checkpoint.messages.filter(message=>message.kwargs.id===`roc-response-correction:${next.runId}`).length,1);
    const usage=reopened.db.prepare("SELECT state FROM agent_calls WHERE kind='model' ORDER BY rowid").all();
    assert.deepEqual(usage.map(call=>call.state),['settled','unknown','settled','settled','settled']);
  } finally {
    if(first.db.open) await first.close();
    if(reopened) await reopened.close();
  }
});

for(const scenario of [
  {name:'missing terminal response',finalMessage:'{"answer":"aggregate"}',verdict:'failed'},
  {name:'invalid terminal response',finalMessage:'{"answer":"aggregate"}',finalResponse:'Preface. {"answer":"bad"}',verdict:'failed'},
  {name:'valid terminal response with narration',finalMessage:'Reading. {"answer":"terminal"}',finalResponse:'{"answer":"terminal"}',verdict:'passed'}
]) test(`runtime acceptance uses ${scenario.name} independently of aggregate session text`,{timeout:10000},async()=>{
  const usage={callCount:0,inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheCreationTokens:0};
  const fixture=open(':memory:',async()=>assert.fail('boundary fixture must not dispatch a model'),{
    execute(){return {events:(async function*(){})(),outcome:Promise.resolve({
      status:'completed',finalMessage:scenario.finalMessage,
      ...(Object.hasOwn(scenario,'finalResponse') ? {finalResponse:scenario.finalResponse} : {}),
      summarySource:{successfulToolNames:[]},usage
    })};}
  });
  try {
    const done=waitForCompletion(fixture);
    const started=await fixture.runtime.startRun({input:'Return JSON with answer.',mode:'chat',
      enabledCapabilities:{mcpServers:[],skills:[]},responseContract});
    assert.equal((await done).assistantMessage,scenario.finalMessage);
    const report=fixture.repository.taskContracts.readReport(started.runId);
    assert.equal(report.criteria[0].verdict,scenario.verdict);
    assert.equal(report.criteria[0].verifier,'response_json_schema');
  } finally {await fixture.close();}
});

for (const decision of [
  {type:'approve',reviewedSearchPlanHash:'a'.repeat(64),reviewedArtifactVersions:[{artifactId:'artifact',version:'b'.repeat(64)}]},
  {type:'reject',message:'Revise the evidence',reviewedArtifactVersions:[{artifactId:'artifact',version:'b'.repeat(64)}]},
  {type:'revise',message:'Address reviewer feedback',reviewedArtifactVersions:[{artifactId:'artifact',version:'b'.repeat(64)}]}
]) test(`approval resume preserves ${decision.type} review bindings live and in recorded replay`, {timeout:10000}, async()=>{
  const received=[];
  const usage={callCount:0,inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheCreationTokens:0};
  const fixture=open(':memory:',async()=>assert.fail('resume transport test must not call a model'),{
    execute(input) {
      received.push(input.resumePayload);
      const interrupts=received.length===1 ? [{interruptId:'gate',payload:{kind:'approval',request:{
        actionRequests:[{name:'research_approve_gate',args:{stage:'discovery'}}],
        reviewConfigs:[{actionName:'research_approve_gate',allowedDecisions:['approve','reject','revise']}]
      }}}] : [{interruptId:'question',payload:{kind:'question',question:'Continue?'}}];
      return {events:(async function*(){})(),outcome:Promise.resolve(received.length<3 ?
        {status:'interrupted',interrupts,usage} :
        {status:'completed',finalMessage:'Recorded decisions retained.',summarySource:{successfulToolNames:[]},usage})};
    }
  });
  const nextEvent=type=>new Promise((resolve,reject)=>{
    fixture.eventBus.subscribe(type,event=>{
      if(type!=='agent.chat.run-event'||event.payload.type==='run_interrupted') resolve(event.payload);
    });
    fixture.eventBus.subscribe('agent.run.failed',event=>reject(new Error(JSON.stringify(event.payload))));
  });
  try {
    const firstWait=nextEvent('agent.chat.run-event');
    const started=await fixture.runtime.startRun({input:'Review gate transport',mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]}});
    await firstWait;
    const secondWait=nextEvent('agent.chat.run-event');
    await fixture.runtime.resumeRun({kind:'approval',runId:started.runId,threadId:started.threadId,interruptId:'gate',decisions:[decision]});
    await secondWait;
    assert.deepEqual(received[1].gate,{decisions:[decision]});
    const done=nextEvent('agent.run.completed');
    await fixture.runtime.resumeRun({kind:'question',runId:started.runId,threadId:started.threadId,interruptId:'question',answer:'Yes'});
    await done;
    assert.deepEqual(received[2],{gate:{decisions:[decision]},question:{answer:'Yes'}});
  } finally {await fixture.close();}
});


test('reopened pending approval is discoverable and replayable before any resume', {timeout:10000}, async()=>{
  const file=join(directory,'pending-approval.db');
  const payload={kind:'approval',request:{actionRequests:[{name:'research_approve_gate',args:{stage:'discovery'}}],
    reviewConfigs:[{actionName:'research_approve_gate',allowedDecisions:['approve','reject']}]}};
  const interrupts=[{interruptId:'cold-gate',payload}];
  const checkpointReader={hasCheckpoint:()=>true,readPendingInterrupts:()=>interrupts};
  const usage={callCount:0,inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheCreationTokens:0};
  const first=open(file,async()=>assert.fail('transport fixture must not call a model'),{
    execute(){return {events:(async function*(){})(),outcome:Promise.resolve({status:'interrupted',interrupts,usage})};}
  },checkpointReader);
  let reopened;
  try {
    const interrupted=new Promise((resolve,reject)=>{
      first.eventBus.subscribe('agent.chat.run-event',event=>{if(event.payload.type==='run_interrupted')resolve();});
      first.eventBus.subscribe('agent.run.failed',event=>reject(new Error(JSON.stringify(event.payload))));
    });
    const started=await first.runtime.startRun({input:'Wait for approval',mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]}});
    await interrupted;
    await first.close();
    let executions=0;
    reopened=open(file,async()=>assert.fail('transport fixture must not call a model'),{
      execute(){executions++;return {events:(async function*(){})(),outcome:Promise.resolve({status:'completed',
        finalMessage:'Approved once.',summarySource:{successfulToolNames:[]},usage})};}
    },checkpointReader);
    reopened.repository.reconcileStartupRuns();
    assert.equal(reopened.repository.getRun(started.runId).status,'waiting_user');
    assert.deepEqual(reopened.runtime.getActiveRun({threadId:started.threadId}),{
      runId:started.runId,threadId:started.threadId,status:'waiting_user'
    });
    assert.equal(reopened.runtime.getActiveRun({threadId:'unrelated'}),null);
    const replay=await reopened.runtime.replayRunEvents({runId:started.runId,afterSequence:0});
    assert.ok(JSON.stringify(replay).includes('cold-gate'));
    assert.equal(executions,0);
    const completed=new Promise((resolve,reject)=>{
      reopened.eventBus.subscribe('agent.run.completed',resolve);
      reopened.eventBus.subscribe('agent.run.failed',event=>reject(new Error(JSON.stringify(event.payload))));
    });
    await reopened.runtime.resumeRun({kind:'approval',runId:started.runId,threadId:started.threadId,
      interruptId:'cold-gate',decisions:[{type:'approve'}]});
    await completed;
    assert.equal(executions,1);
    assert.equal(reopened.runtime.getActiveRun({threadId:started.threadId}),null);
  } finally {if(first.db.open)await first.close();if(reopened)await reopened.close();}
});

test('network retry preserves an unconsumed approval resume and continues the same checkpoint', {timeout:10000}, async()=>{
  const decision={type:'reject',message:'Recheck the review evidence.',
    reviewedArtifactVersions:[{artifactId:'review-artifact',version:'b'.repeat(64)}]};
  const resumePayload={'network-gate':{decisions:[decision]}};
  const interrupts=[{interruptId:'network-gate',payload:{kind:'approval',request:{
    actionRequests:[{name:'resume_retry_gate',args:{}}],
    reviewConfigs:[{actionName:'resume_retry_gate',allowedDecisions:['approve','reject']}]
  }}}];
  const usage={callCount:0,inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheCreationTokens:0};
  const received=[];
  const consumed=[];
  let pendingInterrupts=interrupts;
  const fixture=open(':memory:',async()=>assert.fail('resume retry fixture must not call a model'),{
    execute(input) {
      received.push({runId:input.run.id,threadId:input.run.threadId,
        resumePayload:structuredClone(input.resumePayload),resumeFromCheckpoint:input.resumeFromCheckpoint===true});
      if(received.length===1) {
        return {events:(async function*(){})(),outcome:Promise.resolve({status:'interrupted',interrupts,usage})};
      }
      if(received.length===2) {
        // Harness setup fails before the graph can consume or checkpoint the decision.
        const error=new TypeError('fetch failed');
        const outcome=Promise.reject(error);
        void outcome.catch(()=>{});
        return {events:(async function*(){throw error;})(),outcome};
      }
      return {events:(async function*(){
        if(input.resumeFromCheckpoint===true&&input.resumePayload?.['network-gate']!==undefined) {
          consumed.push(structuredClone(input.resumePayload['network-gate']));
          pendingInterrupts=[];
        }
      })(),outcome:Promise.resolve({status:'completed',finalMessage:'Resumed after network recovery.',
        summarySource:{successfulToolNames:[]},usage})};
    }
  },{hasCheckpoint:()=>true,readPendingInterrupts:()=>pendingInterrupts});
  const interrupted=Promise.withResolvers();
  const completed=Promise.withResolvers();
  const chatEvents=[];
  const approvalEvents=[];
  fixture.eventBus.subscribe('agent.chat.run-event',event=>{
    chatEvents.push(event.payload);
    if(event.payload.type==='run_interrupted')interrupted.resolve(event.payload);
  });
  fixture.eventBus.subscribe('agent.run.task-event',event=>{
    if(event.payload.type==='approval_decision')approvalEvents.push(event.payload);
  });
  fixture.eventBus.subscribe('agent.run.completed',event=>completed.resolve(event.payload));
  fixture.eventBus.subscribe('agent.run.failed',event=>{
    const error=new Error(JSON.stringify(event.payload));
    interrupted.reject(error);completed.reject(error);
  });
  void completed.promise.catch(()=>{});
  try {
    const started=await fixture.runtime.startRun({input:'Present a review gate once.',mode:'chat',
      enabledCapabilities:{mcpServers:[],skills:[]}});
    await interrupted.promise;
    await fixture.runtime.resumeRun({kind:'approval',runId:started.runId,threadId:started.threadId,
      interruptId:'network-gate',decisions:[decision]});
    await completed.promise;
    assert.equal(received.length,3,'one start, one failed resume, and one network retry');
    assert.ok(received.every(input=>input.runId===started.runId&&input.threadId===started.threadId));
    assert.equal(fixture.db.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get(),1);
    assert.equal(approvalEvents.length,1,'retry must not dispatch the human decision again');
    assert.deepEqual(approvalEvents[0].payload.decisions,[decision]);
    assert.deepEqual(fixture.repository.getRecordedResumePayload(started.runId),resumePayload);
    assert.equal(chatEvents.filter(event=>event.type==='run_resumed').length,1);
    assert.equal(chatEvents.filter(event=>event.type==='run_interrupted').length,1);
    assert.equal(chatEvents.filter(event=>event.type==='run_recovering'&&event.code==='provider_network_error').length,1);
    assert.deepEqual(received[1].resumePayload,resumePayload);
    assert.deepEqual({resumePayload:received[2].resumePayload,resumeFromCheckpoint:received[2].resumeFromCheckpoint},
      {resumePayload,resumeFromCheckpoint:true},
      'network retry must retain the unconsumed resume map and must not restart initial input');
    assert.deepEqual(consumed,[resumePayload['network-gate']],'consume the human decision exactly once');
    assert.deepEqual(pendingInterrupts,[]);
  } finally {await fixture.close();}
});
