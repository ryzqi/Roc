import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = process.cwd();
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3', 'yazl'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
let directory;
let api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-execution-grants-'));
  api = await importTypeScriptModule('tests/unit/fixtures/execution-grant-test-api.ts', bundleOptions);
});
after(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

function createFixture({ taskSource = null, runOrigin = 'chat', schemaVersion = 10 } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  api.applyDatabaseMigrations(db, { dbName: 'agent', migrations: api.agentMigrations, allowOffline: true });
  const workspacePath = join(directory, `workspace-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workspacePath);
  const createdAt = new Date().toISOString();
  const threadId = 'thread-1';
  const runId = 'run-1';
  db.prepare(`
    INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
    VALUES (?, 'chat', 'Fixture', 'Fixture', 'active', ?, ?)
  `).run(threadId, createdAt, createdAt);
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: 'chat',
    requestedCapabilities: { mcpServers: [], skills: [] },
    selfConfigAvailable: false,
    shellAllowedCommands: undefined,
    trustedHostAvailable: true,
    skills: [],
    workflowHint: null,
    researchProjectId: null
  }).manifest;
  const currentSnapshot = api.createRunExecutionSnapshot({
    runId,
    threadId,
    inputMessageId: 'message-1',
    snapshot: {
      schemaVersion: 10,
      submissionHash: 'f'.repeat(64),
      taskContract: {
        contractVersion: 1,
        objective: 'Fixture execution',
        constraints: [],
        kind: 'reply',
        criteria: [{ id: 'response', description: 'Return a fixture response', check: { kind: 'response' } }]
      },
      runOrigin,
      model: { providerId: 'openai', modelId: 'gpt-fixture' },
      mode: 'run',
      workspace: { path: workspacePath, hash: 'workspace-hash' },
      capabilityManifest: manifest,
      workflowHint: null,
      explicitSkillIds: [],
      dispatchKey: null,
      researchProjectId: null,
      budget: api.createRunBudget({ contextBudgetTokens: null })
    }
  });
  let snapshot = currentSnapshot;
  if (schemaVersion === 7 || schemaVersion === 8 || schemaVersion === 9) {
    const legacyBudget = { ...currentSnapshot.budget };
    const maxCostUsd = legacyBudget.maxCostMicrousd === null ? null : legacyBudget.maxCostMicrousd / 1_000_000;
    delete legacyBudget.policyVersion;
    delete legacyBudget.maxOutputTokens;
    delete legacyBudget.maxCallTokens;
    delete legacyBudget.maxCostMicrousd;
    delete legacyBudget.pricingCatalogVersion;
    legacyBudget.maxCostUsd = maxCostUsd;
    const legacySnapshot = { ...currentSnapshot, schemaVersion, budget: schemaVersion === 9 ? currentSnapshot.budget : legacyBudget };
    delete legacySnapshot.frozenInputs;
    delete legacySnapshot.nodeBinding;
    if (schemaVersion === 7) delete legacySnapshot.workspaceIdentity;
    snapshot = legacySnapshot;
  }
  db.prepare(`
    INSERT INTO agent_runs (
      id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json,
      workspace_path, task_source, run_origin, snapshot_json, snapshot_version
    ) VALUES (?, ?, 1, 'Fixture', 'running', ?, '{}', ?, ?, ?, ?, ?)
  `).run(runId, threadId, createdAt, workspacePath, taskSource, runOrigin, JSON.stringify(snapshot), schemaVersion);
  const broker = new api.ExecutionGrantBroker(db);
  return { db, broker, workspacePath, runId, threadId, manifest, snapshot, createdAt };
}

function binding(fixture, overrides = {}) {
  const profile = overrides.profile ?? 'isolated_read';
  const defaultToolName = {
    isolated_read: 'run_isolated_read_command',
    isolated_write: 'run_shell_command',
    trusted_host: 'run_trusted_host_command'
  }[profile];
  const toolName = overrides.toolName ?? defaultToolName;
  return {
    runId: fixture.runId,
    threadId: fixture.threadId,
    toolCallId: overrides.toolCallId ?? 'tool-call-1',
    toolName,
    profile,
    workspacePath: fixture.workspacePath,
    command: overrides.command ?? 'printf safe',
    cwd: overrides.cwd ?? fixture.workspacePath,
    manifest: fixture.manifest,
    allowedCommands: undefined
  };
}

test('v10 pins workspace and frozen inputs; all historical versions reject grants without online conversion', () => {
  const fixture = createFixture();
  const identity = fixture.snapshot.workspaceIdentity;
  const stat = statSync(realpathSync(fixture.workspacePath));
  assert.equal(fixture.snapshot.schemaVersion, 10);
  assert.equal(identity.path, realpathSync(fixture.workspacePath));
  assert.equal(identity.dev, String(stat.dev));
  assert.equal(identity.ino, String(stat.ino));

  assert.equal(fixture.snapshot.frozenInputs.manifestHash, fixture.manifest.manifestHash);
  for (const schemaVersion of [7, 8, 9]) {
    const historical = createFixture({ schemaVersion });
    const before = historical.db.prepare('SELECT snapshot_json FROM agent_runs').pluck().get();
    assert.throws(() => historical.broker.issue(binding(historical)), /execution_grant_run_snapshot_invalid/u);
    assert.equal(historical.db.prepare('SELECT snapshot_json FROM agent_runs').pluck().get(), before);
    historical.db.close();
  }
  const changed = structuredClone(fixture.snapshot);
  changed.budget.maxTotalTokens += 1;
  assert.throws(() => api.parseRunExecutionSnapshot(changed), /run_execution_snapshot_inputs_invalid/u);
  fixture.db.close();
});

test('isolated grant is bound to the exact tool call and can be consumed only once', () => {
  const fixture = createFixture();
  const request = binding(fixture);
  const grantId = fixture.broker.issue(request);
  const grant = fixture.broker.consume(grantId, request);
  assert.equal(grant.schemaVersion, 1);
  assert.equal(grant.profile, 'isolated_read');
  assert.equal(grant.networkPolicy, 'deny');
  assert.equal(grant.maxOutputBytes, 1024 * 1024);
  assert.equal(grant.toolCallId, request.toolCallId);
  assert.equal(grant.grantId, grantId);
  assert.equal(grant.approvalReference, undefined);
  const assertGrantMayExecute = () => api.assertConsumedExecutionGrant(grant, {
    command: request.command,
    cwd: request.cwd,
    profile: request.profile,
    workspacePath: request.workspacePath
  });
  assert.throws(() => api.assertConsumedExecutionGrant(grant, {
    command: 'printf wrong binding',
    cwd: request.cwd,
    profile: request.profile,
    workspacePath: request.workspacePath
  }), /execution_grant_command_mismatch/u);
  assert.doesNotThrow(assertGrantMayExecute);
  assert.throws(assertGrantMayExecute, /execution_grant_already_used/u);
  assert.throws(() => fixture.broker.consume(grantId, request), /execution_grant_not_issued/u);
  fixture.db.close();
});

test('trusted-host grant requires a matching one-use native approval receipt', () => {
  const fixture = createFixture();
  const request = binding(fixture, { profile: 'trusted_host' });
  assert.throws(() => fixture.broker.issue(request), /execution_grant_approval_required/u);
  const approvalReference = fixture.broker.recordTrustedHostApproval(request);
  assert.throws(() => fixture.broker.issue({ ...request, command: 'printf different', approvalReference }), /execution_grant_approval_binding_mismatch/u);
  const grantId = fixture.broker.issue({ ...request, approvalReference });
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').pluck().get(approvalReference), 'consumed');
  const grant = fixture.broker.consume(grantId, { ...request, approvalReference });
  assert.equal(grant.schemaVersion, 1);
  assert.equal(grant.networkPolicy, 'inherit');
  assert.equal(grant.maxOutputBytes, 64 * 1024);
  assert.equal(grant.approvalReference, approvalReference);
  fixture.db.close();
});

test('trusted-host approval is unavailable to background runs', () => {
  const fixture = createFixture({ taskSource: 'background_schedule', runOrigin: 'background_schedule' });
  const request = binding(fixture, { profile: 'trusted_host' });
  assert.throws(() => fixture.broker.recordTrustedHostApproval(request), /execution_grant_host_origin_denied/u);
  fixture.db.close();
});

test('run cancellation revokes issued grants and expiry is persisted', () => {
  const revokedFixture = createFixture();
  const revokedRequest = binding(revokedFixture, { toolCallId: 'revoked-call' });
  const revokedGrant = revokedFixture.broker.issue(revokedRequest);
  const revokedHostRequest = binding(revokedFixture, { profile: 'trusted_host', toolCallId: 'revoked-host-call' });
  const revokedApproval = revokedFixture.broker.recordTrustedHostApproval(revokedHostRequest);
  const revokedHostGrant = revokedFixture.broker.issue({ ...revokedHostRequest, approvalReference: revokedApproval });
  assert.equal(revokedFixture.broker.revokeRun(revokedFixture.runId), 2);
  assert.throws(() => revokedFixture.broker.consume(revokedGrant, revokedRequest), /execution_grant_run_revoked/u);
  assert.throws(() => revokedFixture.broker.consume(revokedHostGrant, { ...revokedHostRequest, approvalReference: revokedApproval }), /execution_grant_run_revoked/u);
  assert.equal(revokedFixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').pluck().get(revokedApproval), 'revoked');
  assert.throws(() => revokedFixture.broker.issue(binding(revokedFixture, { toolCallId: 'after-revoke' })), /execution_grant_run_revoked/u);
  revokedFixture.db.close();

  let now = new Date('2026-01-01T00:00:00.000Z');
  const fixture = createFixture();
  fixture.broker = new api.ExecutionGrantBroker(fixture.db, () => now);
  const expiredRequest = binding(fixture, { toolCallId: 'expired-call' });
  const expiredGrant = fixture.broker.issue(expiredRequest);
  now = new Date(now.getTime() + 30_001);
  assert.throws(() => fixture.broker.consume(expiredGrant, expiredRequest), /execution_grant_expired/u);
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_grants WHERE id = ?').pluck().get(expiredGrant), 'expired');
  assert.notEqual(fixture.broker.issue(expiredRequest), expiredGrant);

  const trustedRequest = binding(fixture, { profile: 'trusted_host', toolCallId: 'expired-host-call' });
  const approvalReference = fixture.broker.recordTrustedHostApproval(trustedRequest);
  const trustedGrant = fixture.broker.issue({ ...trustedRequest, approvalReference });
  now = new Date(now.getTime() + 30_001);
  assert.throws(() => fixture.broker.consume(trustedGrant, { ...trustedRequest, approvalReference }), /execution_grant_expired/u);
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').pluck().get(approvalReference), 'expired');
  const retryApproval = fixture.broker.recordTrustedHostApproval(trustedRequest);
  assert.doesNotThrow(() => fixture.broker.issue({ ...trustedRequest, approvalReference: retryApproval }));
  fixture.db.close();
});

test('workspace replacement between grant issue and consume is rejected', () => {
  const fixture = createFixture();
  const request = binding(fixture);
  const grantId = fixture.broker.issue(request);
  const movedWorkspacePath = `${fixture.workspacePath}.moved`;
  renameSync(fixture.workspacePath, movedWorkspacePath);
  mkdirSync(fixture.workspacePath);
  assert.throws(() => fixture.broker.consume(grantId, request), /execution_grant_run_workspace_mismatch/u);
  fixture.db.close();
});

test('run binding must match persisted workspace identity and capability manifest', () => {
  const fixture = createFixture();
  const request = binding(fixture);
  const otherWorkspace = join(directory, 'other-workspace');
  mkdirSync(otherWorkspace);
  const mismatchedWorkspaceRequest = { ...request, workspacePath: otherWorkspace, cwd: otherWorkspace };
  assert.throws(
    () => fixture.broker.issue(mismatchedWorkspaceRequest),
    /execution_grant_run_workspace_mismatch/u
  );

  const run = fixture.db.prepare('SELECT snapshot_json FROM agent_runs WHERE id = ?').get(fixture.runId);
  const snapshot = JSON.parse(run.snapshot_json);
  const otherManifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: 'plan',
    requestedCapabilities: { mcpServers: [], skills: [] },
    selfConfigAvailable: false,
    shellAllowedCommands: undefined,
    trustedHostAvailable: false,
    skills: [],
    workflowHint: null,
    researchProjectId: null
  }).manifest;
  snapshot.capabilityManifest = otherManifest;
  fixture.db.prepare('UPDATE agent_runs SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), fixture.runId);
  assert.throws(() => fixture.broker.issue(request), /execution_grant_run_snapshot_invalid/u);
  fixture.db.close();
});


test('terminal runs cannot issue new execution grants', () => {
  const fixture = createFixture();
  fixture.db.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(fixture.runId);
  assert.throws(() => fixture.broker.issue(binding(fixture)), /execution_grant_run_not_active/u);
  fixture.db.close();
});


test('startup reconciliation revokes stale grants and approvals while allowing new work for active runs', () => {
  const fixture = createFixture();
  const oldRequest = binding(fixture, { toolCallId: 'old-process-call' });
  const oldGrantId = fixture.broker.issue(oldRequest);
  const oldHostRequest = binding(fixture, { profile: 'trusted_host', toolCallId: 'old-host-process-call' });
  const oldHostApproval = fixture.broker.recordTrustedHostApproval(oldHostRequest);
  const oldHostGrant = fixture.broker.issue({ ...oldHostRequest, approvalReference: oldHostApproval });
  const pendingApprovalRequest = binding(fixture, { profile: 'trusted_host', toolCallId: 'pending-approval-call' });
  const pendingApproval = fixture.broker.recordTrustedHostApproval(pendingApprovalRequest);

  const restartedBroker = api.openExecutionGrantBroker(fixture.db);
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_grants WHERE id = ?').get(oldGrantId).status, 'revoked');
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_grants WHERE id = ?').get(oldHostGrant).status, 'revoked');
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').get(oldHostApproval).status, 'revoked');
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').get(pendingApproval).status, 'revoked');
  assert.equal(restartedBroker.reconcileStartupState(), 0);
  assert.doesNotThrow(() => restartedBroker.issue(oldRequest));
  const retryApproval = restartedBroker.recordTrustedHostApproval(oldHostRequest);
  assert.doesNotThrow(() => restartedBroker.issue({ ...oldHostRequest, approvalReference: retryApproval }));
  fixture.db.close();
});

test('startup reconciliation fences terminal runs and preserves consumed grants and receipts', () => {
  const fixture = createFixture();
  const request = binding(fixture, { profile: 'trusted_host' });
  const approvalReference = fixture.broker.recordTrustedHostApproval(request);
  const authorizedBinding = { ...request, approvalReference };
  const grantId = fixture.broker.issue(authorizedBinding);
  fixture.broker.consume(grantId, authorizedBinding);
  fixture.db.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(fixture.runId);

  const restartedBroker = api.openExecutionGrantBroker(fixture.db);
  assert.equal(restartedBroker.reconcileStartupState(), 0);
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_grants WHERE id = ?').get(grantId).status, 'consumed');
  assert.equal(fixture.db.prepare('SELECT status FROM agent_execution_approvals WHERE approval_reference = ?').get(approvalReference).status, 'consumed');
  assert.ok(fixture.db.prepare('SELECT 1 FROM agent_execution_run_fences WHERE run_id = ?').get(fixture.runId));
  assert.throws(() => restartedBroker.consume(grantId, authorizedBinding), /execution_grant_run_not_active/u);
  fixture.db.close();
});


test('granted agent execution records one audit event linked to grant, tool call and approval receipt', () => {
  const fixture = createFixture();
  const request = binding(fixture, { profile: 'trusted_host' });
  const approvalReference = fixture.broker.recordTrustedHostApproval(request);
  const authorizedBinding = { ...request, approvalReference };
  const grantId = fixture.broker.issue(authorizedBinding);
  const grant = fixture.broker.consume(grantId, authorizedBinding);
  const events = [];
  const shellService = new api.ShellExecutionService({}, {}, { recordEvent: event => events.push(event) });
  shellService.recordGrantedAgentExecution(grant, {
    command: request.command,
    normalizedCommand: request.command,
    cwd: request.cwd,
    stdout: 'safe',
    stderr: '',
    exitCode: 0,
    durationMs: 12,
    usedRtk: false
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent_execute');
  assert.equal(events[0].runId, fixture.runId);
  assert.equal(events[0].threadId, fixture.threadId);
  assert.equal(events[0].payload.grantId, grantId);
  assert.equal(events[0].payload.grantSchemaVersion, 1);
  assert.equal(events[0].payload.toolCallId, request.toolCallId);
  assert.equal(events[0].payload.profile, 'trusted_host');
  assert.equal(events[0].payload.approvalReference, approvalReference);
  fixture.db.close();
});

test('failed trusted-host command still records one linked audit event', async () => {
  const fixture = createFixture();
  const request = binding(fixture, { profile: 'trusted_host' });
  const approvalReference = fixture.broker.recordTrustedHostApproval(request);
  const authorizedBinding = { ...request, approvalReference };
  const grantId = fixture.broker.issue(authorizedBinding);
  const grant = fixture.broker.consume(grantId, authorizedBinding);
  const events = [];
  const shellService = new api.ShellExecutionService({}, {}, { recordEvent: event => events.push(event) });
  shellService.executeSystemShellAsync = async () => { throw new Error('shell_execution_deadline_exceeded'); };
  await assert.rejects(shellService.executeGrantedAgentAsync({ command: request.command, grant }), /shell_execution_deadline_exceeded/u);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.grantId, grantId);
  assert.equal(events[0].payload.grantSchemaVersion, 1);
  assert.equal(events[0].payload.toolCallId, request.toolCallId);
  assert.equal(events[0].payload.approvalReference, approvalReference);
  assert.equal(events[0].payload.executionError, 'shell_execution_deadline_exceeded');
  fixture.db.close();
});

test('approval-bound grants use the main-manual tool scope from the frozen manifest', () => {
  const fixture = createFixture();
  const trusted = fixture.manifest.tools.find((tool) => tool.modelVisibleName === 'run_trusted_host_command');
  assert.ok(trusted);
  assert.deepEqual(trusted.executionScopes, ['main']);
  assert.deepEqual(trusted.approvalPolicy, { kind: 'native_dialog' });
  fixture.db.close();
});

// Each transition happens after consume and before the real shell dispatch.
for (const scenario of [
  { name: 'run revocation', mutate: f => f.broker.revokeRun(f.runId), error: /execution_grant_run_revoked/ },
  { name: 'terminal run', mutate: f => f.db.prepare("UPDATE agent_runs SET status = 'cancelled'").run(), error: /execution_grant_run_not_active/ },
  { name: 'grant expiry', mutate: f => f.advance(), error: /execution_grant_expired/ },
  { name: 'frozen input mutation', mutate: f => {
    const snapshot = JSON.parse(f.db.prepare('SELECT snapshot_json FROM agent_runs').pluck().get());
    snapshot.budget.maxTotalTokens += 1;
    f.db.prepare('UPDATE agent_runs SET snapshot_json = ?').run(JSON.stringify(snapshot));
  }, error: /execution_grant_run_snapshot_invalid/ },
  { name: 'approval revocation', mutate: f => f.db.prepare("UPDATE agent_execution_approvals SET status = 'revoked'").run(), error: /execution_grant_approval_not_current/ },
  { name: 'grant revocation', mutate: f => f.db.prepare("UPDATE agent_execution_grants SET status = 'revoked'").run(), error: /execution_grant_not_current/ }
]) {
  test(`consumed grant rechecks ${scenario.name} before a real host write`, async () => {
    const fixture = createFixture();
    try {
      let now = new Date();
      fixture.advance = () => { now = new Date(now.getTime() + 30_001); };
      fixture.broker = new api.ExecutionGrantBroker(fixture.db, () => now);
      const sentinel = join(fixture.workspacePath, 'sentinel.txt');
      writeFileSync(sentinel, 'unchanged');
      writeFileSync(join(fixture.workspacePath, 'mutate.cjs'), "require('node:fs').writeFileSync('sentinel.txt', 'unauthorized');");
      const request = binding(fixture, { profile: 'trusted_host', command: `"${process.execPath}" mutate.cjs` });
      const approvalReference = fixture.broker.recordTrustedHostApproval(request);
      const authorized = { ...request, approvalReference };
      const grant = fixture.broker.consume(fixture.broker.issue(authorized), authorized);
      scenario.mutate(fixture);
      const events = [];
      const shellService = new api.ShellExecutionService({}, { getExecutionMetadata: () => ({resourceState: 'unavailable'}) },
        {recordEvent: event => events.push(event)});
      const result = await shellService.executeGrantedAgentAsync({command: request.command, grant}).then(
        () => null, error => error);
      assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged', 'denied operation must leave real sentinel bytes intact');
      assert.match(result?.message ?? 'dispatch succeeded', scenario.error);
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.grantId, grant.grantId);
      assert.match(events[0].payload.executionError, scenario.error);
    } finally { fixture.db.close(); }
  });
}
