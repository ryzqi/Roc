import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {after, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
const options = {platform:'node',external:['better-sqlite3','zod'],tempDir:join(process.cwd(),'.runtime/tmp')};
const {migrateExecutionDatabases} = await importTypeScriptModule('scripts/offline-execution-migration.ts',options);
const schemas = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts',options);
const api = await loadResearchTestApi();
after(()=>api.dispose());
const digest = value => createHash('sha256').update(value).digest('hex');
const definitions = [['core',1],['agent',19],['memory',2],['task',1],['workspace',1],['diagnostics',1],['research',60]];
const location = (root,name) => join(root,name === 'core' ? 'data/core.db' : `data/plugins/@roc/plugin-${name}.db`);
function fixture(fromS02 = false) {
  const root=mkdtempSync(join(tmpdir(),'roc-offline-contract-'));
  const source=join(root,'source');mkdirSync(source);
  for (const [name,oldVersion] of definitions) {
    const version = fromS02 && ['agent','research'].includes(name) ? oldVersion + 1 : oldVersion;
    const file=location(source,name);mkdirSync(dirname(file),{recursive:true});
    const db=new Database(file);
    api.applyDatabaseMigrations(db,{dbName:['core','agent','memory','task'].includes(name)?name:`plugin:@roc/plugin-${name}`,
      migrations:schemas[`${name}Migrations`].slice(0,version)});db.close();
  }
  writeFileSync(join(source,'private-config.json'),'preserved-local-fixture');
  const agent=new Database(location(source,'agent'));const research=new Database(location(source,'research'));
  if (fromS02) {
    api.applyDatabaseMigrations(agent,{dbName:'agent',migrations:schemas.agentMigrations.slice(0,20)});
    api.applyDatabaseMigrations(research,{dbName:'plugin:@roc/plugin-research',migrations:schemas.researchMigrations.slice(0,61)});
  }
  const now=()=> new Date().toISOString();
  const tasks=new api.ResearchTaskRepository(agent,now);
  const repository=new api.ResearchRepository(research,tasks,now);
  const project=repository.createProject({title:'Migration fixture',description:'isolated',workspacePath:join(root,'workspace')});
  const run=repository.runs.begin({projectId:project.id,expectedStage:'discovery',instruction:'private input',requestId:'old-request'});
  repository.runs.terminate(run.id,project.id,'interrupted','stopped-for-migration');
  const current=tasks.requireExecution('stage',run.id,project.id);
  const {nodeBinding:_nodeBinding,origin:_origin,frozenInputs:_frozenInputs,associationState:_associationState,...legacy}=current;
  if (!fromS02) agent.prepare("UPDATE research_task_executions SET snapshot_json=? WHERE execution_id=?").run(JSON.stringify({...legacy,schemaVersion:1}),run.id);
  const {executionSnapshot:_executionSnapshot,...oldRun}=repository.runs.get(run.id,project.id);
  if (!fromS02) research.prepare('UPDATE research_stage_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(oldRun),run.id);
  research.prepare("UPDATE research_stage_runs SET context_json=json_remove(context_json,'$.skillPin') WHERE id=?").run(run.id);
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
  return {root,source,destination:join(root,'converted'),project,run,budgetBefore,eventsBefore,bytes,
    close:()=>rmSync(root,{recursive:true,force:true})};
}
test('offline conversion preserves source and cold backup, fences historical identity and retains unknown budget',async()=>{
  const f=fixture();
  try {
    const report=await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(report.status,'complete');assert.equal(report.databases.length,7);
    for(const [name] of definitions) assert.equal(digest(readFileSync(location(f.source,name))),f.bytes[name]);
    assert.equal(readFileSync(join(f.destination,'current/private-config.json'),'utf8'),'preserved-local-fixture');
    const backup=new Database(location(join(f.destination,'backup'),'agent'));
    assert.equal(backup.prepare('SELECT current_version FROM schema_metadata').pluck().get(),19);
    assert.deepEqual(backup.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all(),f.budgetBefore);
    assert.deepEqual(backup.prepare('SELECT * FROM research_task_events').all(),f.eventsBefore);backup.close();
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    const research=new Database(location(join(f.destination,'current'),'research'));
    try {
      assert.equal(agent.prepare('SELECT current_version FROM schema_metadata').pluck().get(),20);
      const calls=agent.prepare('SELECT * FROM agent_budget_calls ORDER BY call_id').all();
      assert.deepEqual(calls,f.budgetBefore.map(row=>({...row,state:row.state==='reserved'?'unknown':row.state})));
      const tasks=new api.ResearchTaskRepository(agent);
      const repository=new api.ResearchRepository(research,tasks);
      repository.runs.reconcileTaskLinks();
      const association=tasks.requireExecution('stage',f.run.id,f.project.id);
      assert.equal(association.schemaVersion,2);assert.equal(association.associationState,'historical');
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

test('S02 skill cutover keeps raw context, events and unrelated chat while fencing historical stages after cold open',async()=>{
  const f=fixture(true);
  try {
    const oldResearch=new Database(location(f.source,'research'));
    const original=oldResearch.prepare('SELECT * FROM research_stage_runs WHERE id=?').get(f.run.id);
    assert.throws(()=>schemas.applyResearchDatabaseSchema(oldResearch),/database_offline_migration_required/);
    oldResearch.close();
    const report=await migrateExecutionDatabases({...f,stopped:true});
    assert.equal(report.sourceApp,'7120421-S02');
    assert.deepEqual(report.databases.find(entry=>entry.name==='plugin:@roc/plugin-research').from,61);
    for(const [name] of definitions) assert.equal(digest(readFileSync(location(f.source,name))),f.bytes[name]);
    const agent=new Database(location(join(f.destination,'current'),'agent'));
    const research=new Database(location(join(f.destination,'current'),'research'));
    try {
      schemas.applyAgentDatabaseSchema(agent);schemas.applyResearchDatabaseSchema(research);
      assert.equal(research.prepare('SELECT current_version FROM schema_metadata').pluck().get(),62);
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
      const fresh=repository.runs.begin({projectId:f.project.id,expectedStage:'discovery',instruction:'new task',requestId:'fresh-contract'});
      assert.equal(repository.runs.getContext(fresh.id).skillPin.stage,'discovery');
      assert.equal(tasks.requireExecution('stage',fresh.id,f.project.id).associationState,'confirmed');
    } finally {agent.close();research.close();}
  } finally {f.close();}
});
