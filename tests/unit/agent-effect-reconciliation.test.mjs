import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import {ChatOpenAI} from '@langchain/openai';

let directory, api;
const usage = {callCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0};
before(async () => {
  directory = await mkdtemp(join(process.cwd(), '.runtime', 'agent-effect-recovery-'));
  const outfile = join(directory, 'api.mjs');
  await build({stdin: {contents: `
    export * from './tests/unit/fixtures/agent-resume-test-api';
    export { EffectReconciliationService } from './src/main/services/deep-agent/effect-reconciliation-service';
    export { AtomicFilesystemBackend } from './src/main/services/deep-agent/atomic-filesystem-backend';
    export { createCapabilityOperationContext, runWithCapabilityOperationContext } from './src/main/kernel/capability-operation-context';
  `, resolveDir: process.cwd(), sourcefile: 'agent-effect-recovery-test.ts'}, outfile, bundle: true, packages: 'external',
  platform: 'node', format: 'esm', loader: {'.md': 'text'}, logLevel: 'silent'});
  api = await import(pathToFileURL(outfile).href);
});
after(async () => { if (directory) await rm(directory, {recursive: true, force: true}); });

function open(file, executor, serviceFactory, beforeResumeModel) {
  const db = new Database(file);
  api.applyAgentDatabaseSchema(db);
  const eventBus = new api.EventBus({error() {}});
  const runEventLog = new api.AgentRunEventLog(db);
  const store = new api.AgentToolEffectStore(db);
  const repository = new api.AgentSessionRepository(db, {runEventLog, checkpointer: {hasCheckpoint: () => true, readPendingInterrupts: () => []}});
  const base = {schemaVersion: 1, requestedCapabilities: {mcpServers: [], skills: []}, resolvedCapabilities: {mcpServers: [], skills: []},
    skippedCapabilities: [], tools: [], skills: [], mcpServers: [], untrustedContextPolicy: 'external_content_reference_only'};
  const manifest = {...base, manifestHash: api.createRunCapabilityManifestHash(base)};
  const model = {providerId: 'fixture', modelId: 'fixture', langChainHandle: {
    model: new ChatOpenAI({model: 'fixture', apiKey: 'fixture', maxRetries: 0}), modelId: 'fixture',
    provider: {id: 'fixture', name: 'Fixture', type: 'openai_compatible', enabled: true, models: [],
      endpoint: 'http://fixture.invalid/v1', credentialRef: null},
    runtime: {providerType: 'openai_compatible', baseUrl: null, streaming: false, modelKwargs: {},
      contextWindowTokens: 65536, maxOutputTokens: 512}
  }};
  const runtime = new api.AgentPluginRuntime({repository, eventBus, runEventLog,
    executionGrantBroker: api.openExecutionGrantBroker(db), deepAgentExecutor: executor,
    effectReconciliationService: serviceFactory?.(store) ?? new api.EffectReconciliationService(store),
    modelFactory: {createDefaultModelHandle: async () => model, createModelHandleByProviderAndModel: async () => {
      await beforeResumeModel?.(); return model;
    }},
    capabilityPreviewProvider: async () => ({runnable: false, modelId: 'fixture', builtInTools: [], toolCards: [], skillCards: [],
      subagents: [], interruptOn: {}, manifest, reason: 'Recovery integration fixture'})});
  return {db, runtime, repository, store, eventBus, ledger: new api.RunUsageLedger(db), async close() {
    for (const {id} of db.prepare("SELECT id FROM agent_runs WHERE status IN ('running','dispatch_pending','recovering')").all()) {
      await runtime.cancelRun({runId: id});
    }
    await runtime.shutdown(); if (db.open) db.close();
  }};
}

async function crashedRun() {
  const root = await mkdtemp(join(directory, 'case-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const entered = Promise.withResolvers();
  const first = open(join(root, 'before.db'), {execute(input) {
    entered.resolve();
    const outcome = new Promise((_resolve, reject) => input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), {once: true}));
    void outcome.catch(() => {});
    return {events: (async function* () { await outcome; })(), outcome};
  }});
  first.eventBus.subscribe('agent.run.failed', event => entered.reject(new Error(JSON.stringify(event.payload))));
  try {
    const started = await first.runtime.startRun({input: 'Write and preserve the result.', mode: 'chat', taskSource: 'workbench', workspacePath: workspace,
      enabledCapabilities: {mcpServers: [], skills: []}});
    await entered.promise;
    const operation = {...started, executionPath: 'main', checkpointId: 'checkpoint', toolCallId: 'write-once', toolName: 'write_file',
      canonicalToolIdentity: 'builtin:write_file', toolVersion: 'roc-runtime-tool-v1',
      args: {file_path: '/workspace/result.txt', content: 'written once'}, effectClass: 'workspace_mutation', reconcileStrategy: 'retry_safe'};
    const {lease} = first.store.beginOperation(operation);
    first.store.markStarted(lease);
    const context = api.createCapabilityOperationContext({...lease, recordReceipt: receipt => first.store.recordReceipt(lease, receipt)});
    const backend = new api.AtomicFilesystemBackend({rootDir: workspace, virtualMode: true});
    assert.equal((await api.runWithCapabilityOperationContext(context, () => backend.write('/result.txt', 'written once'))).error, undefined);
    await first.db.backup(join(root, 'reopened.db'));
    await first.runtime.cancelRun({runId: started.runId});
    await first.close();
    return {root, workspace, started, operation, path: join(root, 'reopened.db')};
  } catch (error) {
    await first.close(); await rm(root, {recursive: true, force: true}); throw error;
  }
}

test('production runtime reconciles interrupted write, refreshes handoff and resumes the original run once', {timeout: 15000}, async () => {
  const f = await crashedRun();
  let resumed = 0;
  const reopened = open(f.path, {execute(input) {
    resumed++;
    assert.equal(input.resumeFromCheckpoint, true);
    assert.equal(reopened.store.beginOperation(f.operation).kind, 'replay');
    reopened.ledger.consumeCorrections(input.run.id, reopened.ledger.pendingCorrections(input.run.id)
      .map(item => `roc-correction:${item.submission_id}`));
    return {events: (async function* () {})(), outcome: Promise.resolve({status: 'completed', finalMessage: 'Recovered.',
      finalResponse: 'Recovered.', summarySource: {successfulToolNames: ['write_file']}, usage})};
  }});
  try {
    reopened.repository.reconcileStartupRuns();
    assert.equal(reopened.repository.getRun(f.started.runId).status, 'interrupted');
    assert.equal(reopened.repository.taskContracts.readReport(f.started.runId).checkpointResumeAvailable, false);
    await assert.rejects(reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started}), /checkpoint_resume_unavailable/);
    const before = await stat(join(f.workspace, 'result.txt'));
    const result = await reopened.runtime.reconcileRunEffects(f.started);
    assert.equal(result.canResume, true);
    assert.equal(result.resolved[0].outcome, 'applied');
    assert.equal(reopened.repository.taskContracts.readHandoff(f.started.runId).pendingEffects.length, 0);
    const completed = Promise.withResolvers();
    reopened.eventBus.subscribe('agent.run.completed', event => completed.resolve(event.payload));
    reopened.eventBus.subscribe('agent.run.failed', event => completed.reject(new Error(JSON.stringify(event.payload))));
    await reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started});
    await completed.promise;
    assert.equal(resumed, 1);
    assert.equal(reopened.db.prepare('SELECT count(*) FROM agent_runs').pluck().get(), 1);
    assert.equal((await stat(join(f.workspace, 'result.txt'))).ino, before.ino);
    assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'written once');
    await assert.rejects(reopened.runtime.reconcileRunEffects(f.started), /run_not_interrupted/);
  } finally { await reopened.close(); await rm(f.root, {recursive: true, force: true}); }
});

test('production reconciliation rejects wrong thread and terminal runs; pending reconciliation excludes resume', {timeout: 15000}, async () => {
  const f = await crashedRun();
  const entered = Promise.withResolvers();
  const continueVerification = Promise.withResolvers();
  let verified = 0;
  const reopened = open(f.path, {execute() { throw new Error('must_not_execute'); }}, store => ({async reconcileRun(input) {
    verified++; entered.resolve(); await continueVerification.promise;
    return new api.EffectReconciliationService(store).reconcileRun(input);
  }}));
  try {
    reopened.repository.reconcileStartupRuns();
    await assert.rejects(reopened.runtime.reconcileRunEffects({...f.started, threadId: 'wrong'}), /thread_mismatch/);
    for (const status of ['failed', 'cancelled']) {
      reopened.db.prepare('UPDATE agent_runs SET status=? WHERE id=?').run(status, f.started.runId);
      await assert.rejects(reopened.runtime.reconcileRunEffects(f.started), /run_not_interrupted/);
    }
    assert.equal(verified, 0);
    reopened.db.prepare("UPDATE agent_runs SET status='interrupted' WHERE id=?").run(f.started.runId);
    const pending = reopened.runtime.reconcileRunEffects(f.started);
    await entered.promise;
    await assert.rejects(reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started}), /reconciliation_in_progress/);
    await assert.rejects(reopened.runtime.reconcileRunEffects(f.started), /reconciliation_in_progress/);
    continueVerification.resolve();
    assert.equal((await pending).canResume, true);
    assert.equal(verified, 1);
  } finally { continueVerification.resolve(); await reopened.close(); await rm(f.root, {recursive: true, force: true}); }
});

test('resume preparation excludes reconciliation and another resume before model creation finishes', {timeout: 15000}, async () => {
  const f = await crashedRun();
  const entered = Promise.withResolvers();
  const continueResume = Promise.withResolvers();
  let executions = 0;
  const reopened = open(f.path, {execute(input) {
    executions++;
    reopened.ledger.consumeCorrections(input.run.id, reopened.ledger.pendingCorrections(input.run.id)
      .map(item => `roc-correction:${item.submission_id}`));
    return {events: (async function* () {})(), outcome: Promise.resolve({status: 'completed', finalMessage: 'Recovered.',
      finalResponse: 'Recovered.', summarySource: {successfulToolNames: ['write_file']}, usage})};
  }}, undefined, async () => { entered.resolve(); await continueResume.promise; });
  let pending;
  try {
    reopened.repository.reconcileStartupRuns();
    const reserved = {...f.operation, toolCallId: 'reserved-only'};
    reopened.store.beginOperation(reserved);
    const result = await reopened.runtime.reconcileRunEffects(f.started);
    assert.equal(result.canResume, true);
    assert.deepEqual(result.unresolved, []);
    assert.equal(reopened.store.readState(reserved).status, 'reserved');
    const completed = Promise.withResolvers();
    reopened.eventBus.subscribe('agent.run.completed', event => completed.resolve(event.payload));
    reopened.eventBus.subscribe('agent.run.failed', event => completed.reject(new Error(JSON.stringify(event.payload))));
    pending = reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started});
    await entered.promise;
    await assert.rejects(reopened.runtime.reconcileRunEffects(f.started), /chat_resume_in_progress/);
    await assert.rejects(reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started}), /chat_resume_in_progress/);
    assert.equal(executions, 0);
    continueResume.resolve();
    await pending;
    await completed.promise;
    assert.equal(executions, 1);
    await assert.rejects(reopened.runtime.resumeRun({kind: 'checkpoint', ...f.started}), /run_not_interrupted/);
  } finally {
    continueResume.resolve();
    await pending?.catch(() => {});
    await reopened.close(); await rm(f.root, {recursive: true, force: true});
  }
});
