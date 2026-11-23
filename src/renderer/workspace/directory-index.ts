import type {FileTreeResult} from '../../shared/types';
import type {IpcLikeResult} from '../app/loaded-state';
import type {RocClient} from '../shared/roc-client';
import {parentRelative} from './paths';
import {WATCH_REFRESH_WINDOW_MS} from './watch-refresh';
import {listTree} from './workspace-store';

/** A changed directory also invalidates cached descendants after a rename or removal. */
export function planChangedDirectories(changedPath: string | null, cached: Iterable<string>): string[] {
  const targets = new Set(['']);
  for (const directory of cached) {
    if (changedPath === null || directory === changedPath || directory === parentRelative(changedPath) ||
      changedPath.startsWith(`${directory}/`) || directory.startsWith(`${changedPath}/`)) targets.add(directory);
  }
  return [...targets];
}

type Listing = Promise<IpcLikeResult<FileTreeResult>>;
type Listener = (directories: ReadonlySet<string>) => void;

/** Shared only while a workspace consumer is mounted; no file contents are cached. */
export class WorkspaceDirectoryIndex {
  private readonly listings = new Map<string, Listing>();
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string | null>();

  constructor(private readonly client: RocClient, readonly workspacePath: string) {}

  read(relativePath: string): Listing {
    const cached = this.listings.get(relativePath);
    if (cached !== undefined) return cached;
    const listing = listTree(this.client, relativePath).then(result => {
      if (result.ok && result.data.workspacePath !== this.workspacePath) {
        return {ok: false as const, error: {message: '工作目录已变化，请重新读取目录。'}};
      }
      return result;
    });
    this.listings.set(relativePath, listing);
    return listing;
  }

  invalidate(changedPath: string | null = null): void {
    this.invalidatePaths([changedPath]);
  }

  private invalidatePaths(paths: Iterable<string | null>): void {
    const targets = new Set<string>();
    for (const path of paths) for (const target of planChangedDirectories(path, this.listings.keys())) targets.add(target);
    for (const target of targets) this.listings.delete(target);
    for (const listener of this.listeners) listener(targets);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.unsubscribe === null) {
      this.unsubscribe = this.client.api.workspace.onChanged(event => {
        if (event.workspacePath !== this.workspacePath) return;
        if (this.timer !== null) { this.pending.add(event.relativePath); return; }
        this.invalidate(event.relativePath);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pending.size === 0) return;
          const paths = this.pending;
          this.pending = new Set();
          this.invalidatePaths(paths);
        }, WATCH_REFRESH_WINDOW_MS);
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.pending.clear();
      // Changes while nobody watches must be read on the next mount. Old promises
      // cannot refill this map; only read() installs a new entry.
      this.listings.clear();
    };
  }
}

const indexes = new WeakMap<RocClient, {path: string; index: WorkspaceDirectoryIndex}>();

/** The renderer is bound to one workspace; old consumers retain their own isolated index. */
export function workspaceDirectoryIndex(client: RocClient, workspacePath: string | null): WorkspaceDirectoryIndex | null {
  if (workspacePath === null) return null;
  const current = indexes.get(client);
  if (current?.path === workspacePath) return current.index;
  const index = new WorkspaceDirectoryIndex(client, workspacePath);
  indexes.set(client, {path: workspacePath, index});
  return index;
}
