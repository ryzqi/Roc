import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewSearchFixture, awaitReviewSearchFixture} from './fixtures/research-review-search.mjs';
import {createReviewMigrationSeedApi} from './fixtures/research-review-migration-seed.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function chat(f, id = 'owned-query-parent', overrides = {}) {
  const runId = id, threadId = `${id}-thread`, timestamp = new Date().toISOString();
  const compiled = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: f.project.id
  }).manifest;
  const {manifestHash, ...content} = compiled;
  const source = content.tools.find(tool => tool.modelVisibleName === 'research_run_stage');
  for (const name of ['research_review_execute_query', 'research_review_get_query', 'research_review_cancel_query']) {
    content.tools.push({...source, modelVisibleName: name, canonicalIdentity: `builtin:${name}`});
  }
  const manifest = {...content, manifestHash: hash(content)};
  const budget = {...api.createRunBudget({contextBudgetTokens: null, startedAt: timestamp}), ...overrides};
  const snapshot = api.createRunExecutionSnapshot({runId, threadId, inputMessageId: `${id}-message`, snapshot: {
    schemaVersion: 9, submissionHash: 'a'.repeat(64),
    taskContract: {contractVersion: 1, objective: 'Execute exact frozen query', constraints: [], kind: 'reply',
      criteria: [{id: 'query', description: 'Read exact receipts', check: {kind: 'response'}}]},
    runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture'}, mode: 'run', workspace: null,
    capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
    researchProjectId: f.project.id, budget
  }});
  f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Review','Review','active',?,?,?)`).run(threadId, f.project.id, timestamp, timestamp);
  f.agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Review','running',?,'{}','chat',?,9)`).run(runId, threadId, timestamp, JSON.stringify(snapshot));
  const broker = new api.ExecutionGrantBroker(f.agentDb), controller = new AbortController();
  const grant = (request = f.request) => broker.consumeReviewSearchDispatch(
    broker.issueReviewSearchDispatch({runId, threadId, manifest, request}), request);
  const owner = (toolName = 'research_review_get_query') => broker.authorizeReviewSearchOwner({
    runId, threadId, projectId: f.project.id, manifest, toolName
  });
  return {runId, threadId, manifest, budget, snapshot, broker, controller, grant, owner};
}

test('first owned query creates a trusted chat task before network and backfills existing model budget exactly once', async () => {
  const f = createReviewSearchFixture(api), c = chat(f, undefined, {maxCostMicrousd: 100});
  try {
    const ledger = new api.RunBudgetLedger(f.agentDb);
    ledger.reserve(c.runId, c.budget, {id: 'parent-model', kind: 'model', inputHash: 'a'.repeat(64),
      tokens: 50, costMicrousd: 60, envelope: {}});
    ledger.settle(c.runId, 'parent-model', 40, 'settled', undefined, {}, 45);
    assert.equal(f.tasks.taskForChat(c.runId), null);
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal);
    assert.equal(f.calls.length, 0);
    const {association} = started, task = f.tasks.taskForChat(c.runId);
    assert.equal(association.kind, 'review_search');
    assert.equal(association.parentKind, 'chat'); assert.equal(association.parentExecutionId, c.runId);
    assert.equal(association.taskId, task.id); assert.equal(task.rootAgentRunId, c.runId);
    assert.deepEqual(started.search.snapshot.actor, {kind: 'agent', id: c.runId});
    assert.deepEqual(f.tasks.budgetForExecution('chat', c.runId, f.project.id), c.budget);
    assert.equal(f.agentDb.prepare('SELECT task_id FROM agent_budget_calls WHERE call_id=?').pluck().get('parent-model'), task.id);
    assert.equal(ledger.readTaskBudgetStatus(task.id, f.project.id).tokens.settled, 40);
    assert.equal(ledger.readTaskBudgetStatus(task.id, f.project.id).cost.settledMicrousd, 45);
    const done = await awaitReviewSearchFixture(f, started.search);
    assert.equal(done.status, 'complete'); assert.equal(done.rawRecordCount, 4);
    const count = f.agentDb.prepare('SELECT COUNT(*) FROM research_task_executions').pluck().get(), changes = f.changes();
    assert.deepEqual(f.reviews.startOwned(f.request, c.grant(), c.controller.signal), {search: done, association});
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_task_executions').pluck().get(), count);
    assert.equal(f.changes(), changes); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.reviews.getOwned({projectId: f.project.id, reviewSearchId: done.snapshot.id}, c.owner()), {search: done, association});
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, ledger, f.reviews).get({projectId: f.project.id, taskId: task.id});
    const execution = diagnostics.executions.find(item => item.association.kind === 'review_search');
    assert.equal(execution.status, 'complete'); assert.equal(execution.stage, null);
    assert.equal(execution.startedAt, done.snapshot.startedAt); assert.equal(execution.endedAt, done.receipt.endedAt);
    const events = f.tasks.events({taskId: task.id, projectId: f.project.id, afterSequence: 0, limit: 200}).events;
    assert.ok(events.some(event => event.executionKind === 'review_search' && event.executionId === done.snapshot.id));
    assert.equal(events.filter(event => event.eventType === 'call_linked').length, 1);
    assert.deepEqual(f.events, [0, 1].map(() => ({taskId: task.id, projectId: f.project.id})));
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('owned reads and cancellation require actual owner and frozen main scope; manual authority stays distinct', async () => {
  const f = createReviewSearchFixture(api), c = chat(f), other = chat(f, 'foreign-same-project');
  try {
    const grant = c.grant(), started = f.reviews.startOwned(f.request, grant, c.controller.signal);
    const request = {projectId: f.project.id, reviewSearchId: started.search.snapshot.id};
    assert.throws(() => f.reviews.startOwned(f.request, {...grant}, c.controller.signal), /grant_untrusted/u);
    assert.throws(() => f.reviews.getOwned(request, {...c.owner()}), /owner_untrusted/u);
    assert.throws(() => f.reviews.getOwned(request, other.owner()), /owner_mismatch/u);
    assert.throws(() => f.reviews.cancelOwned({...request, requestId: 'stolen', expectedRevision: 1, note: 'stolen'},
      other.owner('research_review_cancel_query')), /owner_mismatch/u);
    assert.throws(() => f.reviews.cancelOwned({...request, requestId: 'read-only', expectedRevision: 1, note: 'read only'},
      c.owner()), /owner_tool_mismatch/u);
    assert.throws(() => f.reviews.start(f.request, {kind: 'user', id: c.runId}), /request_conflict/u);
    assert.throws(() => f.reviews.startOwned({...f.request, queryIndex: 1}, grant, c.controller.signal), /request_mismatch/u);
    const foreign = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/foreign-owned-query'});
    assert.throws(() => f.reviews.getOwned({...request, projectId: foreign.id}, c.owner()), /project_mismatch/u);
    const done = await awaitReviewSearchFixture(f, started.search);
    assert.deepEqual(f.reviews.get(request), done);
    const previousScope = c.owner();
    c.broker.revokeRun(c.runId);
    assert.throws(() => c.owner(), /parent_revoked/u);
    assert.throws(() => f.reviews.getOwned(request, previousScope), /parent_revoked/u);
    assert.equal(f.calls.length, 2); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('internal owned capabilities reject missing trusted contexts and renderer arguments before dispatch', async () => {
  const f = createReviewSearchFixture(api), c = chat(f);
  try {
    const registry = new api.CapabilityRegistry(), context = {pluginId: 'research', capabilities: registry};
    for (const descriptor of [...api.researchReviewSearchCapabilities, ...api.researchOwnedReviewSearchCapabilities]) registry.declare('research', descriptor);
    api.registerResearchReviewSearchCapabilities(context, f.reviews);
    api.registerResearchOwnedReviewSearchCapabilities(context, f.reviews, c.broker);
    await assert.rejects(registry.invoke('research.reviewSearch.startOwned', f.request), /dispatch_context_required/u);
    await assert.rejects(registry.invoke('research.reviewSearch.getOwned', {projectId: f.project.id, reviewSearchId: 'fake'}), /owner_context_required/u);
    await assert.rejects(registry.invoke('research.reviewSearch.start', f.request), error => error.code === 'research_human_required');
    assert.throws(() => api.withReviewSearchOwner({...c.owner()}, () => assert.fail('forged scope')), /owner_untrusted/u);
    const reference = c.broker.issueReviewSearchDispatch({runId: c.runId, threadId: c.threadId, manifest: c.manifest, request: f.request});
    const start = await api.withReviewSearchDispatch({reference, signal: c.controller.signal},
      () => registry.invoke('research.reviewSearch.startOwned', f.request));
    const done = await awaitReviewSearchFixture(f, start.search);
    const result = await api.withReviewSearchOwner(c.owner(), () => registry.invoke('research.reviewSearch.getOwned',
      {projectId: f.project.id, reviewSearchId: done.snapshot.id}));
    assert.deepEqual(result.search, done);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:review-search-start', [{...f.request, runId: c.runId}]));
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('task link failure leaves an exact failed query without a network request, phantom chat task or resettable owner', async () => {
  const f = createReviewSearchFixture(api), c = chat(f);
  try {
    const tasks = f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get();
    f.agentDb.exec(`CREATE TRIGGER fail_owned_query_link BEFORE INSERT ON research_task_executions
      WHEN NEW.kind='review_search' BEGIN SELECT RAISE(ABORT,'synthetic_task_link_failure'); END;`);
    assert.throws(() => f.reviews.startOwned(f.request, c.grant(), c.controller.signal), /synthetic_task_link_failure/u);
    assert.equal(f.calls.length, 0);
    assert.equal(f.tasks.taskForChat(c.runId), null);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM research_tasks').pluck().get(), tasks);
    const [failed] = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 10});
    assert.equal(failed.status, 'failed'); assert.equal(failed.receipt.errorCode, 'synthetic_task_link_failure');
    assert.equal(failed.receipt.executionId, null);
    f.agentDb.exec('DROP TRIGGER fail_owned_query_link');
    assert.throws(() => f.reviews.startOwned(f.request, c.grant(), c.controller.signal), /execution_unlinked/u);
    assert.equal(f.calls.length, 0);
    const retried = f.reviews.startOwned({...f.request, requestId: 'exact-retry', retryOf: failed.snapshot.id,
      expectedRetrySnapshotHash: failed.snapshotHash}, c.grant({...f.request, requestId: 'exact-retry', retryOf: failed.snapshot.id,
      expectedRetrySnapshotHash: failed.snapshotHash}), c.controller.signal);
    assert.equal((await awaitReviewSearchFixture(f, retried.search)).status, 'complete');
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('actual parent abort cancels a held provider request and discards a late apparent successful response', async () => {
  let entered, release, signal;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    signal = options.signal; entered();
    return new Promise(resolve => {release = () => resolve(Response.json({meta: {count: 0}, results: []}));});
  }}), c = chat(f);
  try {
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal);
    await ready; c.controller.abort(new Error('parent-stopped'));
    assert.equal(signal.aborted, true); release();
    const done = await awaitReviewSearchFixture(f, started.search);
    assert.equal(done.status, 'cancelled'); assert.equal(done.coverageComplete, false);
    assert.equal(done.rawRecordCount, 0); assert.equal(f.calls.length, 1);
    assert.equal(f.reviews.getOwned({projectId: f.project.id, reviewSearchId: done.snapshot.id}, c.owner()).association.parentExecutionId, c.runId);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('owned cancel persists the actual agent request before abort and retries its exact receipt without another side effect', async () => {
  let entered, signal;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    signal = options.signal; entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), c = chat(f);
  try {
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal); await ready;
    const request = {projectId: f.project.id, reviewSearchId: started.search.snapshot.id, requestId: 'owned-cancel',
      expectedRevision: started.search.revision, note: 'Cancel the exact owned query.'};
    const stopping = f.reviews.cancelOwned(request, c.owner('research_review_cancel_query'));
    assert.equal(stopping.search.status, 'cancelling'); assert.equal(signal.aborted, true);
    assert.deepEqual(stopping.search.cancellation.actor, {kind: 'agent', id: c.runId});
    const done = await awaitReviewSearchFixture(f, started.search), changes = f.changes();
    assert.deepEqual(f.reviews.cancelOwned(request, c.owner('research_review_cancel_query')).search, done);
    assert.equal(f.changes(), changes); assert.equal(f.calls.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_review_search_cancellations').pluck().get(), 1);
    assert.equal(done.status, 'cancelled'); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('cancelling one task waits for its own query cleanup and leaves another chat task in the same project running', async () => {
  let entered;
  const ready = new Promise(resolve => {entered = resolve;});
  const signals = [];
  const f = createReviewSearchFixture(api, {queries: ['first-owned-query', 'second-owned-query'], fetch: async (_url, options) => {
    signals.push(options.signal); if (signals.length === 2) entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), first = chat(f), second = chat(f, 'second-parent');
  try {
    const request = {...f.request, requestId: 'second-query', queryIndex: 1};
    const a = f.reviews.startOwned(f.request, first.grant(), first.controller.signal);
    const b = f.reviews.startOwned(request, second.grant(request), second.controller.signal);
    await ready;
    const cancelled = [];
    const controller = new api.ResearchTaskController(f.tasks, {
      stages: {cancelTask: async () => {}, pauseTask: async () => {}, continueTask: () => assert.fail(), restoreTaskApproval: () => assert.fail()},
      cancelChat: async runId => {cancelled.push(runId); if (runId === first.runId) first.controller.abort();},
      cancelJob: async (kind, projectId, id) => {
        assert.equal(kind, 'review_search'); await f.reviews.cancelTaskQuery(projectId, id);
      }
    });
    const result = await controller.cancel({projectId: f.project.id, taskId: a.association.taskId});
    assert.equal(result.status, 'cancelled'); assert.deepEqual(cancelled, [first.runId]);
    assert.equal(f.reviews.get({projectId: f.project.id, reviewSearchId: a.search.snapshot.id}).status, 'cancelled');
    assert.equal(f.reviews.get({projectId: f.project.id, reviewSearchId: b.search.snapshot.id}).status, 'running');
    assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.equal(f.tasks.get(b.association.taskId, f.project.id).status, 'active');
    second.controller.abort(); await awaitReviewSearchFixture(f, b.search);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('task budget refusal prevents the first provider request and task mutation between pages stops further dispatch', async () => {
  const f = createReviewSearchFixture(api), c = chat(f);
  try {
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal);
    f.agentDb.prepare("UPDATE research_task_budgets SET stop_reason='run_cost_budget_exhausted' WHERE task_id=?").run(started.association.taskId);
    const done = await awaitReviewSearchFixture(f, started.search);
    assert.equal(done.status, 'failed'); assert.equal(done.receipt.errorCode, 'run_cost_budget_exhausted');
    assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const changed = createReviewSearchFixture(api, {fetch: async () => {
    entered(); return new Promise(resolve => {release = () => resolve(Response.json({
      meta: {count: 4, per_page: 2, page: 1}, results: [{id: 'https://openalex.org/W1', title: 'First page'}]
    }));});
  }}), owner = chat(changed);
  try {
    const start = changed.reviews.startOwned(changed.request, owner.grant(), owner.controller.signal);
    await ready; changed.tasks.setStatus(start.association.taskId, changed.project.id, 'paused', 'research_task_paused', ['active']); release();
    const done = await awaitReviewSearchFixture(changed, start.search);
    assert.equal(done.status, 'failed'); assert.equal(done.receipt.errorCode, 'research_task_not_active');
    assert.equal(changed.calls.length, 1); assert.equal(changed.errors.length, 0);
  } finally {await changed.dispose();}
});

test('damaged or missing ownership cannot turn an agent query into a manual read, foreign task or successful cleanup', async () => {
  const f = createReviewSearchFixture(api), c = chat(f);
  try {
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal);
    await awaitReviewSearchFixture(f, started.search);
    const id = started.search.snapshot.id, request = {projectId: f.project.id, reviewSearchId: id};
    const row = f.db.prepare('SELECT * FROM research_review_search_owners WHERE review_search_id=?').get(id);
    f.db.prepare('DELETE FROM research_review_search_owners WHERE review_search_id=?').run(id);
    assert.throws(() => f.reviews.get(request), /owner_invalid/u);
    assert.throws(() => f.reviews.getOwned(request, c.owner()), /owner_invalid/u);
    await assert.rejects(f.reviews.cancelTaskQuery(f.project.id, id), /owner_invalid/u);
    f.db.prepare('INSERT INTO research_review_search_owners VALUES (?,?,?)').run(id, row.snapshot_json, row.snapshot_hash);
    const owner = JSON.parse(row.snapshot_json); owner.runId = 'different-owner';
    f.db.prepare('UPDATE research_review_search_owners SET snapshot_json=?,snapshot_hash=? WHERE review_search_id=?')
      .run(JSON.stringify(owner), hash(owner), id);
    assert.throws(() => f.reviews.get(request), /owner_invalid/u);
    f.db.prepare('UPDATE research_review_search_owners SET snapshot_json=?,snapshot_hash=? WHERE review_search_id=?')
      .run(row.snapshot_json, row.snapshot_hash, id);
    assert.equal(f.reviews.get(request).status, 'complete'); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('disk restart preserves exact owner and task while interrupting a held query without repeating network execution', async () => {
  let entered;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    entered(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), c = chat(f), directory = await mkdtemp(join(tmpdir(), 'roc-owned-review-restart-'));
  let db, agentDb, restarted;
  try {
    const start = f.reviews.startOwned(f.request, c.grant(), c.controller.signal); await ready;
    await f.db.backup(join(directory, 'research.db')); await f.agentDb.backup(join(directory, 'agent.db'));
    await f.reviews.shutdown();
    db = new Database(join(directory, 'research.db')); agentDb = new Database(join(directory, 'agent.db'));
    db.pragma('foreign_keys = ON'); agentDb.pragma('foreign_keys = ON');
    const tasks = new api.ResearchTaskRepository(agentDb);
    const repository = new api.ResearchRepository(db, tasks);
    let calls = 0;
    restarted = new api.ResearchReviewSearchService(db, repository, {search: async () => {calls++; assert.fail('no restart request');}},
      error => assert.fail(error), () => {});
    restarted.recover();
    const read = restarted.get({projectId: f.project.id, reviewSearchId: start.search.snapshot.id});
    assert.equal(read.status, 'interrupted'); assert.equal(read.receipt.errorCode, 'research_review_search_interrupted');
    assert.deepEqual(read.snapshot, start.search.snapshot);
    assert.deepEqual(tasks.requireExecution('review_search', read.snapshot.id, f.project.id), start.association);
    const broker = new api.ExecutionGrantBroker(agentDb);
    const scope = broker.authorizeReviewSearchOwner({runId: c.runId, threadId: c.threadId, projectId: f.project.id,
      manifest: c.manifest, toolName: 'research_review_get_query'});
    assert.deepEqual(restarted.getOwned({projectId: f.project.id, reviewSearchId: read.snapshot.id}, scope).search, read);
    assert.equal(calls, 0); assert.equal(f.errors.length, 0);
  } finally {await restarted?.shutdown(); db?.close(); agentDb?.close(); await f.dispose(); await rm(directory, {recursive: true, force: true});}
});

test('continuous task deadline cancels a held query even while its chat remains active', async () => {
  let entered, signal;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    signal = options.signal; entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), c = chat(f, 'deadline-parent', {deadlineAt: new Date(Date.now() + 2000).toISOString()});
  try {
    const started = f.reviews.startOwned(f.request, c.grant(), c.controller.signal); await ready;
    const done = await awaitReviewSearchFixture(f, started.search);
    assert.equal(done.status, 'cancelled'); assert.equal(done.receipt.errorCode, 'run_deadline_exhausted');
    assert.equal(signal.aborted, true); assert.equal(c.controller.signal.aborted, false);
    assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('Agent DB17 retains historical event identities, cursor sequence and triggers while permitting review queries', () => {
  const f = createReviewSearchFixture(api), db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations.filter(migration => migration.version <= 16)});
    const task = f.tasks.get(f.run.taskId, f.project.id);
    db.prepare('INSERT INTO research_tasks(id,project_id,snapshot_json,created_at,status) VALUES (?,?,?,?,?)')
      .run(task.id, task.projectId, JSON.stringify(task), task.createdAt, task.status);
    db.prepare(`INSERT INTO research_task_events(task_id,event_type,execution_kind,execution_id,call_id,state,reason,created_at)
      VALUES (?,'call_unknown','stage','historical-stage','historical-call','unknown','retained audit',?)`).run(task.id, task.createdAt);
    const before = db.prepare('SELECT * FROM research_task_events ORDER BY sequence').all();
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyDatabaseMigrations(db, {dbName: 'agent', migrations: api.agentMigrations});
    assert.deepEqual(db.prepare('SELECT * FROM research_task_events ORDER BY sequence').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version').all(), ledger);
    db.prepare(`INSERT INTO research_task_executions(kind,execution_id,task_id,project_id,snapshot_json,created_at)
      VALUES ('review_search','new-query',?,?,?,?)`).run(task.id, task.projectId, '{}', task.createdAt);
    const after = db.prepare('SELECT * FROM research_task_events ORDER BY sequence').all();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.at(-1).execution_kind, 'review_search'); assert.equal(after.at(-1).execution_id, 'new-query');
    assert.equal(after.at(-1).sequence, before.at(-1).sequence + 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {db.close(); f.close();}
});

test('Research DB41 preserves exact historical manual query hashes and never invents an agent owner or task', async () => {
  const historical = createReviewMigrationSeedApi(api, 40), f = createReviewSearchFixture(historical);
  try {
    const manual = await awaitReviewSearchFixture(f, f.reviews.start(f.request, {kind: 'user', id: 'actual-manual-reviewer'}));
    historical.finishSeed(f.db);
    const before = f.db.prepare('SELECT * FROM research_review_searches').all();
    const ledger = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const executions = f.agentDb.prepare('SELECT * FROM research_task_executions').all();
    api.applyResearchDatabaseSchema(f.db);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_review_searches').all(), before.map(row => ({...row, owner_hash: null})));
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=40 ORDER BY version').all(), ledger);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_search_owners').pluck().get(), 0);
    assert.deepEqual(f.agentDb.prepare('SELECT * FROM research_task_executions').all(), executions);
    assert.deepEqual(f.reviews.get({projectId: f.project.id, reviewSearchId: manual.snapshot.id}), manual);
    assert.equal(f.calls.length, 2); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('exact partial query retries and later stages share the chat task without resetting its frozen budget', async () => {
  const f = createReviewSearchFixture(api, {maxPages: 1}), c = chat(f);
  try {
    const initial = f.reviews.startOwned(f.request, c.grant(), c.controller.signal);
    const partial = await awaitReviewSearchFixture(f, initial.search);
    assert.equal(partial.status, 'partial');
    const budget = f.agentDb.prepare('SELECT limits_json FROM research_task_budgets WHERE task_id=?').pluck().get(initial.association.taskId);
    const request = {...f.request, requestId: 'repeat-partial', retryOf: partial.snapshot.id, expectedRetrySnapshotHash: partial.snapshotHash};
    const repeated = f.reviews.startOwned(request, c.grant(request), c.controller.signal);
    assert.equal(repeated.association.taskId, initial.association.taskId);
    assert.equal((await awaitReviewSearchFixture(f, repeated.search)).status, 'partial');
    const stageRequest = {projectId: f.project.id, expectedStage: 'reading', instruction: 'Use frozen query results', requestId: 'later-stage'};
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture');
    const stage = f.repository.runs.begin(stageRequest);
    const dispatch = c.broker.consumeResearchDispatch(c.broker.issueResearchDispatch({
      runId: c.runId, threadId: c.threadId, manifest: c.manifest, request: stageRequest
    }), stageRequest);
    const linked = f.tasks.linkStage(stage, dispatch);
    assert.equal(linked.taskId, initial.association.taskId); assert.equal(stage.parentRunId, null);
    assert.equal(linked.parentKind, 'chat'); assert.equal(linked.parentExecutionId, c.runId);
    assert.equal(f.agentDb.prepare('SELECT limits_json FROM research_task_budgets WHERE task_id=?').pluck().get(initial.association.taskId), budget);
    assert.deepEqual(f.reviews.get({projectId: f.project.id, reviewSearchId: partial.snapshot.id}), partial);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});
