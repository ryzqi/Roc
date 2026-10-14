import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../../shared/types';
import { readFileTreeExpanded, writeFileTreeExpanded } from '../app/ui-state';
import type { RocClient } from '../shared/roc-client';
import { compareTreeEntries, joinRelative, parentRelative } from './paths';
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
};

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
  collapseAll: () => void;
  reload: () => void;
};

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

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(relativePath)) {
          next.delete(relativePath);
        } else {
          next.add(relativePath);
          if (!children.has(relativePath)) {
            void load(relativePath);
          }
        }
        if (projectId !== null) {
          writeFileTreeExpanded(projectId, [...next]);
        }
        return next;
      });
    },
    [children, load, projectId]
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

  /**
   * Flatten the expanded directories into the visible row list. Directories that
   * are expanded but whose children have not arrived yet contribute only
   * themselves, which is why they render with a busy marker rather than a gap.
   */
  const rows = useMemo(() => {
    const output: FileTreeRow[] = [];

    const walk = (directory: string, depth: number): void => {
      const entries = children.get(directory) ?? [];
      for (const entry of entries) {
        const isDirectory = entry.type === 'directory';
        const isExpanded = isDirectory && expanded.has(entry.relativePath);
        output.push({ entry, depth, expanded: isExpanded });
        if (isExpanded) {
          walk(entry.relativePath, depth + 1);
        }
      }
    };

    walk('', 0);
    return output;
  }, [children, expanded]);

  return {
    rows,
    loading,
    errors,
    loadingRoot: loading.has(''),
    rootError: errors.get('') ?? null,
    truncatedRoot: truncated.get('') ?? false,
    expanded,
    toggleDirectory,
    collapseAll,
    reload
  };
}

/** True when the entry is a directory that has no cached children yet. */
export function needsChildren(state: FileTreeState, relativePath: string): boolean {
  return !state.errors.has(relativePath) && state.loading.has(relativePath);
}

export { joinRelative, parentRelative };
