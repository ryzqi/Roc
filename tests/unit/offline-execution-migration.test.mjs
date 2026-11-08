import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {after, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadResearchTestApi, researchSearchPlanFixture} from './fixtures/research-test-kit.mjs';
const options = {platform:'node',external:['better-sqlite3','zod'],tempDir:join(process.cwd(),'.runtime/tmp')};
const {migrateExecutionDatabases} = await importTypeScriptModule('scripts/offline-execution-migration.ts',options);
const schemas = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts',options);
const api = await loadResearchTestApi();
after(()=>api.dispose());
const digest = value => createHash('sha256').update(value).digest('hex');
const definitions = [['core',1],['agent',19],['memory',2],['task',1],['workspace',1],['diagnostics',1],['research',60]];
const location = (root,name) => join(root,name === 'core' ? 'data/core.db' : `data/plugins/@roc/plugin-${name}.db`);
function fixture(fromS02 = false, fromS04 = false, fromS05 = false) {
  const root=mkdtempSync(join(tmpdir(),'roc-offline-contract-'));
  const source=join(root,'source');mkdirSync(source);
  for (const [name,oldVersion] of definitions) {
    const version = fromS05 && name === 'research' ? 63 : fromS04 && name === 'research' ? 62 : (fromS02 || fromS04 || fromS05) && ['agent','research'].includes(name) ? oldVersion + 1 : oldVersion;
    const file=location(source,name);mkdirSync(dirname(file),{recursive:true});
    const db=new Database(file);
    api.applyDatabaseMigrations(db,{dbName:['core','agent','memory','task'].includes(name)?name:`plugin:@roc/plugin-${name}`,
      migrations:schemas[`${name}Migrations`].slice(0,version)});db.close();
  }
  writeFileSync(join(source,'private-config.json'),'preserved-local-fixture');
  const agent=new Database(location(source,'agent'));const research=new Database(location(source,'research'));
  if (fromS02 || fromS04 || fromS05) {
    api.applyDatabaseMigrations(agent,{dbName:'agent',migrations:schemas.agentMigrations.slice(0,20)});
    api.applyDatabaseMigrations(research,{dbName:'plugin:@roc/plugin-research',migrations:schemas.researchMigrations.slice(0,fromS05 ? 63 : fromS04 ? 62 : 61)});
  }
  // Current writers construct the records; remove their temporary DAG tables and
  // explicitly encode the historical envelopes before treating this as an old database.
  agent.exec(schemas.agentMigrations.find(migration => migration.version === 21).sql);
  const now=()=> new Date().toISOString();
  const tasks=new api.ResearchTaskRepository(agent,now);
  const repository=new api.ResearchRepository(research,tasks,now);
  const workspacePath=join(root,'workspace');mkdirSync(workspacePath,{recursive:true});
  const workspaceSentinel=join(workspacePath,'sentinel.txt');
  writeFileSync(workspaceSentinel,'ROC_WORKSPACE_SENTINEL_v1\n');
  const workspaceSentinelHash=digest(readFileSync(workspaceSentinel));
  const project=repository.createProject({title:'Migration fixture',description:'isolated',workspacePath});
  const run=repository.runs.begin({projectId:project.id,expectedStage:'discovery',instruction:'private input',requestId:'old-request'});
  repository.runs.terminate(run.id,project.id,'interrupted','stopped-for-migration');
  const current=tasks.requireExecution('stage',run.id,project.id);
  const {nodeBinding:_nodeBinding,origin:_origin,frozenInputs:_frozenInputs,associationState:_associationState,...legacy}=current;
  const oldExecution = !fromS02 && !fromS04 && !fromS05 ? {...legacy,schemaVersion:1} : {...current,schemaVersion:2,nodeBinding:{kind:'none'}};
  agent.prepare("UPDATE research_task_executions SET snapshot_json=? WHERE execution_id=?").run(JSON.stringify(oldExecution),run.id);
  agent.exec("UPDATE research_tasks SET snapshot_json=json_set(snapshot_json,'$.schemaVersion',2); DROP TABLE research_task_dependencies; DROP TABLE research_task_nodes; DROP TABLE research_task_graphs;");
  const {executionSnapshot:_executionSnapshot,...oldRun}=repository.runs.get(run.id,project.id);
  research.prepare('UPDATE research_stage_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(!fromS02 && !fromS04 && !fromS05 ? oldRun :
    {...oldRun,executionSnapshot:{..._executionSnapshot,nodeBinding:{kind:'none'}}}),run.id);
  if (!fromS04 && !fromS05) research.prepare("UPDATE research_stage_runs SET context_json=json_remove(context_json,'$.skillPin') WHERE id=?").run(run.id);
  if (fromS04) {
    const plan = researchSearchPlanFixture(run.instruction);
    const {schemaVersion, version, perspectives, budget: _budget, ...legacyPlan} = plan;
    legacyPlan.queries = legacyPlan.queries.map(({id,maxRequests,...query}) => query);
    const output = {title: 'Old approved plan', markdown: 'Original plan text', claims: [], sections: [], verdict: 'ready', searchPlan: legacyPlan};
    research.prepare(`INSERT INTO research_artifacts(id,project_id,stage,kind,title,path,status,created_at,updated_at)
      VALUES('old-plan',?,'discovery','search_strategy','Old approved plan',NULL,'approved',?,?)`).run(project.id,now(),now());
    research.prepare('INSERT INTO research_artifact_contents VALUES(?,?,?,?,?)').run('old-plan',project.id,run.id,JSON.stringify(output),now());
    research.prepare("UPDATE research_projects SET current_stage='retrieval' WHERE id=?").run(project.id);
    research.prepare("UPDATE research_stage_states SET gate_approved=1,status='completed',artifact_ids_json='[\"old-plan\"]' WHERE project_id=? AND stage='discovery'").run(project.id);
  }
  const budget=api.createRunBudget({contextBudgetTokens:1000});
  const ledger=new api.RunBudgetLedger(agent);
  tasks.projectBudgets.save({projectId:project.id,expectedRevision:0,
    limits:{maxTotalTokens:10000,maxModelCalls:20,maxConcurrentModelCalls:5,maxCostMicrousd:null}});
  ledger.reserve(run.id,budget,{id:'reserved-call',kind:'model',tokens:100,costMicrousd:70,inputHash:'hash',envelope:{private:'frozen input'}});
  ledger.reserve(run.id,budget,{id:'settled-call',kind:'model',tokens:100,costMicrousd:70,inputHash:'hash2',envelope:{}});
  ledger.settle(run.id,'settled-call',80,'settled',undefined,{},50);
  agent.prepare("INSERT INTO agent_threads(id,kind,title,goal,status,created_at,updated_at) VALUES('thread','chat','old','goal','active',?,?)").run(now(),now());
  agent.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,snapshot_version,snapshot_json)
    VALUES('chat','thread',1,'old','interrupted',?,'{}',9,'{"schemaVersion":9,"private":"original"}')`).run(now());
  agent.prepare("INSERT INTO agent_run_events(run_id,sequence,event_json,created_at) VALUES('chat',1,'{\"type\":\"legacy\"}',?)").run(now());
  agent.prepare("INSERT INTO agent_run_event_cursors(run_id,next_sequence) VALUES('chat',2)").run();
  const budgetBefore=agent.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all();
  const eventsBefore=agent.prepare('SELECT * FROM research_task_events').all();
  agent.close();research.close();
  const bytes=Object.fromEntries(definitions.map(([name])=>[name,digest(readFileSync(location(source,name)))]));
  return {root,source,destination:join(root,'converted'),project,run,budgetBefore,eventsBefore,bytes,workspacePath,workspaceSentinel,workspaceSentinelHash,
    close:()=>rmSync(root,{recursive:true,force:true})};
}
test('offline conversion preserves source and cold backup, fences historical identity and retains unknown budget',async()=>{
  const f=fixture();
  try {
    const report=await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(report.status,'complete');assert.equal(report.databases.length,7);
    for(const [name] of definitions) assert.equal(digest(readFileSync(location(f.source,name))),f.bytes[name]);
    assert.equal(readFileSync(join(f.destination,'current/private-config.json'),'utf8'),'preserved-local-fixture');
    assert.equal(digest(readFileSync(f.workspaceSentinel)),f.workspaceSentinelHash);
    const backup=new Database(location(join(f.destination,'backup'),'agent'));
    assert.equal(backup.prepare('SELECT current_version FROM schema_metadata').pluck().get(),19);
    assert.deepEqual(backup.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all(),f.budgetBefore);
    assert.deepEqual(backup.prepare('SELECT * FROM research_task_events').all(),f.eventsBefore);backup.close();
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    const research=new Database(location(join(f.destination,'current'),'research'));
    try {
      assert.equal(agent.prepare('SELECT current_version FROM schema_metadata').pluck().get(),schemas.agentMigrations.at(-1).version);
      const calls=agent.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all();
      assert.deepEqual(calls,f.budgetBefore.map(row=>({...row,state:row.state==='reserved'?'unknown':row.state})));
      const tasks=new api.ResearchTaskRepository(agent);
      const repository=new api.ResearchRepository(research,tasks);
      // Cold reopen uses the migrated current databases while the user workspace
      // remains the exact pre-migration byte sequence.
      assert.equal(repository.getProject(f.project.id).workspacePath,f.workspacePath);
      assert.equal(digest(readFileSync(repository.getProject(f.project.id).workspacePath + '/sentinel.txt')),f.workspaceSentinelHash);
      repository.runs.reconcileTaskLinks();
      const association=tasks.requireExecution('stage',f.run.id,f.project.id);
      assert.equal(association.schemaVersion,3);assert.equal(association.associationState,'historical');
      assert.equal(association.frozenInputs,null);assert.equal(association.origin.kind,'historical');
      assert.throws(()=>tasks.continueWith(f.run.taskId,f.project.id,()=>assert.fail('no dispatch')),/historical_execution_not_resumable/);
      assert.equal(repository.runs.get(f.run.id,f.project.id).executionSnapshot,null);
      assert.deepEqual(agent.prepare('SELECT snapshot_json,snapshot_version,snapshot_error_code FROM agent_runs').get(),{
        snapshot_json:null,snapshot_version:null,snapshot_error_code:'historical_execution_not_resumable'});
      assert.equal(agent.prepare('SELECT next_sequence FROM agent_run_event_cursors').pluck().get(),2);
      assert.equal(agent.prepare('SELECT COUNT(*) FROM agent_run_events').pluck().get(),0);
      for(const row of agent.prepare('SELECT * FROM execution_historical_audit').all()) assert.equal(digest(row.raw_json),row.raw_hash);
      assert.ok(agent.prepare("SELECT 1 FROM execution_historical_audit WHERE source_table='agent_run_events'").get());
    } finally {agent.close();research.close();}
    await assert.rejects(migrateExecutionDatabases({...f,stopped:true}),/offline_destination_must_be_new/);
  } finally {f.close();}
});
test('offline converter rejects active effects, drift, broken links and nested destinations without changing source',async()=>{
  for(const failure of ['effect','schema','link','nested','attestation']){
    const f=fixture();
    try {
      let expected;
      if(failure==='effect'){
        const db=new Database(location(f.source,'agent'));
        db.prepare(`INSERT INTO agent_tool_effects(run_id,thread_id,execution_path,checkpoint_id,tool_call_id,tool_name,input_hash,effect_class,reconcile_strategy,status,created_at,updated_at)
          VALUES('chat','thread','root','cp','tool','write','hash','external_call','manual_confirmation','unknown','now','now')`).run();db.close();expected=/offline_unresolved_effect/;
      }else if(failure==='schema'){
        const db=new Database(location(f.source,'agent'));db.exec('CREATE TABLE unexpected(id TEXT)');db.close();expected=/offline_source_schema_changed/;
      }else if(failure==='link'){
        const db=new Database(location(f.source,'research'));db.prepare('UPDATE research_stage_runs SET task_id=?').run('foreign');db.close();expected=/offline_stage_link_invalid/;
      }else if(failure==='nested'){f.destination=join(f.source,'..hidden');expected=/offline_destination_must_be_new/;
      }else expected=/offline_stop_attestation_required/;
      const before=Object.fromEntries(definitions.map(([name])=>[name,digest(readFileSync(location(f.source,name)))]));
      await assert.rejects(migrateExecutionDatabases({...f,stopped:failure!=='attestation'}),expected);
      for(const [name] of definitions) assert.equal(digest(readFileSync(location(f.source,name))),before[name]);
      assert.equal(existsSync(f.destination),false);
    }finally{f.close();}
  }
});

for (const phase of ['S02', 'S04', 'S05']) test(`${phase} cutover keeps raw context, events and unrelated chat while fencing historical stages after cold open`,async()=>{
  const f=fixture(phase === 'S02', phase === 'S04', phase === 'S05');
  try {
    const oldResearch=new Database(location(f.source,'research'));
    const original=oldResearch.prepare('SELECT * FROM research_stage_runs WHERE id=?').get(f.run.id);
    assert.throws(()=>schemas.applyResearchDatabaseSchema(oldResearch),/database_offline_migration_required/);
    oldResearch.close();
    const report=await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(report.sourceApp,phase === 'S02' ? '7120421-S02' : phase === 'S04' ? '4381104-S04' : '9d16212d-S05');
    assert.deepEqual(report.databases.find(entry=>entry.name==='plugin:@roc/plugin-research').from,phase === 'S02' ? 61 : phase === 'S04' ? 62 : 63);
    for(const [name] of definitions) assert.equal(digest(readFileSync(location(f.source,name))),f.bytes[name]);
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    const research=new Database(location(join(f.destination,'current'),'research'));
    try {
      schemas.applyAgentDatabaseSchema(agent);schemas.applyResearchDatabaseSchema(research);
      assert.equal(research.prepare('SELECT current_version FROM schema_metadata').pluck().get(),schemas.researchMigrations.at(-1).version);
      assert.equal(agent.prepare('SELECT COUNT(*) FROM research_task_nodes').pluck().get(),0);
      const tasks=new api.ResearchTaskRepository(agent);
      const repository=new api.ResearchRepository(research,tasks);
      repository.runs.reconcileTaskLinks();
      assert.equal(tasks.requireExecution('stage',f.run.id,f.project.id).associationState,'historical');
      assert.throws(()=>tasks.continueWith(f.run.taskId,f.project.id,()=>assert.fail('no dispatch')),/historical_execution_not_resumable/);
      assert.throws(()=>repository.runs.getContext(f.run.id),/historical_execution_not_resumable/);
      assert.throws(()=>repository.runs.retry({runId:f.run.id,projectId:f.project.id,requestId:'no-retry'}),/historical_execution_not_resumable/);
      const saved=research.prepare('SELECT * FROM research_stage_runs WHERE id=?').get(f.run.id);
      assert.equal(saved.context_json,original.context_json);
      assert.deepEqual(JSON.parse(saved.snapshot_json),{...JSON.parse(original.snapshot_json),executionSnapshot:null});
      const audit=research.prepare("SELECT * FROM execution_historical_audit WHERE source_table='research_stage_runs'").get();
      assert.deepEqual(JSON.parse(audit.raw_json),original);assert.equal(digest(audit.raw_json),audit.raw_hash);
      assert.deepEqual(agent.prepare('SELECT * FROM research_task_events ORDER BY sequence LIMIT ?').all(f.eventsBefore.length),f.eventsBefore);
      assert.equal(agent.prepare('SELECT COUNT(*) FROM agent_run_events').pluck().get(),1);
      assert.equal(agent.prepare("SELECT snapshot_version FROM agent_runs WHERE id='chat'").pluck().get(),9);
      assert.deepEqual(agent.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all(),f.budgetBefore.map(row=>({...row,state:row.state==='reserved'?'unknown':row.state})));
      if (phase === 'S04') {
        const content = repository.runs.getArtifactContent(f.project.id,'old-plan');
        assert.equal(content.output.searchPlan,undefined);
        assert.match(content.output.markdown,/历史检索计划（不可执行）/);
        assert.match(content.output.markdown,/Synthetic reproducibility fixture/);
        assert.equal(repository.getArtifact('old-plan').status,'superseded');
        assert.equal(repository.getWorkflow(f.project.id).currentStage,'discovery');
        assert.equal(repository.getWorkflow(f.project.id).stages.find(stage=>stage.stage==='discovery').gateApproved,false);
        const raw = research.prepare("SELECT raw_json FROM execution_historical_audit WHERE source_table='research_artifact_contents'").pluck().get();
        assert.ok(JSON.parse(JSON.parse(raw).output_json).searchPlan);
        assert.throws(()=>repository.runs.begin({projectId:f.project.id,expectedStage:'retrieval',instruction:'old approval',requestId:'rejected'}));
      }
      const fresh=repository.runs.begin({projectId:f.project.id,expectedStage:'discovery',instruction:'new task',requestId:'fresh-contract'});
      assert.equal(repository.runs.getContext(fresh.id).skillPin.stage,'discovery');
      assert.equal(tasks.requireExecution('stage',fresh.id,f.project.id).associationState,'confirmed');
    } finally {agent.close();research.close();}
  } finally {f.close();}
});

test('old approved search plan cutover preserves an archived project after cold reopen',async()=>{
  const f=fixture(false,true);
  try {
    const oldResearch=new Database(location(f.source,'research'));
    oldResearch.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    oldResearch.close();
    const sourceHash=digest(readFileSync(location(f.source,'research')));
    const report=await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(digest(readFileSync(location(f.source,'research'))),sourceHash);
    assert.equal(digest(readFileSync(location(join(f.destination,'backup'),'research'))),report.databases.find(row=>row.name==='plugin:@roc/plugin-research').backupHash);
    const backup=new Database(location(join(f.destination,'backup'),'research'),{readonly:true});
    assert.equal(backup.prepare('SELECT status FROM research_projects WHERE id=?').pluck().get(f.project.id),'archived');
    backup.close();
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    const research=new Database(location(join(f.destination,'current'),'research'));
    try {
      schemas.applyAgentDatabaseSchema(agent);schemas.applyResearchDatabaseSchema(research);
      const tasks=new api.ResearchTaskRepository(agent);
      const repository=new api.ResearchRepository(research,tasks);
      const workflow=repository.getWorkflow(f.project.id);
      assert.equal(workflow.projectStatus,'archived');
      assert.equal(workflow.currentStage,'discovery');
      assert.equal(repository.getArtifact('old-plan').status,'superseded');
      assert.equal(workflow.stages.find(stage=>stage.stage==='discovery').gateApproved,false);
      const raw=research.prepare("SELECT raw_json FROM execution_historical_audit WHERE source_table='research_projects' AND source_id=?").pluck().get(f.project.id);
      assert.equal(JSON.parse(raw).status,'archived');
      assert.throws(()=>repository.runs.begin({projectId:f.project.id,expectedStage:'discovery',instruction:'still archived',requestId:'no-dispatch'}),/research_project_archived/);
    } finally {agent.close();research.close();}
  } finally {f.close();}
});

async function legacySearch(f, strategyBound) {
  const db=new Database(location(f.source,'research'));
  const agent=new Database(location(f.source,'agent'));
  const timestamp='2026-11-07T00:00:00.000Z';
  try {
    const repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agent));
    const record={id:'crossref:fixture',source:'crossref',externalId:'fixture',doi:'10.1234/fixture',
      title:'Synthetic migration source',authors:['Fixture Author'],abstract:'Synthetic evidence.',publishedYear:2026,
      citationCount:null,url:null,openAccessUrl:null,importedAt:timestamp,updatedAt:timestamp};
    const ranked={record,rank:1,identifiers:[],rawIdentifiers:null,
      review:{publicationType:null,copies:[],updates:[],retraction:{status:'unknown',field:null}}};
    const search={searchDetailed:async()=>({records:[ranked],sources:[{source:'crossref',status:'ok',returnedCount:1,
      errorCode:null,retryAfterMs:null,requests:[],governance:api.createLiteratureProviderGovernor().observe('api.crossref.org'),
      coverage:{state:'unknown',apiHitCount:null,validatedPages:1,nextPage:null},stopReason:'continuation_unavailable',pages:[]}],
      status:'complete',truncated:false,warnings:[]})};
    const service=new api.LiteratureImportService(db,repository.library,search,{},async()=>{},()=>timestamp);
    const scope={owner:'thread:migration',projectId:f.project.id};
    const result=await api.withLiteratureContext(scope,()=>service.search({query:'Synthetic migration',sources:['crossref'],limit:10}));
    const strategy=strategyBound?{artifactId:'old-plan',contentHash:'a'.repeat(64),approvedAt:timestamp,
      researchQuestion:'Frozen old research question',queryIndex:0}:null;
    const oldResult={...result,schemaVersion:13,strategy};
    db.prepare('UPDATE research_literature_searches SET result_json=? WHERE id=?').run(JSON.stringify(oldResult),result.searchId);
    const {contentHash:_hash,...body}=JSON.parse(db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?')
      .pluck().get(result.executionId));
    body.strategy=strategy;
    const pool={...body,contentHash:digest(JSON.stringify(body))};
    const poolJson=JSON.stringify(pool);
    db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(poolJson,result.executionId);
    db.prepare('UPDATE research_literature_search_executions SET request_json=? WHERE id=?')
      .run(JSON.stringify({request:body.request,strategy}),result.executionId);
    return {result:oldResult,pool,poolJson,scope,ranked};
  } finally {db.close();agent.close();}
}

for (const strategyBound of [true,false]) test(`cold migration retains ${strategyBound?'historical stage':'unbound review'} search results, ranks and pool integrity`,async()=>{
  const f=fixture(false,true);
  try {
    const old=await legacySearch(f,strategyBound);
    const originalHash=digest(readFileSync(location(f.source,'research')));
    await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(digest(readFileSync(location(f.source,'research'))),originalHash);
    const db=new Database(location(join(f.destination,'current'),'research'));
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    try {
      schemas.applyResearchDatabaseSchema(db);schemas.applyAgentDatabaseSchema(agent);
      const repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agent));
      const service=new api.LiteratureImportService(db,repository.library,{}, {},async()=>{},()=>old.result.createdAt);
      const result=api.withLiteratureContext(old.scope,()=>service.readSearch({searchId:old.result.searchId,offset:0,limit:10}));
      const pool=api.withLiteratureContext(old.scope,()=>service.readPool({executionId:old.result.executionId,offset:0,limit:10}));
      assert.equal(result.schemaVersion,14);
      assert.deepEqual(result.candidates,old.result.candidates);
      assert.deepEqual(result.ranking,old.result.ranking);
      assert.deepEqual(result.sources,old.result.sources);
      assert.deepEqual(pool.records,old.pool.records);
      assert.deepEqual(pool.sources,old.pool.sources);
      if(strategyBound){
        assert.equal(result.strategy.kind,'historical');
        assert.equal(result.strategy.reason,'historical_search_plan_not_authorized');
        assert.equal(pool.strategy.kind,'historical');
        assert.notEqual(pool.contentHash,old.pool.contentHash);
        for(const [table,key,expected] of [['research_literature_searches','result_json',old.result],['research_literature_search_pools','pool_json',old.pool]]){
          const audit=db.prepare('SELECT * FROM execution_historical_audit WHERE source_table=?').get(table);
          assert.equal(digest(audit.raw_json),audit.raw_hash);
          assert.deepEqual(JSON.parse(JSON.parse(audit.raw_json)[key]),expected);
        }
      }else{
        assert.equal(result.strategy,null);assert.equal(pool.strategy,null);
        assert.equal(db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(old.result.executionId),old.poolJson);
      }
      assert.throws(()=>api.withLiteratureContext({...old.scope,owner:'other'},()=>service.readPool({executionId:old.result.executionId})),/literature_pool_not_found/);
    } finally {db.close();agent.close();}
  } finally {f.close();}
});

test('offline receipt conversion rejects a corrupt pool without modifying its source',async()=>{
  const f=fixture(false,true);
  try {
    const old=await legacySearch(f,true);
    const db=new Database(location(f.source,'research'));
    db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?')
      .run(JSON.stringify({...old.pool,contentHash:'0'.repeat(64)}),old.result.executionId);db.close();
    const originalHash=digest(readFileSync(location(f.source,'research')));
    await assert.rejects(migrateExecutionDatabases({...f,stopped:true}),/offline_search_pool_corrupt/);
    assert.equal(digest(readFileSync(location(f.source,'research'))),originalHash);
    assert.equal(JSON.parse(readFileSync(join(f.destination,'migration-report.json'),'utf8')).status,'failed');
  } finally {f.close();}
});
