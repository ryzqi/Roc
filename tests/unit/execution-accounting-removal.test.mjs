import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const api = await loadResearchTestApi();
after(() => api.dispose());
const events = await importTypeScriptModule('src/main/infrastructure/execution-events.ts', {platform:'node'});
const effects = await importTypeScriptModule('src/main/services/deep-agent/tool-effect-store.ts', {platform:'node'});
const config = await importTypeScriptModule('src/main/infrastructure/remove-execution-config.ts', {platform:'node'});
const timestamp = '2026-11-09T00:00:00.000Z';
function fixture() {
  const db = new Database(':memory:');
  api.applyDatabaseMigrations(db, {dbName:'agent', migrations:api.agentMigrations.filter(m => m.version <= 24)});
  const manifestBase = {schemaVersion:1, requestedCapabilities:{mcpServers:[],skills:[]}, resolvedCapabilities:{mcpServers:[],skills:[]},
    skippedCapabilities:[],tools:[],skills:[],mcpServers:[],untrustedContextPolicy:'external_content_reference_only'};
  const snapshot = api.createRunExecutionSnapshot({runId:'run',threadId:'thread',inputMessageId:'message',snapshot:{
    schemaVersion:11,submissionHash:'f'.repeat(64),taskContract:{contractVersion:1,objective:'Migration',constraints:[],kind:'reply',
      criteria:[{id:'response',description:'Reply',check:{kind:'response'}}]},runOrigin:'chat',model:{providerId:'fixture',modelId:'fixture'},
    mode:'run',workspace:null,capabilityManifest:{...manifestBase,manifestHash:api.createRunCapabilityManifestHash(manifestBase)},workflowHint:null,
    explicitSkillIds:[],dispatchKey:null,researchProjectId:null,modelConfig:api.createRunModelConfig({contextWindowTokens:1000})}});
  const {modelConfig,...old} = snapshot;
  old.schemaVersion = 10;
  old.budget = {...modelConfig,maxTotalTokens:1,maxModelCalls:1,maxCostMicrousd:1,pricingCatalogVersion:'old'};
  old.frozenInputs = {...old.frozenInputs,policyHash:events.executionPayloadHash({budget:old.budget,model:old.model,taskContract:old.taskContract})};
  db.prepare("INSERT INTO agent_threads(id,kind,title,goal,status,created_at,updated_at) VALUES('thread','chat','Kept','Kept','active',?,?)").run(timestamp,timestamp);
  db.prepare("INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version,budget_stop_reason) VALUES('run','thread',1,'Original message','interrupted',?,'{}','chat',?,10,'run_total_token_budget_exhausted')").run(timestamp,JSON.stringify(old));
  const receipt = {schemaVersion:1,runId:'run',callId:'call',tokens:80,state:'settled',outcomeHash:null,outcome:{},costMicrousd:50,pricingVersion:'old',effectivePricingVersion:'old'};
  const envelope = {settlementReceipt:receipt,settlementReceiptHash:effects.hashToolInput(receipt),reservedCostMicrousd:60,pricingVersion:'old'};
  db.prepare("INSERT INTO agent_budget_calls(run_id,call_id,execution_kind,kind,input_hash,reserved_tokens,actual_tokens,state,envelope_json,created_at,reserved_cost_microusd,actual_cost_microusd) VALUES('run','call','chat','model','hash',100,80,'settled',?,?,60,50)").run(JSON.stringify(envelope),timestamp);
  const usage = {tokens:{settled:80,unknown:0,reserved:0,limit:1},calls:Object.fromEntries(['models','tools','children'].map(k => [k,{total:k==='models'?1:0,reserved:0,limit:1}])),cost:{settledMicrousd:50},stopReason:'run_total_token_budget_exhausted'};
  const event = events.createExecutionEvent({streamId:'run:run',sequence:1,eventType:'run_budget',actor:{kind:'main',id:'fixture'},correlationId:'run',causationId:null,projectId:null,taskId:null,runId:'run',createdAt:timestamp,payload:{type:'run_budget',runId:'run',threadId:'thread',budget:usage}});
  const json = JSON.stringify(event);
  db.prepare('INSERT INTO agent_run_events(run_id,sequence,event_json,created_at,event_bytes) VALUES(?,?,?,?,?)').run('run',1,json,timestamp,Buffer.byteLength(json));
  db.prepare('INSERT INTO agent_run_event_cursors(run_id,next_sequence,retained_count,retained_bytes) VALUES(?,?,?,?)').run('run',2,1,Buffer.byteLength(json));
  return {db,snapshot};
}
test('v24 migration removes accounting while preserving snapshots, receipts and replay integrity', () => {
  const {db,snapshot} = fixture();
  try {
    api.applyDatabaseMigrations(db,{dbName:'agent',migrations:api.agentMigrations});
    assert.deepEqual(JSON.parse(db.prepare("SELECT snapshot_json FROM agent_runs WHERE id='run'").pluck().get()),snapshot);
    assert.equal(db.prepare("SELECT user_input FROM agent_runs WHERE id='run'").pluck().get(),'Original message');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%budget%' OR name LIKE '%cost%'").all(),[]);
    for (const table of ['agent_runs','agent_calls','agent_pilot_runs']) {
      assert.equal(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all().some(k => /budget|cost|pricing|allowance/.test(k)),false);
    }
    const ledger = new api.RunUsageLedger(db);
    ledger.settle('run','call',80,'settled'); // Migrated retry receipt still matches.
    ledger.reserve('run',snapshot.modelConfig,{id:'next',kind:'model',tokens:10000,inputHash:'next',envelope:{}});
    assert.equal(ledger.readUsageStatus('run').calls.models.total,2);
    const row = db.prepare('SELECT event_json,event_bytes FROM agent_run_events').get();
    const event = events.parseExecutionEvent(row.event_json);
    assert.equal(event.eventType,'run_usage');
    assert.deepEqual(event.payload.usage.tokens,{settled:80,unknown:0,reserved:0});
    assert.equal(Buffer.byteLength(row.event_json),row.event_bytes);
    assert.equal(db.prepare('SELECT retained_bytes FROM agent_run_event_cursors').pluck().get(),row.event_bytes);
    api.applyDatabaseMigrations(db,{dbName:'agent',migrations:api.agentMigrations});
  } finally {db.close();}
});
for (const corrupt of ['snapshot','receipt','event']) test(`corrupt ${corrupt} rolls back the entire accounting removal`, () => {
  const {db} = fixture();
  try {
    if (corrupt==='snapshot') db.exec("UPDATE agent_runs SET snapshot_json=json_set(snapshot_json,'$.frozenInputs.policyHash','bad')");
    if (corrupt==='receipt') db.exec("UPDATE agent_budget_calls SET envelope_json=json_set(envelope_json,'$.settlementReceiptHash','bad')");
    if (corrupt==='event') db.exec("UPDATE agent_run_events SET event_json=json_set(event_json,'$.payloadHash','bad')");
    assert.throws(() => api.applyDatabaseMigrations(db,{dbName:'agent',migrations:api.agentMigrations}));
    assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),24);
    assert.equal(db.prepare('SELECT actual_cost_microusd FROM agent_budget_calls').pluck().get(),50);
    assert.equal(db.prepare('SELECT snapshot_version FROM agent_runs').pluck().get(),10);
  } finally {db.close();}
});
test('saved provider settings and pilot state shed obsolete accounting without mutating input', () => {
  const source = {providers:{providers:[{models:[{options:{contextBudgetTokens:8192,anthropicThinking:{mode:'enabled',budgetTokens:2048}}}]}]}};
  assert.deepEqual(config.removeExecutionConfig(source),{providers:{providers:[{models:[{options:{contextWindowTokens:8192}}]}]}});
  assert.equal(source.providers.providers[0].models[0].options.contextBudgetTokens,8192);
  assert.deepEqual(config.removePilotAccounting({enabled:true,extraBudgetMicrousd:100,spentMicrousd:100,budgetAcknowledgedAt:timestamp,circuitOpen:true,breakerReason:'pilot_allowance_exhausted',failureStreak:1}),
    {enabled:true,circuitOpen:false,breakerReason:null,failureStreak:0});
});

test('research metadata migration strips saved plan/request quotas and preserves hash checks', async () => {
  const {createResearchFixture, withResearchTestWorker, researchSearchPlanFixture, captureResearchArtifactVersions} = await import('./fixtures/research-test-kit.mjs');
  const migration = await importTypeScriptModule('src/main/infrastructure/remove-research-accounting.ts', {platform:'node'});
  const f = createResearchFixture(api, 'discovery');
  try {
    const completed = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, id => f.repository.runs.complete(id, f.project.id, {
      title:'Plan', markdown:'Original prose', claims:[], sections:[], verdict:'ready', searchPlan:researchSearchPlanFixture(f.run.instruction)
    }));
    const artifactId = completed.outputArtifactIds[0];
    const gate = api.createResearchHumanGate({repository:f.repository});
    await gate.complete({projectId:f.project.id,expectedStage:'discovery',action:'complete'});
    const content = f.repository.runs.getArtifactContent(f.project.id,artifactId);
    await gate.approve({projectId:f.project.id,expectedStage:'discovery',action:'approve',
      expectedArtifactVersions:captureResearchArtifactVersions(f.repository,f.project.id),
      expectedSearchPlanHash:api.searchPlanApprovalHash(f.project.id,artifactId,content.output)});
    const run = f.repository.runs.begin({projectId:f.project.id,expectedStage:'retrieval',instruction:'Read approved plan',requestId:'migration'});
    const context = f.repository.runs.getContext(run.id);
    const originalOutput = structuredClone(content.output);
    function legacy(output) {
      const oldPlan = JSON.stringify(output.searchPlan,null,2);
      output.searchPlan.budget = {candidates:1,requests:1,paidProviderCalls:0};
      output.searchPlan.queries[0].maxRequests = 1;
      output.markdown = output.markdown.replace(oldPlan,JSON.stringify(output.searchPlan,null,2));
    }
    legacy(content.output);
    legacy(context.inputs[0].output);
    f.db.prepare('UPDATE research_artifact_contents SET output_json=? WHERE artifact_id=?').run(JSON.stringify(content.output),artifactId);
    const hashContext = value => events.executionPayloadHash({project:value.project,skillInstructions:value.skillInstructions,skillPin:value.skillPin,inputs:value.inputs});
    run.executionSnapshot.frozenInputs.versions.find(v=>v.kind==='context').hash=hashContext(context);
    const oldInputs=JSON.stringify(run.executionSnapshot.frozenInputs);
    f.db.prepare('UPDATE research_stage_runs SET snapshot_json=?,context_json=? WHERE id=?').run(JSON.stringify(run),JSON.stringify(context),run.id);
    f.agentDb.prepare("UPDATE research_task_executions SET snapshot_json=json_set(snapshot_json,'$.frozenInputs',json(?)) WHERE execution_id=?").run(oldInputs,run.id);
    const oldHash=run.executionSnapshot.frozenInputs.versions.find(v=>v.kind==='context').hash;
    f.db.exec("UPDATE research_stage_runs SET snapshot_json=json_set(snapshot_json,'$.executionSnapshot.frozenInputs.versions[#-1].hash','bad') WHERE stage='retrieval'");
    assert.throws(()=>f.db.transaction(()=>migration.removeResearchAccounting(f.db))(),/research_stage_snapshot_invalid/);
    assert.ok(JSON.parse(f.db.prepare('SELECT output_json FROM research_artifact_contents WHERE artifact_id=?').pluck().get(artifactId)).searchPlan.budget);
    run.executionSnapshot.frozenInputs.versions.find(v=>v.kind==='context').hash=oldHash;
    f.db.prepare('UPDATE research_stage_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(run),run.id);
    f.db.transaction(()=>migration.removeResearchAccounting(f.db))();
    assert.deepEqual(f.repository.runs.getArtifactContent(f.project.id,artifactId).output,originalOutput);
    const marker=f.db.prepare('SELECT * FROM research_execution_input_migrations').get();
    assert.equal(marker.previous_json,oldInputs);
    f.tasks.migrateExecutionInputs(run.id,marker.previous_json,marker.current_json);
    f.repository.runs.reconcileTaskLinks(); // Accepts already-applied agent update after an interrupted migration.
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_execution_input_migrations').pluck().get(),0);
    assert.deepEqual(f.repository.runs.getContext(run.id).inputs[0].output,originalOutput);
    assert.equal(f.tasks.requireExecution('stage',run.id,f.project.id).frozenInputs.versions.find(v=>v.kind==='context').hash,
      hashContext(f.repository.runs.getContext(run.id)));
  } finally {f.close();}
});
