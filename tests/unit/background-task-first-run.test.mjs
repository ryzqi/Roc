import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const options = {platform:'node',external:['better-sqlite3'],tempDir:'.runtime/tmp'};
const {applyAgentDatabaseSchema} = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
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
