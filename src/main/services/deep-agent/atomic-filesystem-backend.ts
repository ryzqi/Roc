import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { FilesystemBackend, type EditResult, type WriteResult } from 'deepagents';
import { getCapabilityOperationContext, type WorkspaceWriteFileIdentity, type WorkspaceWriteRecoveryProof } from '../../kernel/capability-operation-context';
import type { WorkspacePathStructureChangeNotifier } from '../workspace-path-structure-event';

type FileSnapshot = Readonly<{
  version: string | null;
  mode: number | undefined;
  identity: WorkspaceWriteFileIdentity | null;
}>;

const pathLockTails = new Map<string, Promise<void>>();

/** Keep upstream path/MIME handling for staging; publish complete bytes with a same-directory rename. */
export class AtomicFilesystemBackend extends FilesystemBackend {
  constructor(
    options: ConstructorParameters<typeof FilesystemBackend>[0],
    private readonly onWorkspacePathStructureChanged?: WorkspacePathStructureChangeNotifier
  ) {
    super(options);
  }

  override async write(path: string, content: string): Promise<WriteResult> {
    let target: string;
    try {
      target = this.hostPath(path);
    } catch (error) {
      return { error: formatWriteError(error) };
    }
    return withAtomicFilesystemPathLock(target, async () => {
      try {
        const expected = await this.readTargetSnapshot(target);
        return await this.publish(path, target, content, expected);
      } catch (error) {
        return { error: formatWriteError(error) };
      }
    });
  }

  override async edit(path: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    if (oldString.length === 0) return { error: 'edit_old_string_empty' };
    let target: string;
    try {
      target = this.hostPath(path);
    } catch (error) {
      return { error: formatWriteError(error) };
    }
    return withAtomicFilesystemPathLock(target, async () => {
      try {
        const expected = await this.readTargetSnapshot(target);
        const raw = await super.readRaw(path);
        if (raw.error !== undefined || raw.data === undefined || typeof raw.data.content !== 'string') {
          return { error: raw.error ?? 'edit_requires_text' };
        }
        const observed = await this.readTargetSnapshot(target);
        if (observed.version !== expected.version || hashContent(raw.data.content) !== expected.version) {
          return { error: 'atomic_write_version_conflict' };
        }
        const parts = raw.data.content.split(oldString);
        const occurrences = parts.length - 1;
        if (occurrences === 0) return { error: 'edit_old_string_not_found' };
        if (occurrences > 1 && !replaceAll) return { error: 'edit_old_string_ambiguous' };
        const content = replaceAll ? parts.join(newString) : raw.data.content.replace(oldString, () => newString);
        const result = await this.publish(path, target, content, expected);
        if (result.error !== undefined) return result;
        return { path, filesUpdate: null, occurrences: replaceAll ? occurrences : 1 };
      } catch (error) {
        return { error: formatWriteError(error) };
      }
    });
  }

  private async publish(path: string, target: string, content: string, expected: FileSnapshot): Promise<WriteResult> {
    const temporary = posix.join(posix.dirname(path), `.roc-${randomUUID()}-${posix.basename(path)}`);
    const initialParent = await this.resolveParent(target);
    const staged = await super.write(temporary, content);
    if (staged.error !== undefined) return staged;
    const stagedPath = this.hostPath(temporary);
    let result: WriteResult;
    try {
      if (expected.mode !== undefined) await chmod(stagedPath, expected.mode);
      const descriptor = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }

      const currentParent = await this.resolveParent(target);
      if (currentParent !== initialParent) throw new Error('atomic_write_parent_changed');
      const current = await this.readTargetSnapshot(target);
      if (current.version !== expected.version) throw new Error('atomic_write_version_conflict');

      const operationContext = getCapabilityOperationContext();
      const resultHash = hashContent(content);
      const recovery = operationContext?.toolName === 'write_file' && operationContext.canonicalToolIdentity === 'builtin:write_file'
        ? await this.createRecoveryProof(initialParent, temporary, stagedPath, expected) : undefined;
      operationContext?.recordReceipt({
        schemaVersion: 1,
        kind: 'workspace_write',
        phase: 'prepared',
        path,
        expectedVersion: expected.version,
        resultHash,
        ...(recovery === undefined ? {} : { recovery })
      });
      await rename(stagedPath, target);
      operationContext?.markSideEffectPublished();
      operationContext?.recordReceipt({
        schemaVersion: 1,
        kind: 'workspace_write',
        phase: 'published',
        path,
        expectedVersion: expected.version,
        resultHash,
        ...(recovery === undefined ? {} : { recovery })
      });

      try {
        this.onWorkspacePathStructureChanged?.(this.cwd, 'agent.atomic-write-published');
      } catch {
        // A diagnostic notification cannot turn an already-published filesystem write into a failure.
      }

      const directory = await open(initialParent, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      operationContext?.recordReceipt({
        schemaVersion: 1,
        kind: 'workspace_write',
        phase: 'durable',
        path,
        expectedVersion: expected.version,
        resultHash,
        ...(recovery === undefined ? {} : { recovery })
      });
      result = { path, filesUpdate: null };
    } catch (error) {
      result = { error: `atomic_write_failed:${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      await unlink(stagedPath);
    } catch (error) {
      if (!isSystemErrorWithCode(error, 'ENOENT')) {
        return { error: `atomic_write_cleanup_failed:${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return result;
  }

  protected async readTargetSnapshot(target: string): Promise<FileSnapshot> {
    let descriptor;
    try {
      descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isSystemErrorWithCode(error, 'ENOENT')) return { version: null, mode: undefined, identity: null };
      if (isSystemErrorWithCode(error, 'ELOOP')) throw new Error('atomic_write_target_not_regular');
      throw error;
    }
    try {
      const stat = await descriptor.stat();
      if (!stat.isFile()) throw new Error('atomic_write_target_not_regular');
      const content = await descriptor.readFile();
      return {
        version: hashContent(content),
        mode: stat.mode & 0o777,
        identity: fileIdentity(stat)
      };
    } finally {
      await descriptor.close();
    }
  }

  private async createRecoveryProof(parentPath: string, stagingPath: string, stagedPath: string, expected: FileSnapshot): Promise<WorkspaceWriteRecoveryProof> {
    const workspacePath = await realpath(this.cwd);
    const [workspace, parent, staged] = await Promise.all([stat(workspacePath), stat(parentPath), stat(stagedPath)]);
    if (!workspace.isDirectory() || !parent.isDirectory() || !staged.isFile()) throw new Error('atomic_write_recovery_identity_invalid');
    return {
      schemaVersion: 1,
      workspace: { path: workspacePath, dev: String(workspace.dev), ino: String(workspace.ino) },
      parent: { path: parentPath, dev: String(parent.dev), ino: String(parent.ino) },
      stagingPath,
      staging: fileIdentity(staged),
      previous: expected.identity
    };
  }

  private async resolveParent(target: string): Promise<string> {
    const parent = await realpath(dirname(target));
    const root = await realpath(this.cwd);
    const child = relative(root, parent);
    if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('atomic_write_outside_root');
    return parent;
  }

  private hostPath(path: string): string {
    if (!this.virtualMode || path.split('/').includes('..')) throw new Error('atomic_write_requires_virtual_path');
    return resolve(this.cwd, `.${path.startsWith('/') ? path : '/' + path}`);
  }
}

export async function withAtomicFilesystemPathLock<TResult>(path: string, operation: () => Promise<TResult>): Promise<TResult> {
  // Preserve backend error results for missing parents; successful writes use the canonical lock key.
  const parent = await realpath(dirname(path)).catch(() => dirname(path));
  const key = resolve(parent, basename(path));
  const previous = pathLockTails.get(key) ?? Promise.resolve();
  let releaseLock: () => void = () => undefined;
  const current = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock;
  });
  const tail = previous.then(() => current);
  pathLockTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    releaseLock();
    if (pathLockTails.get(key) === tail) pathLockTails.delete(key);
  }
}

function fileIdentity(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): WorkspaceWriteFileIdentity {
  return { dev: String(value.dev), ino: String(value.ino), size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isSystemErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function formatWriteError(error: unknown): string {
  return `atomic_write_failed:${error instanceof Error ? error.message : String(error)}`;
}
