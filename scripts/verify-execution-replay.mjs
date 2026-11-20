import {parseArgs} from 'node:util';
import {resolve, join} from 'node:path';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

// Explicit input only. Verification never opens a writable database or dispatches a tool.
const {values} = parseArgs({options:{
  database:{type:'string'}, project:{type:'string'}, task:{type:'string'}
}});
if (!values.database || !values.project || !values.task) {
  throw new Error('usage: node scripts/verify-execution-replay.mjs --database <agent.db> --project <id> --task <id>');
}
const {verifyTaskReplay} = await importTypeScriptModule('src/main/infrastructure/execution-replay-verifier.ts', {
  platform:'node', external:['zod'], tempDir:join(process.cwd(),'.runtime/tmp')
});
const database = resolve(values.database);
const db = new Database(database,{readonly:true,fileMustExist:true});
try {
  const report = db.transaction(()=>{
    const task = db.prepare('SELECT project_id FROM research_tasks WHERE id=?').get(values.task);
    if (task?.project_id !== values.project) throw new Error('execution_replay_scope_mismatch');
    const nextSequence = db.prepare('SELECT next_sequence FROM research_task_event_cursors WHERE task_id=?').pluck().get(values.task);
    const events = db.prepare('SELECT envelope_json FROM research_task_events WHERE task_id=? ORDER BY stream_sequence LIMIT 10001')
      .pluck().all(values.task);
    return verifyTaskReplay({projectId:values.project,taskId:values.task,nextSequence,events});
  })();
  console.log(JSON.stringify({schemaVersion:1,mode:'projection',database,projectId:values.project,
    taskId:values.task,externalCalls:0,report},null,2));
  if (report.kind !== 'complete') process.exitCode=1;
} finally { db.close(); }
