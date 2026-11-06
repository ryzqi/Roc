import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
const {verifyTaskReplay} = await importTypeScriptModule('src/main/infrastructure/execution-replay-verifier.ts',
  {platform:'node',external:['zod'],tempDir:join(process.cwd(),'.runtime/tmp')});
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const inputFor=(db,f)=>({projectId:f.project.id,taskId:f.run.taskId,
  nextSequence:db.prepare('SELECT next_sequence FROM research_task_event_cursors WHERE task_id=?').pluck().get(f.run.taskId),
  events:db.prepare('SELECT envelope_json FROM research_task_events WHERE task_id=? ORDER BY stream_sequence').pluck().all(f.run.taskId)});

test('projection replay after physical reopen is deterministic and read-only; gaps duplicates reordering and corruption are explicit',async()=>{
  const f=createResearchFixture(api,'discovery');
  const dir=mkdtempSync(join(tmpdir(),'roc-task-replay-'));
  try {
    f.tasks.setStatus(f.run.taskId,f.project.id,'paused','fixture',['active']);
    const original=inputFor(f.agentDb,f);
    const expected=verifyTaskReplay(original);
    assert.equal(expected.kind,'complete');assert.equal(expected.projection.status,'paused');
    const file=join(dir,'agent.db');await f.agentDb.backup(file);f.close();
    const db=new Database(file);
    try {
      const changes=db.prepare('SELECT total_changes()').pluck().get();
      assert.deepEqual(verifyTaskReplay(inputFor(db,f)),expected);
      assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
      assert.equal(verifyTaskReplay({...original,events:original.events.slice(1)}).reason,'gap');
      assert.equal(verifyTaskReplay({...original,events:original.events.slice(0,-1)}).reason,'gap');
      assert.equal(verifyTaskReplay({...original,events:[original.events[0],...original.events]}).reason,'duplicate');
      assert.equal(verifyTaskReplay({...original,events:[...original.events].reverse()}).kind,'unavailable');
      const tampered=JSON.parse(original.events[0]);tampered.actor.id='forged';
      assert.equal(verifyTaskReplay({...original,events:[JSON.stringify(tampered),...original.events.slice(1)]}).reason,'corrupt');
      assert.equal(verifyTaskReplay({...original,projectId:'foreign'}).reason,'scope_mismatch');
      db.prepare('DELETE FROM research_task_events WHERE task_id=? AND stream_sequence=?').run(f.run.taskId,original.nextSequence-1);
      const tasks=new api.ResearchTaskRepository(db);
      assert.notEqual(tasks.events({projectId:f.project.id,taskId:f.run.taskId,afterSequence:0,limit:200}).gap,null);
    }finally{db.close();}
  }finally{if(f.agentDb.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

test('cross-database event delivery survives acknowledgement failure and reopen without duplicate semantic facts',async()=>{
  const f=createResearchFixture(api,'planning');
  const dir=mkdtempSync(join(tmpdir(),'roc-outbox-replay-'));
  try {
    f.db.prepare(`INSERT INTO research_workflow_events(id,project_id,stage,type,message,payload_json,created_at)
      VALUES('approved',?,'planning','approval_granted','fixture','{}',?)`).run(f.project.id,new Date().toISOString());
    assert.equal(f.db.prepare('SELECT event_type FROM research_execution_outbox').pluck().get(),'plan_approved');
    f.db.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE OF delivered_at ON research_execution_outbox
      WHEN NEW.delivered_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture_ack_failed'); END;`);
    assert.deepEqual(f.repository.runs.flushTaskEvents(),{pending:1,failed:1});
    const before=inputFor(f.agentDb,f);
    assert.equal(before.events.filter(raw=>JSON.parse(raw).eventType==='plan_approved').length,1);
    await f.agentDb.backup(join(dir,'agent.db'));await f.db.backup(join(dir,'research.db'));f.close();
    const agent=new Database(join(dir,'agent.db'));const research=new Database(join(dir,'research.db'));
    try {
      const tasks=new api.ResearchTaskRepository(agent);const repository=new api.ResearchRepository(research,tasks);
      research.exec('DROP TRIGGER fail_ack');
      assert.deepEqual(repository.runs.flushTaskEvents(),{pending:0,failed:0});
      assert.deepEqual(inputFor(agent,f),before);
      assert.equal(research.prepare('SELECT error FROM research_execution_outbox').pluck().get(),null);
      // Same source identity with another payload is corruption, never a second delivery.
      const outbox=research.prepare('SELECT * FROM research_execution_outbox').get();
      assert.throws(()=>tasks.receiveEvent({eventId:outbox.event_id,taskId:outbox.task_id,projectId:outbox.project_id,
        eventType:'quality_gate',payload:JSON.parse(outbox.payload_json),payloadHash:outbox.payload_hash,createdAt:outbox.created_at}),/conflict/);
      assert.deepEqual(inputFor(agent,f),before);
    }finally{agent.close();research.close();}
  }finally{if(f.agentDb.open)f.close();rmSync(dir,{recursive:true,force:true});}
});

test('same-database event failure rolls back task state and cursor',()=>{
  const f=createResearchFixture(api,'discovery');
  try {
    const before=inputFor(f.agentDb,f);
    f.agentDb.exec("CREATE TRIGGER fail_task_event BEFORE INSERT ON research_task_events BEGIN SELECT RAISE(ABORT,'fixture_event_failed'); END;");
    assert.throws(()=>f.tasks.setStatus(f.run.taskId,f.project.id,'paused','fixture',['active']),/fixture_event_failed/);
    assert.equal(f.tasks.get(f.run.taskId,f.project.id).status,'active');
    assert.deepEqual(inputFor(f.agentDb,f),before);
  }finally{f.close();}
});
