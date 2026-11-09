import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const toolName = 'research_review_execute_query';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture() {
  const f = createResearchFixture(api, 'discovery');
  const runId = 'review-owner-run', threadId = 'review-owner-thread';
  const timestamp = '2026-11-05T00:00:00.000Z';
  // The test main process freezes the actual project tool manifest. No model
  // arguments provide this manifest, parent run or project association.
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: f.project.id
  }).manifest;
  const snapshot = api.createRunExecutionSnapshot({
    runId, threadId, inputMessageId: 'review-owner-message', snapshot: {
      schemaVersion: 11, submissionHash: 'a'.repeat(64),
      taskContract: {contractVersion: 1, objective: 'Execute frozen review query', constraints: [], kind: 'reply',
        criteria: [{id: 'query', description: 'Read the query receipt', check: {kind: 'response'}}]},
      runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture'}, mode: 'run', workspace: null,
      capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
      researchProjectId: f.project.id, modelConfig: api.createRunModelConfig({contextWindowTokens: null})
    }
  });
  f.agentDb.prepare(`INSERT INTO agent_threads
    (id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Review','Review','active',?,?,?)`).run(threadId, f.project.id, timestamp, timestamp);
  f.agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Review','running',?,'{}','chat',?,11)`).run(runId, threadId, timestamp, JSON.stringify(snapshot));
  let now = new Date(timestamp);
  const broker = new api.ExecutionGrantBroker(f.agentDb, () => now);
  const request = {projectId: f.project.id, requestId: 'owned-query-request', versionId: 'frozen-protocol',
    expectedFreezeHash: 'b'.repeat(64), databaseIndex: 0, queryIndex: 0, retryOf: null, expectedRetrySnapshotHash: null};
  const issue = (overrides = {}) => broker.issueReviewSearchDispatch({runId, threadId, manifest, request, ...overrides});
  const taskCount = f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get();
  const executionCount = f.agentDb.prepare('SELECT COUNT(*) FROM research_task_executions').pluck().get();
  return {...f, runId, threadId, manifest, snapshot, broker, request, issue, taskCount, executionCount,
    setNow: value => {now = value;}};
}

test('frozen-query grant binds exact parent, project, request domain and manifest with an uncopyable consumed token', () => {
  const f = fixture();
  try {
    const reference = f.issue();
    const row = f.agentDb.prepare('SELECT * FROM agent_research_dispatch_grants WHERE id=?').get(reference);
    assert.equal(row.tool_name, toolName);
    assert.equal(row.request_hash, api.reviewSearchDispatchRequestHash(f.request));
    const grant = f.broker.consumeReviewSearchDispatch(reference, f.request);
    assert.equal(grant.runId, f.runId); assert.equal(grant.threadId, f.threadId);
    assert.equal(grant.projectId, f.project.id); assert.equal(grant.manifestHash, f.manifest.manifestHash);
    assert.equal(Object.isFrozen(grant), true);
    api.assertReviewSearchDispatchGrant(grant);
    assert.throws(() => api.assertReviewSearchDispatchGrant({...grant}), /research_review_dispatch_grant_untrusted/u);
    assert.throws(() => api.assertResearchDispatchGrant(grant), /research_dispatch_grant_untrusted/u);
    assert.throws(() => f.broker.consumeReviewSearchDispatch(reference, f.request), /research_dispatch_grant_unavailable/u);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_task_executions').pluck().get(), f.executionCount);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get(), f.taskCount);
  } finally {f.close();}
});

test('every declared query/retry field and project must match before the one-shot grant can be consumed', () => {
  const f = fixture();
  try {
    const reference = f.issue();
    for (const change of [
      {projectId: 'other-project'}, {requestId: 'other-request'}, {versionId: 'other-protocol'},
      {expectedFreezeHash: 'c'.repeat(64)}, {databaseIndex: 1}, {queryIndex: 1},
      {retryOf: 'prior-query', expectedRetrySnapshotHash: 'd'.repeat(64)}
    ]) {
      assert.throws(() => f.broker.consumeReviewSearchDispatch(reference, {...f.request, ...change}), /research_dispatch_request_mismatch/u);
      assert.equal(f.agentDb.prepare('SELECT state FROM agent_research_dispatch_grants WHERE id=?').pluck().get(reference), 'issued');
    }
    api.assertReviewSearchDispatchGrant(f.broker.consumeReviewSearchDispatch(reference, f.request));
    assert.throws(() => f.issue({request: {...f.request, runId: f.runId}}));
  } finally {f.close();}
});

test('stage and review credentials cannot cross domains even if both tools belong to the same frozen manifest', () => {
  const f = fixture();
  try {
    const stage = {projectId: f.project.id, expectedStage: 'discovery', instruction: 'Frozen query', requestId: f.request.requestId};
    const reference = f.broker.issueResearchDispatch({runId: f.runId, threadId: f.threadId, manifest: f.manifest, request: stage});
    assert.throws(() => f.broker.consumeReviewSearchDispatch(reference, f.request), /research_dispatch_request_mismatch/u);
    const stageGrant = f.broker.consumeResearchDispatch(reference, stage);
    assert.throws(() => api.assertReviewSearchDispatchGrant(stageGrant), /research_review_dispatch_grant_untrusted/u);
    const review = f.issue();
    assert.throws(() => f.broker.consumeResearchDispatch(review, stage), /research_dispatch_request_mismatch/u);
    api.assertReviewSearchDispatchGrant(f.broker.consumeReviewSearchDispatch(review, f.request));
  } finally {f.close();}
});

test('expired, revoked, restarted, terminal and changed owner snapshots cannot authorize a review query', () => {
  for (const condition of ['expired', 'revoked', 'restart', 'terminal', 'project', 'manifest', 'thread', 'missing-tool']) {
    const f = fixture();
    try {
      const reference = f.issue();
      if (condition === 'expired') f.setNow(new Date('2026-11-05T00:00:30.000Z'));
      if (condition === 'revoked') f.broker.revokeRun(f.runId);
      if (condition === 'restart') f.broker.reconcileStartupState();
      if (condition === 'terminal') f.agentDb.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(f.runId);
      if (condition === 'project') f.agentDb.prepare("UPDATE agent_threads SET research_project_id='other' WHERE id=?").run(f.threadId);
      if (condition === 'manifest') {
        const changed = structuredClone(f.snapshot); changed.capabilityManifest.tools = [];
        f.agentDb.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(changed), f.runId);
      }
      if (condition === 'thread') assert.throws(() => f.issue({threadId: 'invented'}), /research_dispatch_parent_not_active/u);
      else if (condition === 'missing-tool') assert.throws(() => f.issue({manifest: {...f.manifest, tools: []}}), /research_dispatch_capability_denied/u);
      else assert.throws(() => f.broker.consumeReviewSearchDispatch(reference, f.request), /research_dispatch_/u);
      if (condition === 'expired') assert.equal(f.agentDb.prepare('SELECT state FROM agent_research_dispatch_grants WHERE id=?').pluck().get(reference), 'expired');
      if (condition === 'revoked' || condition === 'restart') assert.equal(f.agentDb.prepare('SELECT state FROM agent_research_dispatch_grants WHERE id=?').pluck().get(reference), 'revoked');
    } finally {f.close();}
  }
});

test('valid parent manifests must explicitly grant the review tool in main scope before issuing any credential', () => {
  for (const condition of ['absent', 'subagent-only']) {
    const f = fixture();
    try {
      const {manifestHash, ...content} = f.manifest;
      content.tools = content.tools.flatMap(tool => tool.modelVisibleName !== toolName ? [tool] :
        condition === 'absent' ? [] : [{...tool, executionScopes: ['subagent']}]);
      const manifest = {...content, manifestHash: hash(content)};
      const snapshot = api.createRunExecutionSnapshot({runId: f.runId, threadId: f.threadId, inputMessageId: f.snapshot.inputMessageId,
        snapshot: {...f.snapshot, capabilityManifest: manifest}});
      f.agentDb.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), f.runId);
      assert.throws(() => f.issue({manifest}), /research_dispatch_capability_denied/u);
      assert.equal(f.agentDb.prepare('SELECT count(*) FROM agent_research_dispatch_grants').pluck().get(), 0);
    } finally {f.close();}
  }
});

test('agent migration16 preserves every historical stage credential and ledger receipt with explicit tool domains', () => {
  const f = fixture(), db = new Database(':memory:');
  const timestamp = '2026-11-05T00:00:00.000Z';
  try {
    db.pragma('foreign_keys = ON');
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations.filter(migration => migration.version <= 15),
      now: () => timestamp});
    db.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,created_at,updated_at)
      VALUES (?,'chat','Review','Review','active',?,?)`).run(f.threadId, timestamp, timestamp);
    db.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin)
      VALUES (?,?,1,'Review','running',?,'{}','chat')`).run(f.runId, f.threadId, timestamp);
    for (const state of ['issued', 'consumed', 'expired', 'revoked']) {
      db.prepare(`INSERT INTO agent_research_dispatch_grants
        (id,run_id,thread_id,project_id,request_hash,manifest_hash,state,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(state, f.runId, f.threadId, f.project.id, 'a'.repeat(64),
          f.manifest.manifestHash, state, timestamp, '2026-11-05T00:00:30.000Z');
    }
    const rows = db.prepare('SELECT * FROM agent_research_dispatch_grants ORDER BY id').all();
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations, allowOffline: true});
    assert.deepEqual(db.prepare('SELECT * FROM agent_research_dispatch_grants ORDER BY id').all(),
      rows.map(row => ({...row, tool_name: 'research_run_stage'})));
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=15 ORDER BY version').all(), ledger);
    assert.throws(() => db.prepare("UPDATE agent_research_dispatch_grants SET tool_name='invented' WHERE id='issued'").run(),
      /CHECK constraint/u);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations, allowOffline: true});
    assert.equal(db.prepare('SELECT count(*) FROM agent_research_dispatch_grants').pluck().get(), 4);
  } finally {db.close(); f.close();}
});

test('review dispatch context propagates the exact parent signal across awaits and isolates concurrent operations', async () => {
  const first = new AbortController(), second = new AbortController();
  assert.equal(api.reviewSearchDispatchContext(), undefined);
  await Promise.all([first, second].map(async (controller, index) => api.withReviewSearchDispatch({
    reference: `review-reference-${index}`, signal: controller.signal
  }, async () => {
    await Promise.resolve();
    assert.deepEqual(api.reviewSearchDispatchContext(), {reference: `review-reference-${index}`, signal: controller.signal});
    if (index === 0) first.abort(new Error('actual-parent-cancelled'));
    assert.equal(api.reviewSearchDispatchContext().signal.aborted, index === 0);
  })));
  assert.equal(api.reviewSearchDispatchContext(), undefined);
  assert.throws(() => api.withReviewSearchDispatch({reference: 'cancelled', signal: first.signal}, () => assert.fail('no dispatch')), /actual-parent-cancelled/u);
});
