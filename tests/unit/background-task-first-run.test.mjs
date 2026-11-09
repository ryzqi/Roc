import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const options = {platform:'node',external:['better-sqlite3'],tempDir:'.runtime/tmp'};
const {applyAgentDatabaseSchema, agentMigrations} = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const {AgentTaskHistoryContract} = await importTypeScriptModule('src/main/plugins/agent/agent-task-history-contract.ts', options);
const task = {id:'scheduled',threadId:'background-thread',runId:'placeholder',goal:'Check build',status:'running',
  createdAt:'2026-11-09T01:00:00.000Z',updatedAt:'2026-11-09T01:00:00.000Z',enabledCapabilities:null,workspacePath:'/tmp/workspace'};
function setup() {const db=new Database(':memory:');applyAgentDatabaseSchema(db);return db;}
function insertRun(db, id, snapshot, threadId=task.threadId) {
  db.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,snapshot_json)
    VALUES(?,?,2,'Check build','running',?,'{"mcpServers":[],"skills":[]}',?)`).run(id,threadId,task.createdAt,snapshot);
}
test('a scheduled task placeholder leaves the active run slot available for its first execution', () => {
  const db=setup();try {
    const history=new AgentTaskHistoryContract(db);history.ensureBackgroundTaskThread(task);
    assert.equal(history.findRun(task.runId).status,'draft');
    insertRun(db,'first-execution','{"fixture":"real execution"}');
    assert.throws(()=>insertRun(db,'second-execution','{}'),/UNIQUE constraint/);
    db.prepare("UPDATE agent_runs SET status='completed' WHERE id='first-execution'").run();
    history.ensureBackgroundTaskThread({...task,runId:'first-execution'});
    assert.equal(history.findRun('first-execution').status,'completed');
  } finally {db.close();}
});
test('legacy placeholder repair preserves genuine executions and is idempotent', () => {
  const db=setup();try {
    const history=new AgentTaskHistoryContract(db);history.ensureBackgroundTaskThread(task);
    db.prepare("UPDATE agent_runs SET status='running' WHERE id='placeholder'").run();
    for (const name of ['snapshot','leased']) {
      history.ensureBackgroundTaskThread({...task,threadId:name,runId:name});
      db.prepare("UPDATE agent_runs SET status='running',snapshot_json=? WHERE id=?").run(name==='snapshot'?'{}':null,name);
    }
    db.prepare('INSERT INTO agent_run_leases(thread_id,run_id,acquired_at) VALUES(?,?,?)').run('leased','leased',task.createdAt);
    const migration=agentMigrations.find(m=>m.name==='background_task_placeholder_runs');assert.ok(migration);
    db.exec(migration.sql);db.exec(migration.sql);
    assert.equal(history.findRun('placeholder').status,'draft');
    assert.equal(history.findRun('snapshot').status,'running');
    assert.equal(history.findRun('leased').status,'running');
    insertRun(db,'first-execution','{}');
  } finally {db.close();}
});
