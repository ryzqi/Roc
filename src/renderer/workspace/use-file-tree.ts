import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../../shared/types';
import { readFileTreeExpanded, writeFileTreeExpanded } from '../app/ui-state';
import type { RocClient } from '../shared/roc-client';
import { compareTreeEntries, joinRelative, parentRelative } from './paths';
import { WATCH_REFRESH_WINDOW_MS } from './watch-refresh';
import { listTree } from './workspace-store';
/**
 * File tree state for the sidebar (P3/T3.2).
 *
 * `files.listTree` lists **one directory level** at a time, so this is a lazy
 * tree: expanding a directory fetches its children once and caches them. The
 * legacy shell loaded a whole synthetic tree, which the backend does not offer.
 *
 * Design points that matter:
 *   - **Expansion is persisted per project** (`ui-state`), not per workspace, so
 *     reopening a project restores the shape the user left.
 *   - **Directory keys are workspace-relative**, so the same project opened after
 *     the workspace moved still matches.
 *   - The visible row list is computed by flattening expanded directories, which
 *     is what the view windows over — one source of truth for row order.
 *   - `workspacePathKey` changing (workspace switch) discards every cached child
 *     and reloads the root, so nothing leaks across workspaces.
 */

export type FileTreeRow = {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  positionInSet: number;
  /** -1 means the directory listing was truncated and the full sibling count is unknown. */
  setSize: number;
};

/* ------------------------------------------------------------------ */
/* Pure navigation helpers (T3.2 keyboard model)                       */
/* ------------------------------------------------------------------ */

/**
 * Every ancestor directory of a path, outermost first (`a/b/c.ts` → `['a', 'a/b']`).
 */
export function ancestorDirectoriesOf(relativePath: string): string[] {
  const segments = relativePath.split('/');
  segments.pop();
  const directories: string[] = [];
  let current = '';
  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }
    current = current.length === 0 ? segment : `${current}/${segment}`;
    directories.push(current);
  }
  return directories;
}

/** Keeps an index inside the row list (a collapse can shorten it under focus). */
export function clampRowIndex(rowCount: number, index: number): number {
  if (rowCount <= 0) {
    return -1;
  }
  return Math.min(Math.max(index, 0), rowCount - 1);
}

/** The row for the containing directory, or null at the top level. */
export function findParentRowIndex(rows: readonly FileTreeRow[], index: number): number | null {
  const row = rows[index];
  if (row === undefined) {
    return null;
  }
  const parent = parentRelative(row.entry.relativePath);
  if (parent.length === 0) {
    return null;
  }
  const found = rows.findIndex((candidate) => candidate.entry.relativePath === parent);
  return found < 0 ? null : found;
}

/**
 * Type-ahead: the next row at or after `fromIndex` whose name starts with
 * `prefix`, wrapping around. Returns null when nothing matches.
 */
export function findTypeAheadRowIndex(
  rows: readonly FileTreeRow[],
  fromIndex: number,
  prefix: string
): number | null {
  const needle = prefix.toLocaleLowerCase();
  if (needle.length === 0 || rows.length === 0) {
    return null;
  }
  for (let offset = 0; offset < rows.length; offset += 1) {
    const index = (Math.max(fromIndex, 0) + offset) % rows.length;
    if (rows[index]!.entry.name.toLocaleLowerCase().startsWith(needle)) {
      return index;
    }
  }
  return null;
}

export type FileTreeState = {
  rows: FileTreeRow[];
  /** Directories currently fetching, so their row can show progress. */
  loading: ReadonlySet<string>;
  /** Per-directory load errors, keyed by relative path (`''` = root). */
  errors: ReadonlyMap<string, string>;
  loadingRoot: boolean;
  rootError: string | null;
  truncatedRoot: boolean;
  expanded: ReadonlySet<string>;
  toggleDirectory: (relativePath: string) => void;
  /** Expands directories without toggling (revealing a path must not collapse it). */
  expandDirectories: (relativePaths: readonly string[]) => void;
  collapseAll: () => void;
  reload: () => void;
};

/**
 * Which already-listed directories a watcher event makes stale.
 *
 * `workspace.onChanged` reports the deepest path that changed (`null` for a
 * wholesale change). Only directories we have actually listed need a refetch, and
 * the root always does. Pure so the mapping from "external edit" to "what to
 * reload" is testable without a DOM or an IPC bridge.
 */
export function planChangedDirectories(
  changedRelativePath: string | null,
  cachedDirectories: Iterable<string>
): string[] {
  const targets = new Set<string>(['']);
  if (changedRelativePath === null) {
    for (const directory of cachedDirectories) {
      targets.add(directory);
    }
    return [...targets];
  }
  const parent = parentRelative(changedRelativePath);
  for (const directory of cachedDirectories) {
    if (directory === '' || directory === changedRelativePath || directory === parent) {
      targets.add(directory);
      continue;
    }
    // A directory is affected when it is an ancestor of the changed path: its
    // listing contains the entry that now has a new size or timestamp.
    if (changedRelativePath.startsWith(`${directory}/`)) {
      targets.add(directory);
    }
  }
  return [...targets];
}



export function useFileTree(
  client: RocClient,
  options: { workspacePathKey: string | null; projectId: string | null }
): FileTreeState {
  const { workspacePathKey, projectId } = options;
  const [children, setChildren] = useState<ReadonlyMap<string, FileEntry[]>>(new Map());
  const [truncated, setTruncated] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [nonce, setNonce] = useState(0);
  const requestSeq = useRef(0);
  // Cached directory keys, readable from the watcher without re-subscribing on
  // every load (the map identity changes on each fetched listing).
  const cachedDirectoriesRef = useRef<string[]>([]);

  // Seed expansion from the stored preference whenever the project changes.
  useEffect(() => {
    setExpanded(new Set(projectId === null ? [] : readFileTreeExpanded(projectId)));
  }, [projectId]);

  // A workspace switch invalidates every cached child listing.
  useEffect(() => {
    setChildren(new Map());
    setTruncated(new Map());
    setErrors(new Map());
    setLoading(new Set());
    requestSeq.current += 1;
  }, [workspacePathKey, nonce]);

  const load = useCallback(
    async (relativePath: string): Promise<void> => {
      const seq = requestSeq.current;
      setLoading((current) => new Set(current).add(relativePath));
      const result = await listTree(client, relativePath);
      // A workspace switch (or a newer reload) makes this response meaningless.
      if (seq !== requestSeq.current) {
        return;
      }
      setLoading((current) => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
      if (!result.ok) {
        setErrors((current) => new Map(current).set(relativePath, result.error.message));
        return;
      }
      setErrors((current) => {
        const next = new Map(current);
        next.delete(relativePath);
        return next;
      });
      const sorted = [...result.data.entries].sort(compareTreeEntries);
      setChildren((current) => new Map(current).set(relativePath, sorted));
      setTruncated((current) => new Map(current).set(relativePath, result.data.truncated));
    },
    [client]
  );

  // Load the root whenever the workspace changes.
  useEffect(() => {
    if (workspacePathKey === null) {
      return;
    }
    void load('');
  }, [workspacePathKey, nonce, load]);

  /**
   * "Expanded" is a **user intent**, not a cache entry — it survives a cache reset
   * (the refresh button, a workspace switch) and is restored from `ui-state` when a
   * project is reopened.
   *
   * Treating it as "already loaded" produced a reproducible bug: expand a
   * directory, press the tree's refresh button (which clears every cached listing),
   * and the directory stays `aria-expanded=true` with a disclosure arrow and **no
   * children, forever** — nothing would ever fetch it again. The same happened on
   * remount, because `expanded` is seeded from `ui-state` while `children` starts
   * empty.
   *
   * So the two facts are separate and this effect keeps them consistent: every
   * expanded directory without a cached listing gets fetched. Directories that are
   * still loading, or whose load already failed, are skipped — otherwise a failing
   * directory would retry in a loop, and `reload()` would never be able to clear
   * the error state.
   */
  useEffect(() => {
    if (workspacePathKey === null) {
      return;
    }
    for (const directory of expanded) {
      if (!children.has(directory) && !loading.has(directory) && !errors.has(directory)) {
        void load(directory);
      }
    }
  }, [children, errors, expanded, loading, load, workspacePathKey]);

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(relativePath)) {
          next.delete(relativePath);
        } else {
          next.add(relativePath);
        }
        if (projectId !== null) {
          writeFileTreeExpanded(projectId, [...next]);
        }
        return next;
      });
    },
    [projectId]
  );

  /**
   * Adds directories to the expanded set without toggling.
   *
   * Used to reveal a path (search results). `toggleDirectory` is the wrong tool:
   * it *collapses* what is already expanded, so revealing underneath a persisted
   * ancestor folded it up and then wrote the emptier set back to `ui-state`,
   * silently discarding the user's expansion.
   */
  const expandDirectories = useCallback(
    (relativePaths: readonly string[]) => {
      if (relativePaths.length === 0) {
        return;
      }
      setExpanded((current) => {
        const next = new Set(current);
        for (const directory of relativePaths) {
          if (directory.length > 0) {
            next.add(directory);
          }
        }
        if (next.size === current.size) {
          return current;
        }
        if (projectId !== null) {
          writeFileTreeExpanded(projectId, [...next]);
        }
        return next;
      });
    },
    [projectId]
  );

  const collapseAll = useCallback(() => {
    setExpanded(() => {
      if (projectId !== null) {
        writeFileTreeExpanded(projectId, []);
      }
      return new Set();
    });
  }, [projectId]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  cachedDirectoriesRef.current = [...children.keys()];

  /**
   * External-edit refresh (T3.2, gate 1).
   *
   * The first event refreshes at once; further events inside the window are
   * coalesced into one trailing refresh. Events are ignored when they belong to
   * another workspace, so a stale watcher cannot repopulate the tree after a
   * project switch.
   */
  useEffect(() => {
    if (workspacePathKey === null) {
      return;
    }
    let timer: number | null = null;
    let pendingChangedPath: string | null = null;
    let pendingWholeWorkspace = false;
    let pendingDirty = false;

    const flush = (): void => {
      const targets = planChangedDirectories(
        pendingWholeWorkspace ? null : pendingChangedPath,
        cachedDirectoriesRef.current
      );
      pendingDirty = false;
      pendingChangedPath = null;
      pendingWholeWorkspace = false;
      for (const target of targets) {
        void load(target);
      }
    };

    const unsubscribe = client.api.workspace.onChanged((event) => {
      if (event.workspacePath !== workspacePathKey) {
        return;
      }
      if (timer === null) {
        pendingChangedPath = event.relativePath;
        pendingWholeWorkspace = event.relativePath === null;
        flush();
        timer = window.setTimeout(() => {
          timer = null;
          if (pendingDirty) {
            flush();
          }
        }, WATCH_REFRESH_WINDOW_MS);
        return;
      }
      pendingDirty = true;
      if (event.relativePath === null) {
        pendingWholeWorkspace = true;
      } else {
        pendingChangedPath = event.relativePath;
      }
    });

    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [client, workspacePathKey, load]);

  /**
   * Flatten the expanded directories into the visible row list. Directories that
   * are expanded but whose children have not arrived yet contribute only
   * themselves, which is why they render with a busy marker rather than a gap.
   */
  const rows = useMemo(() => {
    const output: FileTreeRow[] = [];

    const walk = (directory: string, depth: number): void => {
      const entries = children.get(directory) ?? [];
      const setSize = truncated.get(directory) ? -1 : entries.length;
      entries.forEach((entry, index) => {
        const isDirectory = entry.type === 'directory';
        const isExpanded = isDirectory && expanded.has(entry.relativePath);
        output.push({ entry, depth, expanded: isExpanded, positionInSet: index + 1, setSize });
        if (isExpanded) {
          walk(entry.relativePath, depth + 1);
        }
      });
    };

    walk('', 0);
    return output;
  }, [children, expanded, truncated]);

  return {
    rows,
    loading,
    errors,
    loadingRoot: loading.has(''),
    rootError: errors.get('') ?? null,
    truncatedRoot: truncated.get('') ?? false,
    expanded,
    toggleDirectory,
    expandDirectories,
    collapseAll,
    reload
  };
}

export { joinRelative, parentRelative };
