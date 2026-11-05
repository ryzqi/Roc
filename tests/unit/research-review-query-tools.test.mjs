import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewSearchFixture, awaitReviewSearchFixture} from './fixtures/research-review-search.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function connect(f, id = 'query-tool-parent', signal = new AbortController().signal, wrap = operation => operation()) {
  const runId = id, threadId = `${id}-thread`, time = new Date().toISOString();
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: f.project.id
  }).manifest;
  const snapshot = api.createRunExecutionSnapshot({runId, threadId, inputMessageId: `${id}-message`, snapshot: {
    schemaVersion: 9, submissionHash: 'a'.repeat(64),
    taskContract: {contractVersion: 1, objective: 'Execute frozen queries', constraints: [], kind: 'reply',
      criteria: [{id: 'query', description: 'Read real query receipts', check: {kind: 'response'}}]},
    runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture'}, mode: 'run', workspace: null,
    capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
    researchProjectId: f.project.id, budget: api.createRunBudget({contextBudgetTokens: null, startedAt: time})
  }});
  f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Review','Review','active',?,?,?)`).run(threadId, f.project.id, time, time);
  f.agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Review','running',?,'{}','chat',?,9)`).run(runId, threadId, time, JSON.stringify(snapshot));
  const broker = new api.ExecutionGrantBroker(f.agentDb), registry = new api.CapabilityRegistry();
  const context = {pluginId: 'research', capabilities: registry};
  for (const descriptor of [...api.researchReviewSearchCapabilities, ...api.researchOwnedReviewSearchCapabilities]) {
    registry.declare('research', descriptor);
  }
  api.registerResearchReviewSearchCapabilities(context, f.reviews);
  api.registerResearchOwnedReviewSearchCapabilities(context, f.reviews, broker);
  const tools = api.createManifestAuthorizedResearchTools({
    researchProjectId: f.project.id, runId, threadId, abortSignal: signal, capabilityManifest: manifest,
    executionGrantBroker: broker, capabilities: {invoke: (...args) => wrap(() => registry.invoke(...args))}
  });
  assert.deepEqual(tools.map(tool => tool.name).sort(),
    api.RESEARCH_TOOL_DESCRIPTORS.map(tool => tool.name).sort());
  return {runId, threadId, manifest, snapshot, broker, registry,
    start: tools.find(tool => tool.name === 'research_review_execute_query'),
    get: tools.find(tool => tool.name === 'research_review_get_query'),
    cancel: tools.find(tool => tool.name === 'research_review_cancel_query')};
}

const selection = f => {
  const {projectId, requestId, ...query} = f.request;
  return query;
};
function operation(toolName, key, receipts = []) {
  return api.createCapabilityOperationContext({
    operationId: key, idempotencyKey: key, toolCallId: `call:${key}`, toolName,
    canonicalToolIdentity: `research:${toolName}`, toolVersion: 'roc-research-tool-v1', attemptId: 'attempt-1',
    leaseGeneration: 1, recordReceipt: receipt => receipts.push(receipt)
  });
}
async function call(tool, args, key) {
  const invoke = () => tool.invoke({type: 'tool_call', id: `call:${key}`, name: tool.name, args});
  const result = tool.name === 'research_review_get_query' ? await invoke() :
    await api.runWithCapabilityOperationContext(operation(tool.name, key), invoke);
  return {message: result, data: JSON.parse(result.content)};
}

test('actual SDK query tools execute and read exact frozen receipts with trusted task identity and retained link artifacts', async () => {
  const f = createReviewSearchFixture(api), c = connect(f);
  try {
    const started = await call(c.start, selection(f), 'actual-query-operation'), result = started.data;
    assert.equal(result.search.snapshot.request.requestId, 'actual-query-operation');
    assert.equal(result.search.snapshot.request.projectId, f.project.id);
    assert.deepEqual(result.search.snapshot.actor, {kind: 'agent', id: c.runId});
    assert.equal(result.association.parentExecutionId, c.runId);
    assert.equal(result.association.kind, 'review_search');
    assert.equal(result.association.taskId, f.tasks.taskForChat(c.runId).id);
    assert.deepEqual(api.reviewLinksPayload(started.message), result.reviewLinks);
    assert.deepEqual(result.reviewLinks[0].target, {
      kind: 'query', reviewSearchId: result.search.snapshot.id, expectedSnapshotHash: result.search.snapshotHash
    });
    assert.deepEqual(result.reviewLinks[1].target, {
      kind: 'protocol', versionId: f.protocol.version.id, expectedVersionHash: f.protocol.versionHash,
      expectedFreezeHash: f.protocol.freezeHash
    });
    const terminal = await awaitReviewSearchFixture(f, result.search);
    assert.equal(terminal.status, 'complete'); assert.equal(terminal.coverageComplete, true);
    const before = f.changes(), requests = f.calls.length;
    const read = await call(c.get, {reviewSearchId: terminal.snapshot.id}, 'query-read');
    assert.deepEqual(read.data.search, terminal); assert.deepEqual(read.data.association, result.association);
    assert.deepEqual(api.reviewLinksPayload(read.message), read.data.reviewLinks);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, requests);
    const replay = await call(c.start, selection(f), 'actual-query-operation');
    assert.deepEqual(replay.data.search, terminal); assert.equal(f.calls.length, requests);
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM research_task_executions WHERE kind='review_search'").pluck().get(), 1);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('model cannot supply owner/project/request IDs, skip operation context, expand queries or drift an exact replay', async () => {
  const f = createReviewSearchFixture(api, {queries: ['first', 'second']}), c = connect(f);
  try {
    const before = f.changes();
    for (const field of ['projectId', 'requestId', 'runId', 'threadId', 'ownerRunId', 'actor', 'manifest']) {
      await assert.rejects(call(c.start, {...selection(f), [field]: 'forged'}, `spoof:${field}`));
    }
    await assert.rejects(c.start.invoke(selection(f)), /query_tool_context_required/u);
    await assert.rejects(api.runWithCapabilityOperationContext(operation('wrong-tool', 'wrong'),
      () => c.start.invoke(selection(f))), /query_tool_context_required/u);
    await assert.rejects(call(c.start, {...selection(f), retryOf: null, expectedRetrySnapshotHash: 'a'.repeat(64)}, 'bad-retry'));
    assert.equal(f.changes(), before); assert.equal(f.calls.length, 0);
    const start = await call(c.start, selection(f), 'exact-query');
    await awaitReviewSearchFixture(f, start.data.search);
    await assert.rejects(call(c.start, {...selection(f), queryIndex: 1}, 'exact-query'), /request_conflict/u);
    const requests = f.calls.length;
    await assert.rejects(call(c.start, {...selection(f), queryIndex: 2}, 'missing-query'), /research_review_query_not_declared/u);
    assert.equal(f.calls.length, requests); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('held owned query cancel uses actual operation identity, persists once and reads the true terminal state', async () => {
  let entered, providerSignal;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    providerSignal = options.signal; entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), c = connect(f);
  try {
    const start = await call(c.start, selection(f), 'held-query'); await ready;
    const request = {reviewSearchId: start.data.search.snapshot.id, expectedRevision: start.data.search.revision, note: 'Stop exact query.'};
    await assert.rejects(c.cancel.invoke(request), /query_tool_context_required/u);
    const stopping = await call(c.cancel, request, 'cancel-query-operation');
    assert.equal(stopping.data.search.status, 'cancelling'); assert.equal(providerSignal.aborted, true);
    assert.equal(stopping.data.search.cancellation.request.requestId, 'cancel-query-operation');
    assert.deepEqual(stopping.data.search.cancellation.actor, {kind: 'agent', id: c.runId});
    const done = await awaitReviewSearchFixture(f, start.data.search);
    assert.equal(done.status, 'cancelled'); assert.equal(done.coverageComplete, false);
    const before = f.changes();
    assert.deepEqual((await call(c.cancel, request, 'cancel-query-operation')).data.search, done);
    assert.deepEqual((await call(c.get, {reviewSearchId: done.snapshot.id}, 'read-cancelled')).data.search, done);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_review_search_cancellations').pluck().get(), 1);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('same-project foreign chat cannot read or cancel owned query and revoked parent cannot reuse a tool closure', async () => {
  const f = createReviewSearchFixture(api), c = connect(f), foreign = connect(f, 'other-chat');
  try {
    const start = await call(c.start, selection(f), 'owned-query');
    await awaitReviewSearchFixture(f, start.data.search);
    const request = {reviewSearchId: start.data.search.snapshot.id};
    await assert.rejects(call(foreign.get, request, 'foreign-read'), /owner_mismatch/u);
    await assert.rejects(call(foreign.cancel, {...request, expectedRevision: start.data.search.revision, note: 'stolen'}, 'foreign-cancel'), /owner_mismatch/u);
    c.broker.revokeRun(c.runId);
    await assert.rejects(call(c.get, request, 'revoked-read'), /parent_revoked/u);
    await assert.rejects(call(c.start, selection(f), 'revoked-start'), /parent_revoked/u);
    assert.equal(f.calls.length, 2); assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});

test('frozen manifest lacking query authorization never expands when current query tools are called', async () => {
  const f = createReviewSearchFixture(api), c = connect(f);
  try {
    const {manifestHash, ...body} = c.manifest;
    body.tools = body.tools.filter(tool => !['research_review_execute_query', 'research_review_get_query', 'research_review_cancel_query']
      .includes(tool.modelVisibleName));
    const manifest = {...body, manifestHash: hash(body)};
    const snapshot = {...c.snapshot, capabilityManifest: manifest};
    f.agentDb.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), c.runId);
    const filtered = api.createManifestAuthorizedResearchTools({
      researchProjectId: f.project.id, runId: c.runId, threadId: c.threadId,
      capabilityManifest: manifest, executionGrantBroker: c.broker,
      capabilities: c.registry, abortSignal: new AbortController().signal
    });
    assert.equal(filtered.some(tool => ['research_review_execute_query', 'research_review_get_query', 'research_review_cancel_query']
      .includes(tool.name)), false);
    const before = f.changes();
    await assert.rejects(api.dispatchReviewQuery({query: {action: 'start', request: f.request},
      projectId: f.project.id, runId: c.runId, threadId: c.threadId, manifest, broker: c.broker,
      capabilities: c.registry, signal: new AbortController().signal}), /research_dispatch_capability_denied/u);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, 0);
    assert.equal(f.tasks.taskForChat(c.runId), null);
  } finally {await f.dispose();}
});

test('main tool assembly without a broker refuses owned query dispatch before any capability request', async () => {
  const f = createReviewSearchFixture(api), c = connect(f);
  try {
    const tools = api.createManifestAuthorizedResearchTools({
      researchProjectId: f.project.id, runId: c.runId, threadId: c.threadId, capabilityManifest: c.manifest,
      capabilities: {invoke: async () => assert.fail('no broker means no dispatch')}, abortSignal: new AbortController().signal
    });
    const before = f.changes();
    await assert.rejects(call(tools.find(tool => tool.name === c.start.name), selection(f), 'missing-broker'), /research_dispatch_broker_required/u);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, 0); assert.equal(f.tasks.taskForChat(c.runId), null);
  } finally {await f.dispose();}
});

test('cancellation after persistence aborts in-flight query and exact retry preserves the recoverable receipt', async () => {
  let entered, providerSignal;
  const ready = new Promise(resolve => {entered = resolve;});
  const f = createReviewSearchFixture(api, {fetch: async (_url, options) => {
    providerSignal = options.signal; entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}), controller = new AbortController();
  const c = connect(f, 'cancel-after-persist', controller.signal, async operation => {
    const result = await operation(); await ready; controller.abort(new Error('lost-after-persist')); return result;
  });
  try {
    await assert.rejects(call(c.start, selection(f), 'persisted-operation'), /lost-after-persist/u);
    const [stored] = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 10});
    const terminal = await awaitReviewSearchFixture(f, stored);
    assert.equal(terminal.status, 'cancelled'); assert.equal(terminal.snapshot.request.requestId, 'persisted-operation');
    assert.equal(f.tasks.taskForChat(c.runId).id, f.tasks.requireExecution('review_search', terminal.snapshot.id, f.project.id).taskId);
    assert.equal(providerSignal.aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 0);
    const retry = await api.dispatchReviewQuery({query: {action: 'start', request: {...f.request, requestId: 'persisted-operation'}},
      projectId: f.project.id, runId: c.runId, threadId: c.threadId, manifest: c.manifest, broker: c.broker,
      capabilities: c.registry, signal: new AbortController().signal});
    assert.deepEqual(retry.search, terminal); assert.equal(f.calls.length, 1);
    const before = f.changes();
    await assert.rejects(call(c.start, selection(f), 'never-dispatched'), /lost-after-persist/u);
    assert.equal(f.changes(), before);
  } finally {await f.dispose();}
});

test('parent already cancelled before tool dispatch creates no query, task association or provider request', async () => {
  const f = createReviewSearchFixture(api), controller = new AbortController();
  controller.abort(new Error('before-dispatch'));
  const c = connect(f, 'cancel-before-dispatch', controller.signal);
  try {
    const before = f.changes();
    await assert.rejects(call(c.start, selection(f), 'never-started'), /before-dispatch/u);
    assert.equal(f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 10}).length, 0);
    assert.equal(f.tasks.taskForChat(c.runId), null); assert.equal(f.changes(), before); assert.equal(f.calls.length, 0);
  } finally {await f.dispose();}
});

test('protocol-limited partial search remains partial through query tools and explicit retry retains original identity', async () => {
  const f = createReviewSearchFixture(api, {maxPages: 1}), c = connect(f);
  try {
    const start = await call(c.start, selection(f), 'bounded-query');
    const partial = await awaitReviewSearchFixture(f, start.data.search);
    assert.equal(partial.status, 'partial'); assert.equal(partial.coverageComplete, false);
    const request = {...selection(f), retryOf: partial.snapshot.id, expectedRetrySnapshotHash: partial.snapshotHash};
    const retry = await call(c.start, request, 'explicit-retry');
    assert.equal(retry.data.association.taskId, start.data.association.taskId);
    assert.equal(retry.data.search.snapshot.request.retryOf, partial.snapshot.id);
    const done = await awaitReviewSearchFixture(f, retry.data.search);
    assert.equal(done.status, 'partial'); assert.equal(done.snapshot.parameters.maxPages, 1);
    assert.deepEqual(f.reviews.get({projectId: f.project.id, reviewSearchId: partial.snapshot.id}), partial);
    assert.equal(f.errors.length, 0);
  } finally {await f.dispose();}
});
