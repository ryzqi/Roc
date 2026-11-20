import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceWriteFileIdentity, WorkspaceWriteRecoveryProof } from '../../kernel/capability-operation-context';
import { withAtomicFilesystemPathLock } from './atomic-filesystem-backend';
import { AgentToolEffectStore, hashToolInput, type ToolEffectRecoveryRecord } from './tool-effect-store';

type WorkspaceIdentity = WorkspaceWriteRecoveryProof['workspace'];
type RecoveryItem = { toolCallId: string; toolName: string; reason: string };
export type EffectReconciliationResult = {
  resolved: Array<RecoveryItem & { outcome: 'applied' | 'not_applied' }>;
  unresolved: RecoveryItem[];
};
type FileObservation = { identity: WorkspaceWriteFileIdentity; hash: string };
const MAX_RECOVERY_FILE_BYTES = 64 * 1024 * 1024;

/** Reconcile only stopped runs. The caller owns run/thread authorization and lifecycle exclusion. */
export class EffectReconciliationService {
  constructor(private readonly store: AgentToolEffectStore) {}

  async reconcileRun(input: {
    runId: string;
    threadId: string;
    workspaceIdentity: WorkspaceIdentity | null;
  }): Promise<EffectReconciliationResult> {
    const result: EffectReconciliationResult = { resolved: [], unresolved: [] };
    for (const record of this.store.readUnresolvedOperations(input.runId, input.threadId)) {
      // Reservation precedes dispatch, so no external effect needs reconciliation.
      if (record.state.status === 'reserved') continue;
      const item = { toolCallId: record.toolCallId, toolName: record.toolName };
      const receipt = record.state.receipt;
      if (record.state.status !== 'unknown') {
        result.unresolved.push({...item, reason: '效果仍在执行或尚未完成启动对账，不能核验。'});
        continue;
      }
      if (record.toolName !== 'write_file' || record.canonicalToolIdentity !== 'builtin:write_file' || record.effectClass !== 'workspace_mutation') {
        result.unresolved.push({...item, reason: '此工具尚无可信的自动效果核验器。'});
        continue;
      }
      if (receipt?.kind !== 'workspace_write' || receipt.recovery === undefined || input.workspaceIdentity === null ||
          record.state.operationId === null || record.state.receiptHash === null) {
        result.unresolved.push({...item, reason: '缺少执行前保存的文件身份与写入证明，保留未确定状态。'});
        continue;
      }
      try {
        const proof = receipt.recovery;
        if (!sameDirectory(proof.workspace, input.workspaceIdentity)) throw new Error('workspace_changed');
        const target = resolveVirtualPath(input.workspaceIdentity.path, receipt.path);
        const staging = resolveVirtualPath(input.workspaceIdentity.path, proof.stagingPath);
        if (dirname(target) !== proof.parent.path || dirname(staging) !== proof.parent.path || target === staging ||
            !/^\.roc-[0-9a-f-]{36}-/u.test(basename(staging)) || !basename(staging).endsWith(`-${basename(target)}`)) throw new Error('path_invalid');
        const resolution = await withAtomicFilesystemPathLock(target, async () => {
          await verifyDirectories(proof);
          const current = await observeFile(target);
          const staged = await observeFile(staging);
          await verifyDirectories(proof);
          if (current !== null && sameInode(current.identity, proof.staging) && current.hash === receipt.resultHash && staged === null) {
            const replay = { kind: 'tool_message', name: 'write_file', toolCallId: record.toolCallId, status: 'success',
              content: `Verified completed write to '/workspace${receipt.path}' after interrupted execution (SHA-256 ${receipt.resultHash}).` };
            this.resolve(record, 'applied', replay);
            return {outcome: 'applied' as const, reason: '已核实原子发布的文件身份与内容，恢复时复用结果。'};
          }
          const previousUnchanged = current === null
            ? proof.previous === null && receipt.expectedVersion === null
            : proof.previous !== null && sameFile(current.identity, proof.previous) && current.hash === receipt.expectedVersion;
          if (receipt.phase === 'prepared' && staged !== null && sameFile(staged.identity, proof.staging) &&
              staged.hash === receipt.resultHash && previousUnchanged) {
            // This uniquely identified file was created by the interrupted atomic writer.
            // A crash before the receipt commit leaves the effect unknown, never eligible for a blind retry.
            await unlink(staging);
            this.resolve(record, 'not_applied', {staging: proof.staging, previous: proof.previous, resultHash: receipt.resultHash});
            return {outcome: 'not_applied' as const, reason: '暂存文件尚未发布且目标未变，允许原调用安全重试。'};
          }
          return null;
        });
        if (resolution === null) result.unresolved.push({...item, reason: '文件已变化或发布证据不足，不能判定是否执行。'});
        else result.resolved.push({...item, ...resolution});
      } catch {
        result.unresolved.push({...item, reason: '工作区、文件身份或效果代际校验失败，保留当前状态并停止恢复。'});
      }
    }
    return result;
  }

  private resolve(record: ToolEffectRecoveryRecord, outcome: 'applied' | 'not_applied', evidence: unknown): void {
    this.store.reconcilePersistedOperation({
      key: record,
      threadId: record.threadId,
      expectedOperationId: record.state.operationId!,
      expectedReceiptHash: record.state.receiptHash!,
      expectedLeaseGeneration: record.state.leaseGeneration,
      receipt: {schemaVersion: 1, kind: 'resolution', source: 'filesystem_verifier', outcome,
        operationId: record.state.operationId!, reference: `workspace-write:${record.state.receiptHash}`,
        evidenceHash: hashToolInput(evidence), recordedAt: new Date().toISOString()},
      ...(outcome === 'applied' ? {result: evidence} : {})
    });
  }
}

function resolveVirtualPath(root: string, path: string): string {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) throw new Error('path_invalid');
  const target = resolve(root, `.${path}`);
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('path_invalid');
  return target;
}

async function verifyDirectories(proof: WorkspaceWriteRecoveryProof): Promise<void> {
  for (const expected of [proof.workspace, proof.parent]) {
    const actualPath = await realpath(expected.path);
    const actual = await lstat(expected.path);
    if (actualPath !== expected.path || !actual.isDirectory() || String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) {
      throw new Error('workspace_changed');
    }
  }
}

async function observeFile(path: string): Promise<FileObservation | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_RECOVERY_FILE_BYTES) throw new Error('file_unverifiable');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const read = await file.read(bytes, 0, bytes.length, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      if (position > MAX_RECOVERY_FILE_BYTES) throw new Error('file_unverifiable');
      hash.update(bytes.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    const visible = await lstat(path);
    const identity = fileIdentity(before);
    if (!visible.isFile() || !sameFile(identity, fileIdentity(after)) || !sameFile(identity, fileIdentity(visible))) throw new Error('file_changed');
    return {identity, hash: hash.digest('hex')};
  } finally {
    await file.close();
  }
}

function fileIdentity(value: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}): WorkspaceWriteFileIdentity {
  return {dev: String(value.dev), ino: String(value.ino), size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs};
}
function sameDirectory(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}
function sameInode(left: WorkspaceWriteFileIdentity, right: WorkspaceWriteFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFile(left: WorkspaceWriteFileIdentity, right: WorkspaceWriteFileIdentity): boolean {
  return sameInode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
