import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test, after} from 'node:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
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

function open(file, fetch, deepAgentExecutor, checkpointReader, capabilityManifest) {
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
  const effectStore = new api.AgentToolEffectStore(db);
  const manifestBase = {schemaVersion:1,requestedCapabilities:{mcpServers:[],skills:[]},
    resolvedCapabilities:{mcpServers:[],skills:[]},skippedCapabilities:[],tools:[],skills:[],mcpServers:[],
    untrustedContextPolicy:'external_content_reference_only'};
  const manifest = capabilityManifest ?? {...manifestBase,manifestHash:api.createRunCapabilityManifestHash(manifestBase)};
  const runtime = new api.AgentPluginRuntime({repository,eventBus,runEventLog,executionGrantBroker:api.openExecutionGrantBroker(db),
    effectReconciliationService:new api.EffectReconciliationService(effectStore),
    deepAgentExecutor:deepAgentExecutor ?? api.createAgentDeepAgentExecutor({executionGrantBroker:api.openExecutionGrantBroker(db),
      usageLedger:ledger,capabilities:new api.CapabilityRegistry(),checkpointer:new api.RocSqliteCheckpointer(db),
      contextArtifactStore:new api.ContextArtifactStore(db),paths,sessionHistory:repository,
      store:new api.RocSqliteStore(memory),toolEffectStore:effectStore}),
    modelFactory:{createDefaultModelHandle:async()=>({providerId:'fixture',modelId:handle.modelId,langChainHandle:handle}),
      createModelHandleByProviderAndModel:async()=>({providerId:'fixture',modelId:handle.modelId,langChainHandle:handle})},
    capabilityPreviewProvider:async()=>({runnable:false,modelId:handle.modelId,builtInTools:[],toolCards:[],skillCards:[],
      subagents:[],interruptOn:{},manifest,reason:'Local transport fixture'})});
  return {db,repository,runtime,ledger,effectStore,eventBus,async close(){
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

test('durable running inputs survive restart with steering and follow-up scheduling', {timeout:20000}, async () => {
  const requested = Promise.withResolvers();
  const first = open(join(directory, 'inputs-before.db'), async (_url, init) => {
    requested.resolve();
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true}));
  });
  let reopened;
  try {
    const started = await first.runtime.startRun({input:'Original task.',mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]}});
    await requested.promise;
    const steer = {...started, submissionId:'steer-input',kind:'steer',content:'Use corrected value 42.'};
    const follow = {...started, submissionId:'follow-input',kind:'follow_up',content:'Then explain the result.'};
    const receipt = first.runtime.enqueueRunInput(steer);
    assert.deepEqual(first.runtime.enqueueRunInput(steer), receipt);
    first.runtime.enqueueRunInput(follow);
    assert.throws(() => first.runtime.enqueueRunInput({...steer, kind:'follow_up'}), /input_drift/);
    assert.throws(() => first.runtime.enqueueRunInput({...steer, content:'Changed'}), /input_drift/);
    assert.throws(() => first.runtime.enqueueRunInput({...steer, threadId:'wrong-thread'}), /thread_mismatch/);
    assert.throws(() => first.runtime.readRunInputs({runId:started.runId,threadId:'wrong-thread'}), /thread_mismatch/);
    assert.deepEqual(first.runtime.readRunInputs(started).items.map(item => [item.kind,item.status]), [['steer','queued'],['follow_up','queued']]);
    assert.deepEqual(first.ledger.pendingCorrections(started.runId).map(item => item.content), [steer.content]);
    await first.db.backup(join(directory, 'inputs-reopened.db'));
    await first.close();
    const requests=[];
    reopened = open(join(directory, 'inputs-reopened.db'), async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return streamedResponse(requests.length === 1 ? 'Original task completed.' : 'Follow-up completed.');
    });
    reopened.repository.reconcileStartupRuns(); reopened.ledger.reconcileStartup();
    const completed = waitForCompletion(reopened);
    await reopened.runtime.resumeRun({kind:'checkpoint',runId:started.runId,threadId:started.threadId});
    await completed;
    assert.equal(requests.length,2);
    const contents = requests.map(request => request.messages.map(message => message.content));
    assert.ok(contents[0].includes(steer.content));
    assert.ok(!contents[0].includes(follow.content), 'follow-up waits until the current task has a final response');
    assert.ok(contents[1].includes(follow.content));
    assert.equal(contents[1].filter(content => content === steer.content).length,1);
    assert.deepEqual(reopened.runtime.readRunInputs(started).items.map(item => item.status), ['consumed','consumed']);
    assert.deepEqual(reopened.runtime.enqueueRunInput(steer), receipt, 'acknowledgment retries remain idempotent after completion');
    assert.throws(() => reopened.runtime.enqueueRunInput({...follow,submissionId:'too-late'}), /not_active/);
    const userMessages = reopened.repository.listSessionMessages({threadId:started.threadId}).filter(message => message.role === 'user');
    assert.equal(userMessages.filter(message => message.content === steer.content).length,1);
    assert.equal(userMessages.filter(message => message.content === follow.content).length,1);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get(),1);
  } finally {
    if (first.db.open) await first.close();
    if (reopened) await reopened.close();
  }
});

test('input accepted during terminal verification starts the next graph turn on the same checkpoint', {timeout:20000}, async () => {
  const requests=[];
  const fixture = open(':memory:', async (_url,init) => {
    requests.push(JSON.parse(init.body));
    return streamedResponse(requests.length === 1 ? 'First task completed.' : 'Late input completed.');
  });
  const verifying = Promise.withResolvers(), release = Promise.withResolvers();
  const evaluate = fixture.repository.taskContracts.evaluate.bind(fixture.repository.taskContracts);
  let evaluations=0;
  fixture.repository.taskContracts.evaluate = async (...args) => {
    if (++evaluations === 1) { verifying.resolve(); await release.promise; }
    return evaluate(...args);
  };
  try {
    const completed=waitForCompletion(fixture);
    const started=await fixture.runtime.startRun({input:'Finish first task.',mode:'chat',enabledCapabilities:{mcpServers:[],skills:[]}});
    await verifying.promise;
    const input={...started,submissionId:'terminal-race',kind:'follow_up',content:'Handle late input.'};
    fixture.runtime.enqueueRunInput(input);
    release.resolve();
    await completed;
    assert.equal(requests.length,2);
    assert.equal(evaluations,2);
    assert.ok(requests[1].messages.some(message=>message.role==='assistant' &&
      (message.content==='First task completed.' || message.content?.some?.(block=>block.text==='First task completed.'))));
    assert.equal(requests[1].messages.filter(message=>message.content===input.content).length,1);
    assert.equal(requests[1].messages.filter(message=>message.content==='Finish first task.').length,1);
    assert.equal(fixture.runtime.readRunInputs(started).items[0].status,'consumed');
    assert.equal(fixture.repository.getRun(started.runId).status,'completed');
    assert.equal(fixture.db.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get(),1);
  } finally { release.resolve(); await fixture.close(); }
});

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
  {name:'valid terminal response with narration',finalMessage:'Reading. {"answer":"terminal"}',finalResponse:'{"answer":"terminal"}',verdict:'passed'},
  {name:'valid response too large to duplicate in the event envelope',
    finalMessage:JSON.stringify({answer:'文'.repeat(200_000)}),finalResponse:JSON.stringify({answer:'文'.repeat(200_000)}),
    verdict:'passed',omitValidatedResponse:true}
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
    const liveTerminal=new Promise(resolve=>fixture.eventBus.subscribe('agent.chat.run-event',event=>{
      if(event.payload.type==='run_completed')resolve(event.payload);
    }));
    const started=await fixture.runtime.startRun({input:'Return JSON with answer.',mode:'chat',
      enabledCapabilities:{mcpServers:[],skills:[]},responseContract});
    const completed=await done;
    const expectedResponse=scenario.verdict==='passed'&&!scenario.omitValidatedResponse?scenario.finalResponse:undefined;
    assert.equal(completed.assistantMessage,scenario.finalMessage);
    assert.equal(completed.validatedResponse,expectedResponse);
    assert.equal((await liveTerminal).validatedResponse,expectedResponse);
    const report=fixture.repository.taskContracts.readReport(started.runId);
    assert.equal(report.criteria[0].verdict,scenario.verdict);
    assert.equal(report.criteria[0].verifier,'response_json_schema');
    const replay=await fixture.runtime.replayRunEvents({runId:started.runId,afterSequence:0});
    const terminal=replay.events.find(item=>item.event.type==='run_completed').event;
    assert.equal(terminal.assistantMessage,scenario.finalMessage);
    assert.equal(terminal.validatedResponse,expectedResponse);
    const outbox=new api.AgentTaskHistoryContract(fixture.db).listOutboxEventsAfter({afterSequence:0,limit:100});
    const persisted=outbox.find(event=>event.runId===started.runId&&event.eventType==='run_completed');
    assert.equal(persisted.payload.assistantMessage,scenario.finalMessage);
    assert.equal(persisted.payload.validatedResponse,expectedResponse);
    assert.equal(Object.hasOwn(persisted.payload,'validatedResponse'),expectedResponse!==undefined);
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

for (const rescue of [false, true]) test(`production harness rejects ${rescue ? 'rescued' : 'native'} truncated writes and records only the corrected effect`, {timeout:20000}, async () => {
  const workspace = join(directory, `output-integrity-${rescue}`);
  mkdirSync(workspace);
  const path = join(workspace, 'result.txt');
  writeFileSync(path, 'unchanged');
  const {manifestHash:_manifestHash,...compiled} = api.compileRunCapabilityManifest({mode:'chat',deleteFileApprovalMode:'default',mcpApprovalMode:'default',
    mcpServers:[],skills:[],workflowHint:null,requestedCapabilities:{mcpServers:[],skills:[]}}).manifest;
  const base = {...compiled,tools:compiled.tools.filter(item=>['write_file','read_file'].includes(item.modelVisibleName))};
  const manifest = {...base,manifestHash:api.createRunCapabilityManifestHash(base)};
  const requests=[];
  const fixture=open(':memory:',async(_url,init)=>{
    const body=JSON.parse(init.body);requests.push(body);
    assert.ok(requests.length<=3,'one correction and one final answer only');
    const index=requests.length, truncated=index===1, final=index===3;
    if(index===2) {
      assert.equal(readFileSync(path,'utf8'),'unchanged','truncated proposal must never reach the filesystem');
      assert.equal(fixture.db.prepare('SELECT count(*) FROM agent_tool_effects').pluck().get(),0);
      assert.match(JSON.stringify(body.messages),/No tools from that response were executed/);
    }
    const args={file_path:'/workspace/result.txt',content:truncated?'partial':'complete'};
    const native=!(truncated&&rescue)&&!final;
    const chunk=delta=>({id:`output-integrity-${index}`,object:'chat.completion.chunk',created:0,model:'resume-fixture',
      choices:[{index:0,delta,finish_reason:null}]});
    const chunks=[chunk(native?{role:'assistant',tool_calls:[{index:0,id:`write-${index}`,type:'function',
      function:{name:'write_file',arguments:JSON.stringify(args)}}]}:
      {role:'assistant',content:final?'Saved complete.':JSON.stringify({name:'write_file',arguments:args})})];
    chunks.push({...chunk({}),choices:[{index:0,delta:{},finish_reason:truncated?'length':final?'stop':'tool_calls'}]},
      {...chunk({}),choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
    return new Response(chunks.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  },undefined,undefined,manifest);
  try {
    const done=waitForCompletion(fixture);
    const started=await fixture.runtime.startRun({input:'Write complete to result.txt.',mode:'chat',taskSource:'workbench',workspacePath:workspace,
      enabledCapabilities:{mcpServers:[],skills:[]}});
    await done;
    assert.equal(readFileSync(path,'utf8'),'complete');
    assert.equal(requests.length,3);
    const effects=fixture.db.prepare('SELECT tool_call_id,status FROM agent_tool_effects').all();
    assert.deepEqual(effects,[{tool_call_id:'write-2',status:'succeeded'}]);
    assert.deepEqual(readRootCheckpoint(fixture.db).rocOutputCorrection,{runId:started.runId,attempts:1});
    const calls=fixture.db.prepare("SELECT state FROM agent_calls WHERE kind='model'").all();
    assert.deepEqual(calls.map(call=>call.state),['settled','settled','settled'],'rejected model usage must remain accounted');
  } finally {await fixture.close();}
});

test('real graph replays a reconciled write from the checkpoint before tool completion without rewriting the file', {timeout:20000}, async () => {
  const root=mkdtempSync(join(directory,'effect-checkpoint-'));
  const workspace=join(root,'workspace');mkdirSync(workspace);
  const path=join(workspace,'result.txt'),snapshotPath=join(root,'crashed.db');
  const {manifestHash:_manifestHash,...compiled}=api.compileRunCapabilityManifest({mode:'chat',deleteFileApprovalMode:'default',
    mcpApprovalMode:'default',mcpServers:[],skills:[],workflowHint:null,requestedCapabilities:{mcpServers:[],skills:[]}}).manifest;
  const base={...compiled,tools:compiled.tools.filter(item=>['write_file','read_file'].includes(item.modelVisibleName))};
  const manifest={...base,manifestHash:api.createRunCapabilityManifestHash(base)};
  const captured=Promise.withResolvers();
  let first,reopened,initialRequests=0,completedWrites=0;
  try {
    first=open(join(root,'before.db'),async()=>{
      assert.equal(++initialRequests,1,'the original graph must stop at the captured write boundary');
      const chunk={id:'before-effect-crash',object:'chat.completion.chunk',created:0,model:'resume-fixture',choices:[{
        index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'write-once',type:'function',function:{name:'write_file',
          arguments:JSON.stringify({file_path:'/workspace/result.txt',content:'written once'})}}]},finish_reason:'tool_calls'}]};
      const usage={...chunk,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
        {headers:{'content-type':'text/event-stream'}});
    },undefined,undefined,manifest);
    first.eventBus.subscribe('agent.run.failed',event=>captured.reject(new Error(JSON.stringify(event.payload))));
    first.effectStore.finishSuccess=lease=>{
      try {
        assert.equal(++completedWrites,1);
        assert.equal(lease.toolCallId,'write-once');
        assert.equal(readFileSync(path,'utf8'),'written once');
        const effect=first.db.prepare('SELECT status,receipt_json FROM agent_tool_effects').get();
        assert.equal(effect.status,'in_progress');
        assert.equal(JSON.parse(effect.receipt_json).phase,'durable');
        // Synchronous serialization freezes the database before the store can mark success
        // or the real LangGraph tools node can save its result in checkpoint writes.
        writeFileSync(snapshotPath,first.db.serialize());
        captured.resolve(statSync(path));
      } catch(error) {captured.reject(error);}
      throw Object.assign(new Error('Simulated process loss after atomic publication'),{name:'AbortError'});
    };
    const started=await first.runtime.startRun({input:'Write written once to result.txt.',mode:'chat',taskSource:'workbench',
      workspacePath:workspace,enabledCapabilities:{mcpServers:[],skills:[]}});
    const published=await captured.promise;
    await first.close();
    const requests=[];
    reopened=open(snapshotPath,async(_url,init)=>{
      const request=JSON.parse(init.body);requests.push(request);
      assert.equal(requests.length,1,'resume must reuse the tool result and request only the final answer');
      const result=request.messages.find(message=>message.role==='tool'&&message.tool_call_id==='write-once');
      assert.ok(result,'the real graph must send the replayed ToolMessage to the model');
      assert.match(result.content,/Verified completed write.*after interrupted execution/);
      return streamedResponse('Recovered the completed write.');
    },undefined,undefined,manifest);
    const checkpoint=await new api.RocSqliteCheckpointer(reopened.db).getTuple({configurable:{thread_id:started.threadId}});
    assert.ok(checkpoint);
    assert.ok(checkpoint.checkpoint.channel_values.messages.some(message=>message.tool_calls?.some(call=>call.id==='write-once')));
    assert.equal(checkpoint.checkpoint.channel_values.messages.some(message=>message.tool_call_id==='write-once'),false);
    assert.equal((checkpoint.pendingWrites??[]).some(([,channel,value])=>channel==='messages'&&
      (Array.isArray(value)?value:[value]).some(message=>message?.tool_call_id==='write-once')),false,
      'the snapshot precedes both checkpoint state and pending writes for the tool result');
    assert.equal(reopened.db.prepare('SELECT status FROM agent_tool_effects').pluck().get(),'in_progress');
    reopened.repository.reconcileStartupRuns();reopened.ledger.reconcileStartup();
    assert.equal(reopened.repository.getRun(started.runId).status,'interrupted');
    assert.equal(reopened.db.prepare('SELECT status FROM agent_tool_effects').pluck().get(),'unknown');
    await assert.rejects(reopened.runtime.resumeRun({kind:'checkpoint',...started}),/checkpoint_resume_unavailable/);
    const reconciled=await reopened.runtime.reconcileRunEffects(started);
    assert.equal(reconciled.canResume,true);
    assert.deepEqual(reconciled.resolved.map(item=>[item.toolCallId,item.outcome]),[['write-once','applied']]);
    assert.deepEqual(reconciled.unresolved,[]);
    const executions=[];
    const beginOperation=reopened.effectStore.beginOperation.bind(reopened.effectStore);
    reopened.effectStore.beginOperation=input=>{
      const operation=beginOperation(input);executions.push(operation.kind);
      assert.equal(operation.kind,'replay','the checkpoint must reuse the reconciled effect identity');
      return operation;
    };
    reopened.effectStore.markStarted=()=>assert.fail('recovery must never dispatch a second filesystem write');
    reopened.effectStore.finishSuccess=()=>assert.fail('recovery must never execute a second filesystem write');
    const done=waitForCompletion(reopened);
    await reopened.runtime.resumeRun({kind:'checkpoint',...started});
    await done;
    assert.deepEqual(executions,['replay']);
    assert.equal(requests.length,1);assert.equal(initialRequests,1);assert.equal(completedWrites,1);
    const current=statSync(path);
    assert.deepEqual([current.ino,current.size,current.mtimeMs,current.ctimeMs],
      [published.ino,published.size,published.mtimeMs,published.ctimeMs]);
    assert.equal(readFileSync(path,'utf8'),'written once');
    assert.equal(reopened.repository.getRun(started.runId).status,'completed');
    assert.deepEqual(reopened.db.prepare('SELECT id,thread_id FROM agent_runs').all(),[{id:started.runId,thread_id:started.threadId}]);
    assert.deepEqual(reopened.db.prepare('SELECT run_id,thread_id,tool_call_id,status FROM agent_tool_effects').all(),
      [{run_id:started.runId,thread_id:started.threadId,tool_call_id:'write-once',status:'succeeded'}]);
  } finally {
    if(first?.db.open)await first.close();
    if(reopened?.db.open)await reopened.close();
    rmSync(root,{recursive:true,force:true});
  }
});
