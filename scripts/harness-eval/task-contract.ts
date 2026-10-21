import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyAgentDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { TaskContractStore } from '../../src/main/services/deep-agent/task-contract-store';
import { RunBudgetLedger } from '../../src/main/services/deep-agent/run-budget-ledger';

export async function verifyTaskContracts(directory: string): Promise<Record<string, unknown>> {
  const db = new Database(join(directory, 'agent.sqlite'));
  try {
    applyAgentDatabaseSchema(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_threads (id,kind,title,goal,status,created_at,updated_at)
      VALUES ('thread','chat','contract fixture','contract fixture','active',?,?)`).run(now, now);
    db.prepare(`INSERT INTO agent_threads (id,kind,title,goal,status,created_at,updated_at)
      VALUES ('thread_partial','chat','partial fixture','partial fixture','active',?,?)`).run(now, now);
    db.prepare(`INSERT INTO agent_threads (id,kind,title,goal,status,created_at,updated_at)
      VALUES ('thread_restart','chat','restart fixture','restart fixture','interrupted',?,?)`).run(now, now);
    for (const [id, threadId] of [['run', 'thread'], ['run_partial', 'thread_partial']] as const) {
      db.prepare(`INSERT INTO agent_runs (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json)
        VALUES (?, ?, 1, 'contract fixture', 'running', ?, '{}')`).run(id, threadId, now);
    }
    db.prepare(`INSERT INTO agent_runs (id,thread_id,run_number,user_input,status,started_at,ended_at,enabled_capabilities_json)
      VALUES ('run_restart','thread_restart',1,'resume same task','interrupted',?,?, '{}')`).run(now, now);
    const workspacePath = join(directory, 'workspace');
    mkdirSync(workspacePath);
    const artifactPath = join(workspacePath, 'result.txt');
    const initialBytes = 'verified artifact v1';
    const expectedHash = createHash('sha256').update(initialBytes).digest('hex');
    writeFileSync(artifactPath, initialBytes);
    const store = new TaskContractStore(db);
    store.initialize('run', {
      contractVersion: 1,
      objective: 'Produce a checked artifact and a visible response.',
      constraints: [],
      kind: 'task',
      criteria: [
        { id: 'A-01', description: 'Artifact matches the expected bytes.', check: { kind: 'artifact_sha256', path: 'result.txt', sha256: expectedHash } },
        { id: 'A-02', description: 'Visible response exists.', check: { kind: 'response' } }
      ]
    });
    const context = { workspacePath, response: 'Completed with evidence.' };
    const satisfied = await store.verify('run', context);
    assert.equal(satisfied.status, 'satisfied');
    assert.equal(satisfied.criteria.every((criterion) => criterion.verdict === 'passed' && criterion.artifactRefs.length > 0), true);
    writeFileSync(artifactPath, 'verified artifact changed');
    const stale = await store.refreshReport('run', context);
    assert.equal(stale?.status, 'stale');
    assert.equal(stale?.criteria.find((criterion) => criterion.id === 'A-01')?.verdict, 'failed');

    store.initialize('run_partial', {
      contractVersion: 1,
      objective: 'Keep remaining acceptance visible.',
      constraints: [],
      kind: 'task',
      criteria: [
        { id: 'B-01', description: 'Visible response exists.', check: { kind: 'response' } },
        { id: 'B-02', description: 'Research review still needs a verifier.', check: { kind: 'unverified' } }
      ]
    });
    const partial = await store.verify('run_partial', context);
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.remainingItems, ['B-02: Research review still needs a verifier.']);
    const blocked = await store.verify('run_partial', context, ['Approval pending: approval-fixture']);
    db.prepare(`INSERT INTO agent_pending_interrupts VALUES ('run_partial','thread_partial','approval-fixture',0,'{}',?,?)`).run(now, now);
    const handoff = store.saveHandoff('run_partial', { reason: 'approval_pending', checkpointPresent: true });
    store.assertHandoffCanResume('run_partial', 'thread_partial', 'approval-fixture');
    assert.equal(blocked.status, 'blocked');
    assert.equal(handoff.acceptanceReport?.status, 'blocked');
    assert.deepEqual(handoff.pendingApprovals, ['approval-fixture']);
    assert.throws(() => store.assertHandoffCanResume('run_partial', 'other-thread', 'approval-fixture'), /snapshot_mismatch/);

    store.initialize('run_restart', {
      contractVersion: 1,
      objective: 'Continue the same task after process restart.',
      constraints: ['Do not repeat completed effects.'],
      kind: 'task',
      criteria: [{ id: 'C-01', description: 'Re-check the saved artifact evidence.', check: { kind: 'unverified' } }]
    });
    store.createUnverifiedReport('run_restart', 'Process restarted before the task completed.');
    db.prepare(`INSERT INTO agent_budget_calls
      (run_id,call_id,kind,input_hash,reserved_tokens,actual_tokens,state,envelope_json,created_at)
      VALUES ('run_restart','child_restart','child','input-hash',0,0,'unknown',?,?)`)
      .run(JSON.stringify({ childTaskId: 'child_restart', outcomeStatus: 'failed', failureCode: 'child_task_failed' }), now);
    const restartHandoff = store.saveHandoff('run_restart', { reason: 'restart', checkpointPresent: true });
    store.assertCheckpointHandoffCanResume('run_restart', 'thread_restart');
    const continuation = store.createCheckpointContinuationContext('run_restart');
    const continuationSequence = store.enqueueCheckpointContinuation('run_restart', continuation);
    assert.equal(restartHandoff.acceptanceReport?.checkpointResumeAvailable, true);
    assert.deepEqual(restartHandoff.childTasks, [{ childTaskId: 'child_restart', state: 'unknown', outcomeStatus: 'failed',
      outcomeHash: null, failureCode: 'child_task_failed' }]);
    assert.ok(continuation.includes('Continue the same task after process restart.'));
    assert.ok(continuation.includes('child_task_failed'));
    assert.equal((db.prepare('SELECT content FROM agent_run_inbox WHERE run_id = ?').get('run_restart') as { content: string }).content, continuation);
    const ledger = new RunBudgetLedger(db);
    ledger.consumeCorrections('run_restart', ['roc-correction:task-handoff:run_restart']);
    const refreshedContinuation = `${continuation}\n[Refreshed acceptance evidence after a second crash.]`;
    assert.equal(store.enqueueCheckpointContinuation('run_restart', refreshedContinuation), continuationSequence);
    assert.deepEqual(ledger.pendingCorrections('run_restart'), [{
      submission_id: 'task-handoff:run_restart',
      content: refreshedContinuation
    }]);
    db.prepare(`INSERT INTO agent_tool_effects
      (run_id,thread_id,execution_path,checkpoint_id,tool_call_id,tool_name,input_hash,effect_class,reconcile_strategy,status,created_at,updated_at)
      VALUES ('run_restart','thread_restart','main','checkpoint','effect_restart','write_file','effect-hash',
        'workspace_mutation','manual_confirmation','unknown',?,?)`).run(now, now);
    assert.throws(() => store.assertCheckpointHandoffCanResume('run_restart', 'thread_restart'), /effect_reconciliation_required/);
    db.prepare("DELETE FROM agent_tool_effects WHERE run_id = 'run_restart'").run();
    const evidence = {
      satisfiedCriteria: satisfied.criteria.length,
      staleAfterArtifactChange: stale?.status,
      partialRemaining: partial.remainingItems,
      blockedBy: blocked.blockedBy,
      handoffApproval: handoff.pendingApprovals[0],
      restartChildFailure: restartHandoff.childTasks[0]?.failureCode,
      checkpointResume: restartHandoff.acceptanceReport?.checkpointResumeAvailable,
      checkpointRetryRequeuesFreshEvidence: ledger.pendingCorrections('run_restart')[0]?.content === refreshedContinuation,
      responseEvidence: satisfied.criteria.find((criterion) => criterion.id === 'A-02')?.artifactRefs[0]?.sha256
    };
    writeFileSync(join(directory, 'task-contract.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    db.close();
  }
}
