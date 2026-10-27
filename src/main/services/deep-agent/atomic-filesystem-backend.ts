import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve, isAbsolute, posix } from 'node:path';
import { FilesystemBackend, type EditResult, type WriteResult } from 'deepagents';
import type { WorkspacePathStructureChangeNotifier } from '../workspace-path-structure-event';

/** Keep upstream path/MIME handling for staging; publish complete bytes with a same-directory rename. */
export class AtomicFilesystemBackend extends FilesystemBackend {
  constructor(
    options: ConstructorParameters<typeof FilesystemBackend>[0],
    private readonly onWorkspacePathStructureChanged?: WorkspacePathStructureChangeNotifier
  ) {
    super(options);
  }

  override async write(path: string, content: string): Promise<WriteResult> {
    const temporary = posix.join(posix.dirname(path), `.roc-${randomUUID()}-${posix.basename(path)}`);
    const staged = await super.write(temporary, content);
    if (staged.error !== undefined) return staged;
    const stagedPath = this.hostPath(temporary);
    try {
      const target = this.hostPath(path);
      const parent = await realpath(dirname(target));
      const root = await realpath(this.cwd);
      const child = relative(root, parent);
      if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('atomic_write_outside_root');
      let mode: number | undefined;
      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('atomic_write_target_not_regular');
        mode = existing.mode & 0o777;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (mode !== undefined) await chmod(stagedPath, mode);
      const descriptor = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await descriptor.sync(); } finally { await descriptor.close(); }
      await rename(stagedPath, target);
      try {
        this.onWorkspacePathStructureChanged?.(this.cwd, 'agent.atomic-write-published');
      } catch {
        // A diagnostic notification cannot turn an already-published filesystem write into a failure.
      }
      const directory = await open(parent, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return { path, filesUpdate: null };
    } catch (error) {
      return { error: `atomic_write_failed:${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await unlink(stagedPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  override async edit(path: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    if (oldString.length === 0) return { error: 'edit_old_string_empty' };
    const raw = await super.readRaw(path);
    if (raw.error !== undefined || raw.data === undefined || typeof raw.data.content !== 'string') return { error: raw.error ?? 'edit_requires_text' };
    const parts = raw.data.content.split(oldString);
    const occurrences = parts.length - 1;
    if (occurrences === 0) return { error: 'edit_old_string_not_found' };
    if (occurrences > 1 && !replaceAll) return { error: 'edit_old_string_ambiguous' };
    const content = replaceAll ? parts.join(newString) : raw.data.content.replace(oldString, () => newString);
    const result = await this.write(path, content);
    return result.error === undefined ? { path, filesUpdate: null, occurrences: replaceAll ? occurrences : 1 } : result;
  }

  private hostPath(path: string): string {
    if (!this.virtualMode || path.split('/').includes('..')) throw new Error('atomic_write_requires_virtual_path');
    return resolve(this.cwd, `.${path.startsWith('/') ? path : '/' + path}`);
  }
}
