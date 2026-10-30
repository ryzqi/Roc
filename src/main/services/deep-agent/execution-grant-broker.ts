import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type { RunCapabilityManifestV1 } from '../../../shared/types';
import { taskSourceFromRunSnapshot } from '../../../shared/agent-task-source';
import { runExecutionSnapshotAnySchema } from '../../../shared/schemas/agent';
import { evaluateShellPolicy } from './shell-policy';

export type ExecutionGrantProfile = 'isolated_read' | 'isolated_write' | 'trusted_host';
export type ExecutionGrantBinding = {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  profile: ExecutionGrantProfile;
  workspacePath: string;
  command: string;
  cwd?: string;
  manifest: RunCapabilityManifestV1;
  allowedCommands?: readonly string[];
  approvalReference?: string;
};

export type ConsumedExecutionGrant = Readonly<{
  schemaVersion: 1;
  grantId: string;
  approvalReference?: string;
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  profile: ExecutionGrantProfile;
  workspacePath: string;
  workspaceDev: string;
  workspaceIno: string;
  cwd: string;
  commandHash: string;
  manifestHash: string;
  subject: 'roc-agent';
  networkPolicy: 'deny' | 'inherit';
  maxDurationMs: number;
  maxOutputBytes: number;
}>;

const grantProfiles = {
  isolated_read: { toolName: 'run_isolated_read_command', effectClass: 'isolated_execution', network: 'deny', maxOutputBytes: 1024 * 1024 },
  isolated_write: { toolName: 'run_shell_command', effectClass: 'isolated_execution', network: 'deny', maxOutputBytes: 1024 * 1024 },
  trusted_host: { toolName: 'run_trusted_host_command', effectClass: 'host_execution', network: 'inherit', maxOutputBytes: 64 * 1024 }
} as const;
const maxDurationMs = 120_000;
const approvalLifetimeMs = 30_000;
const grantLifetimeMs = 30_000;
const consumedGrantTokens = new WeakSet<object>();
const executedGrantTokens = new WeakSet<object>();

export class ExecutionGrantBroker {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: () => Date = () => new Date()
  ) {}

  recordTrustedHostApproval(binding: ExecutionGrantBinding): string {
    const prepared = prepareBinding(binding);
    validateManifest(binding, 'trusted_host');
    validateCommand(binding);
    const approvalReference = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + approvalLifetimeMs);
    this.db.transaction(() => {
      this.assertRunThread(binding, prepared, true);
      this.db.prepare(`
        INSERT INTO agent_execution_approvals (
          approval_reference, schema_version, run_id, thread_id, tool_call_id, tool_name,
          workspace_path, workspace_dev, workspace_ino, cwd, command_hash,
          resource_scope_hash, manifest_hash, status, created_at, expires_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)
      `).run(
        approvalReference,
        binding.runId,
        binding.threadId,
        binding.toolCallId,
        binding.toolName,
        prepared.workspace.path,
        prepared.workspace.dev,
        prepared.workspace.ino,
        prepared.cwd,
        prepared.commandHash,
        prepared.resourceScopeHash,
        binding.manifest.manifestHash,
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
    }).immediate();
    return approvalReference;
  }

  issue(binding: ExecutionGrantBinding & { approvalReference?: string }): string {
    const prepared = prepareBinding(binding);
    validateManifest(binding, binding.profile);
    validateCommand(binding);
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + grantLifetimeMs);
    const grant = grantProfiles[binding.profile];
    const approvalExpired = this.db.transaction(() => {
      this.assertRunThread(binding, prepared, binding.profile === 'trusted_host');
      if (binding.profile === 'trusted_host') {
        const approvalReference = binding.approvalReference;
        if (approvalReference === undefined) throw new Error('execution_grant_approval_required');
        const approval = this.db.prepare(`
          SELECT schema_version, status, run_id, thread_id, tool_call_id, tool_name, workspace_path,
            workspace_dev, workspace_ino, cwd, command_hash, resource_scope_hash,
            manifest_hash, expires_at
          FROM agent_execution_approvals WHERE approval_reference = ?
        `).get(approvalReference) as ApprovalRow | undefined;
        if (approval === undefined) throw new Error('execution_grant_approval_missing');
        if (approval.schema_version !== 1) throw new Error('execution_grant_approval_version_unsupported');
        if (approval.status !== 'issued') throw new Error('execution_grant_approval_not_issued');
        if (Date.parse(approval.expires_at) <= createdAt.getTime()) {
          this.db.prepare("UPDATE agent_execution_approvals SET status = 'expired' WHERE approval_reference = ? AND status = 'issued'").run(approvalReference);
          return true;
        }
        assertApprovalMatches(approval, binding, prepared);
        const consumed = this.db.prepare(`
          UPDATE agent_execution_approvals SET status = 'consumed', consumed_at = ?
          WHERE approval_reference = ? AND status = 'issued'
        `).run(createdAt.toISOString(), approvalReference);
        if (consumed.changes !== 1) throw new Error('execution_grant_approval_not_issued');
      } else if (binding.approvalReference !== undefined) {
        throw new Error('execution_grant_unexpected_approval');
      }
      this.db.prepare(`
        INSERT INTO agent_execution_grants (
          id, schema_version, run_id, thread_id, tool_call_id, tool_name, subject, profile,
          workspace_path, workspace_dev, workspace_ino, cwd, command_hash,
          resource_scope_hash, manifest_hash, network_policy, max_duration_ms,
          max_output_bytes, approval_reference, status, created_at, expires_at
        ) VALUES (?, 1, ?, ?, ?, ?, 'roc-agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)
      `).run(
        id,
        binding.runId,
        binding.threadId,
        binding.toolCallId,
        binding.toolName,
        binding.profile,
        prepared.workspace.path,
        prepared.workspace.dev,
        prepared.workspace.ino,
        prepared.cwd,
        prepared.commandHash,
        prepared.resourceScopeHash,
        binding.manifest.manifestHash,
        grant.network,
        maxDurationMs,
        grant.maxOutputBytes,
        binding.approvalReference ?? null,
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
      return false;
    }).immediate();
    if (approvalExpired) throw new Error('execution_grant_approval_expired');
    return id;
  }

  consume(grantId: string, binding: ExecutionGrantBinding): ConsumedExecutionGrant {
    const prepared = prepareBinding(binding);
    validateManifest(binding, binding.profile);
    validateCommand(binding);
    const consumedAt = this.now();
    const result = this.db.transaction(() => {
      this.assertRunThread(binding, prepared, binding.profile === 'trusted_host');
      const row = this.db.prepare(`
        SELECT schema_version, id, run_id, thread_id, tool_call_id, tool_name, subject, profile,
          workspace_path, workspace_dev, workspace_ino, cwd, command_hash,
          resource_scope_hash, manifest_hash, network_policy, max_duration_ms, max_output_bytes,
          approval_reference, status, expires_at
        FROM agent_execution_grants WHERE id = ?
      `).get(grantId) as GrantRow | undefined;
      if (row === undefined) throw new Error('execution_grant_missing');
      if (row.schema_version !== 1) throw new Error('execution_grant_version_unsupported');
      if (row.status !== 'issued') throw new Error('execution_grant_not_issued');
      if (Date.parse(row.expires_at) <= consumedAt.getTime()) {
        this.db.prepare("UPDATE agent_execution_grants SET status = 'expired' WHERE id = ? AND status = 'issued'").run(grantId);
        if (row.approval_reference !== null) {
          this.db.prepare("UPDATE agent_execution_approvals SET status = 'expired' WHERE approval_reference = ? AND status = 'consumed'").run(row.approval_reference);
        }
        return null;
      }
      assertGrantMatches(row, binding, prepared);
      const changed = this.db.prepare(`
        UPDATE agent_execution_grants SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'issued'
      `).run(consumedAt.toISOString(), grantId);
      if (changed.changes !== 1) throw new Error('execution_grant_not_issued');
      const token: ConsumedExecutionGrant = Object.freeze({
        schemaVersion: row.schema_version as 1,
        grantId: row.id,
        ...(row.approval_reference === null ? {} : { approvalReference: row.approval_reference }),
        runId: row.run_id,
        threadId: row.thread_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        profile: row.profile as ExecutionGrantProfile,
        workspacePath: row.workspace_path,
        workspaceDev: row.workspace_dev,
        workspaceIno: row.workspace_ino,
        cwd: row.cwd,
        commandHash: row.command_hash,
        manifestHash: row.manifest_hash,
        subject: row.subject as 'roc-agent',
        networkPolicy: row.network_policy as 'deny' | 'inherit',
        maxDurationMs: row.max_duration_ms,
        maxOutputBytes: row.max_output_bytes
      });
      consumedGrantTokens.add(token);
      return token;
    }).immediate();
    if (result === null) throw new Error('execution_grant_expired');
    return result;
  }

  revokeRun(runId: string): number {
    const revokedAt = this.now().toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_execution_run_fences (run_id, revoked_at) VALUES (?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `).run(runId, revokedAt);
      return this.revokePendingExecutionGrantsInTransaction(runId, revokedAt);
    }).immediate();
  }

  revokePendingRunGrants(runId: string): number {
    const revokedAt = this.now().toISOString();
    const revoke = () => this.revokePendingExecutionGrantsInTransaction(runId, revokedAt);
    return this.db.inTransaction ? revoke() : this.db.transaction(revoke).immediate();
  }

  private revokePendingExecutionGrantsInTransaction(runId: string, revokedAt: string): number {
    this.db.prepare(`
      UPDATE agent_execution_approvals SET status = 'revoked', revoked_at = ?
      WHERE run_id = ? AND (
        status = 'issued' OR (
          status = 'consumed' AND approval_reference IN (
            SELECT approval_reference FROM agent_execution_grants
            WHERE run_id = ? AND status = 'issued' AND approval_reference IS NOT NULL
          )
        )
      )
    `).run(revokedAt, runId, runId);
    return this.db.prepare(`
      UPDATE agent_execution_grants SET status = 'revoked', revoked_at = ?
      WHERE run_id = ? AND status = 'issued'
    `).run(revokedAt, runId).changes;
  }

  reconcileStartupState(): number {
    const now = this.now().toISOString();
    return this.db.transaction(() => {
      const fenced = this.db.prepare(`
        INSERT OR IGNORE INTO agent_execution_run_fences (run_id, revoked_at)
        SELECT id, ? FROM agent_runs WHERE status IN ('completed','failed','cancelled','interrupted','archived')
      `).run(now).changes;
      const grantsExpired = this.db.prepare(`
        UPDATE agent_execution_grants SET status = 'expired'
        WHERE status = 'issued' AND expires_at <= ?
      `).run(now).changes;
      const expiredGrantReceipts = this.db.prepare(`
        UPDATE agent_execution_approvals SET status = 'expired'
        WHERE status = 'consumed' AND approval_reference IN (
          SELECT approval_reference FROM agent_execution_grants WHERE status = 'expired' AND approval_reference IS NOT NULL
        )
      `).run().changes;
      const approvalsExpired = this.db.prepare(`
        UPDATE agent_execution_approvals SET status = 'expired'
        WHERE status = 'issued' AND expires_at <= ?
      `).run(now).changes;
      const grantsRevoked = this.db.prepare(`
        UPDATE agent_execution_grants SET status = 'revoked', revoked_at = ?
        WHERE status = 'issued'
      `).run(now).changes;
      const revokedGrantReceipts = this.db.prepare(`
        UPDATE agent_execution_approvals SET status = 'revoked', revoked_at = ?
        WHERE status = 'consumed' AND approval_reference IN (
          SELECT approval_reference FROM agent_execution_grants WHERE status = 'revoked' AND approval_reference IS NOT NULL
        )
      `).run(now).changes;
      const approvalsRevoked = this.db.prepare(`
        UPDATE agent_execution_approvals SET status = 'revoked', revoked_at = ?
        WHERE status = 'issued'
      `).run(now).changes;
      return fenced + grantsExpired + expiredGrantReceipts + approvalsExpired + grantsRevoked + revokedGrantReceipts + approvalsRevoked;
    }).immediate();
  }

  private assertRunThread(binding: ExecutionGrantBinding, prepared: PreparedBinding, requireManualOrigin = false): void {
    const run = this.db.prepare('SELECT thread_id, status, run_origin, task_source, workspace_path, snapshot_version, snapshot_json FROM agent_runs WHERE id = ?')
      .get(binding.runId) as {
        thread_id: string;
        status: string;
        run_origin: string | null;
        task_source: string | null;
        workspace_path: string | null;
        snapshot_version: number | null;
        snapshot_json: string | null;
      } | undefined;
    if (run === undefined || run.thread_id !== binding.threadId) throw new Error('execution_grant_run_binding_invalid');
    if (run.status !== 'running') throw new Error('execution_grant_run_not_active');
    const fence = this.db.prepare('SELECT 1 FROM agent_execution_run_fences WHERE run_id = ?').get(binding.runId);
    if (fence !== undefined) throw new Error('execution_grant_run_revoked');
    if (run.workspace_path === null || run.snapshot_json === null) throw new Error('execution_grant_run_snapshot_missing');
    let snapshot: ReturnType<typeof runExecutionSnapshotAnySchema.parse>;
    try {
      snapshot = runExecutionSnapshotAnySchema.parse(JSON.parse(run.snapshot_json) as unknown);
    } catch (error) {
      throw new Error('execution_grant_run_snapshot_invalid', { cause: error });
    }
    if ((snapshot.schemaVersion !== 8 && snapshot.schemaVersion !== 9) || run.snapshot_version !== snapshot.schemaVersion) {
      throw new Error('execution_grant_workspace_identity_missing');
    }
    const workspaceIdentity = snapshot.workspaceIdentity;
    if (workspaceIdentity === null) throw new Error('execution_grant_workspace_identity_missing');
    const { manifestHash, ...manifestContent } = snapshot.capabilityManifest;
    if (snapshot.runId !== binding.runId || snapshot.threadId !== binding.threadId || snapshot.runOrigin !== run.run_origin ||
      manifestHash !== binding.manifest.manifestHash || hash(JSON.stringify(manifestContent)) !== manifestHash) {
      throw new Error('execution_grant_run_manifest_mismatch');
    }
    if (run.task_source !== taskSourceFromRunSnapshot(snapshot)) {
      throw new Error('execution_grant_task_source_mismatch');
    }
    if (snapshot.workspace === null) throw new Error('execution_grant_run_workspace_mismatch');
    let persistedWorkspacePath: string;
    let snapshotWorkspacePath: string;
    try {
      persistedWorkspacePath = realpathSync(run.workspace_path);
      snapshotWorkspacePath = realpathSync(snapshot.workspace.path);
    } catch (error) {
      throw new Error('execution_grant_run_workspace_mismatch', { cause: error });
    }
    const persistedWorkspaceStat = statSync(persistedWorkspacePath);
    if (persistedWorkspacePath !== prepared.workspace.path || snapshotWorkspacePath !== prepared.workspace.path ||
      workspaceIdentity.path !== prepared.workspace.path || workspaceIdentity.dev !== prepared.workspace.dev ||
      workspaceIdentity.ino !== prepared.workspace.ino || String(persistedWorkspaceStat.dev) !== prepared.workspace.dev ||
      String(persistedWorkspaceStat.ino) !== prepared.workspace.ino) {
      throw new Error('execution_grant_run_workspace_mismatch');
    }
    if (requireManualOrigin && (run.task_source === 'background_schedule' || (run.run_origin !== 'chat' && run.run_origin !== 'manual_task_run'))) {
      throw new Error('execution_grant_host_origin_denied');
    }
  }
}

export function openExecutionGrantBroker(
  db: DatabaseConnection,
  now?: () => Date
): ExecutionGrantBroker {
  const broker = new ExecutionGrantBroker(db, now);
  broker.reconcileStartupState();
  return broker;
}

export function isConsumedExecutionGrant(value: unknown): value is ConsumedExecutionGrant {
  return typeof value === 'object' && value !== null && consumedGrantTokens.has(value);
}

export function assertConsumedExecutionGrant(
  grant: unknown,
  input: { command: string; cwd: string; profile: ExecutionGrantProfile; workspacePath: string }
): asserts grant is ConsumedExecutionGrant {
  if (!isConsumedExecutionGrant(grant)) throw new Error('execution_grant_not_consumed');
  if (executedGrantTokens.has(grant)) throw new Error('execution_grant_already_used');
  if (grant.schemaVersion !== 1) throw new Error('execution_grant_version_unsupported');
  if (grant.profile !== input.profile) throw new Error('execution_grant_profile_mismatch');
  if (grant.subject !== 'roc-agent' || (input.profile === 'trusted_host' ? grant.networkPolicy !== 'inherit' : grant.networkPolicy !== 'deny')) {
    throw new Error('execution_grant_policy_mismatch');
  }
  const workspacePath = realpathSync(input.workspacePath);
  const workspaceStat = statSync(workspacePath);
  if (workspacePath !== grant.workspacePath || String(workspaceStat.dev) !== grant.workspaceDev || String(workspaceStat.ino) !== grant.workspaceIno) {
    throw new Error('execution_grant_workspace_identity_changed');
  }
  const cwd = realpathSync(input.cwd);
  const relativeCwd = relative(workspacePath, cwd);
  if (cwd !== grant.cwd || relativeCwd === '..' || relativeCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeCwd)) {
    throw new Error('execution_grant_cwd_mismatch');
  }
  if (grant.commandHash !== hash(input.command)) throw new Error('execution_grant_command_mismatch');
  executedGrantTokens.add(grant);
}

type PreparedBinding = {
  workspace: { path: string; dev: string; ino: string };
  cwd: string;
  commandHash: string;
  resourceScopeHash: string;
};
type ApprovalRow = {
  schema_version: number; status: string; run_id: string; thread_id: string; tool_call_id: string; tool_name: string;
  workspace_path: string; workspace_dev: string; workspace_ino: string; cwd: string;
  command_hash: string; resource_scope_hash: string; manifest_hash: string; expires_at: string;
};
type GrantRow = {
  schema_version: number; id: string; run_id: string; thread_id: string; tool_call_id: string; tool_name: string; profile: string;
  workspace_path: string; workspace_dev: string; workspace_ino: string; cwd: string;
  command_hash: string; resource_scope_hash: string; manifest_hash: string;
  max_duration_ms: number; max_output_bytes: number; subject: string; network_policy: 'deny'|'inherit';
  approval_reference: string | null; status: string; expires_at: string;
};

function validateCommand(binding: ExecutionGrantBinding): void {
  const verdict = evaluateShellPolicy({
    command: binding.command,
    cwd: binding.cwd,
    defaultCwd: binding.workspacePath,
    allowedCommands: binding.allowedCommands
  });
  if (verdict.verdict === 'deny') throw new Error(`execution_grant_command_denied:${verdict.reason}`);
}

function prepareBinding(binding: ExecutionGrantBinding): PreparedBinding {
  if (!binding.runId.trim() || !binding.threadId.trim() || !binding.toolCallId.trim()) throw new Error('execution_grant_identity_invalid');
  if (!binding.command.trim()) throw new Error('execution_grant_command_empty');
  const workspacePath = realpathSync(binding.workspacePath);
  const workspaceStat = statSync(workspacePath);
  if (!workspaceStat.isDirectory()) throw new Error('execution_grant_workspace_not_directory');
  const cwd = realpathSync(resolve(workspacePath, binding.cwd ?? '.'));
  const relativeCwd = relative(workspacePath, cwd);
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeCwd)) {
    throw new Error('execution_grant_cwd_outside_workspace');
  }
  if (!statSync(cwd).isDirectory()) throw new Error('execution_grant_cwd_not_directory');
  return {
    workspace: { path: workspacePath, dev: String(workspaceStat.dev), ino: String(workspaceStat.ino) },
    cwd,
    commandHash: hash(binding.command),
    resourceScopeHash: hash(`${workspacePath}\0${cwd}`)
  };
}

function validateManifest(binding: ExecutionGrantBinding, profile: ExecutionGrantProfile): void {
  const { manifestHash, ...manifestContent } = binding.manifest;
  if (createHash('sha256').update(JSON.stringify(manifestContent)).digest('hex') !== manifestHash) {
    throw new Error('execution_grant_manifest_integrity_invalid');
  }
  const expected = grantProfiles[profile];
  const tool = binding.manifest.tools.find((entry) => entry.modelVisibleName === binding.toolName);
  if (binding.toolName !== expected.toolName || tool === undefined || !tool.executionScopes.includes('main') || tool.effectClass !== expected.effectClass) {
    throw new Error('execution_grant_manifest_tool_denied');
  }
  if (profile === 'trusted_host' && (tool.approvalPolicy.kind !== 'native_dialog' || tool.executionScopes.length !== 1)) {
    throw new Error('execution_grant_host_approval_missing');
  }
  if (profile !== 'trusted_host' && tool.approvalPolicy.kind !== 'none') {
    throw new Error('execution_grant_isolated_approval_invalid');
  }
}

function assertApprovalMatches(row: ApprovalRow, binding: ExecutionGrantBinding, prepared: PreparedBinding): void {
  if (row.run_id !== binding.runId || row.thread_id !== binding.threadId || row.tool_call_id !== binding.toolCallId || row.tool_name !== binding.toolName ||
    row.workspace_path !== prepared.workspace.path || row.workspace_dev !== prepared.workspace.dev || row.workspace_ino !== prepared.workspace.ino ||
    row.cwd !== prepared.cwd || row.command_hash !== prepared.commandHash || row.resource_scope_hash !== prepared.resourceScopeHash ||
    row.manifest_hash !== binding.manifest.manifestHash) throw new Error('execution_grant_approval_binding_mismatch');
}

function assertGrantMatches(row: GrantRow, binding: ExecutionGrantBinding, prepared: PreparedBinding): void {
  if (row.run_id !== binding.runId || row.thread_id !== binding.threadId || row.tool_call_id !== binding.toolCallId || row.tool_name !== binding.toolName || row.profile !== binding.profile ||
    row.subject !== 'roc-agent' || row.network_policy !== grantProfiles[binding.profile].network ||
    row.max_duration_ms !== maxDurationMs || row.max_output_bytes !== grantProfiles[binding.profile].maxOutputBytes ||
    row.workspace_path !== prepared.workspace.path || row.workspace_dev !== prepared.workspace.dev || row.workspace_ino !== prepared.workspace.ino ||
    row.cwd !== prepared.cwd || row.command_hash !== prepared.commandHash || row.resource_scope_hash !== prepared.resourceScopeHash ||
    row.manifest_hash !== binding.manifest.manifestHash || row.approval_reference !== (binding.approvalReference ?? null)) {
    throw new Error('execution_grant_binding_mismatch');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
