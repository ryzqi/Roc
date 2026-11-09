import assert from 'node:assert/strict';
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

function open(file, fetch) {
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
  const repository = new api.AgentSessionRepository(db,{runEventLog});
  const ledger = new api.RunUsageLedger(db);
  const manifestBase = {schemaVersion:1,requestedCapabilities:{mcpServers:[],skills:[]},
    resolvedCapabilities:{mcpServers:[],skills:[]},skippedCapabilities:[],tools:[],skills:[],mcpServers:[],
    untrustedContextPolicy:'external_content_reference_only'};
  const manifest = {...manifestBase,manifestHash:api.createRunCapabilityManifestHash(manifestBase)};
  const runtime = new api.AgentPluginRuntime({repository,eventBus,runEventLog,executionGrantBroker:api.openExecutionGrantBroker(db),
    deepAgentExecutor:api.createAgentDeepAgentExecutor({executionGrantBroker:api.openExecutionGrantBroker(db),
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
