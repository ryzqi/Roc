import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitBranchListResult,
  GitCommitResult,
  GitPushResult,
  GitStatusResult
} from '../../shared/types';
import { BACKEND_ERROR_CODES } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { WATCH_REFRESH_WINDOW_MS } from './watch-refresh';
import {
  findNextGitSelection,
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitDiffStat,
  gitDiscardFile,
  gitListBranches,
  gitPush,
  gitStageFile,
  gitStageFiles,
  gitStatus,
  gitUnstageFile,
  isNotAGitRepository
} from './git-store';

/**
 * Git workspace state (P3/T3.5), keyed on the **bound** workspace path.
 *
 * All Git state lives here rather than in a shell-wide reducer (the legacy shell
 * put it in `WorkspaceData`), for two reasons:
 *
 *   1. A workspace switch must rebuild it, and a hook keyed on the path cannot
 *      forget to (gate 6).
 *   2. Every mutation returns a fresh `GitStatusResult`, so after an action there
 *      is exactly one source of truth to update instead of optimistic copies that
 *      can drift from `git status`.
 *
 * A failure to read the status is not always an error: when the directory is not
 * a repository the backend answers `git_repository_missing`, which the panel
 * renders as an explanation (with the fix) rather than a red bar.
 */

export type GitActionName = 'refresh' | 'stage' | 'unstage' | 'discard' | 'commit' | 'push' | 'branch';

export type GitWorkspace = {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  snapshot: GitStatusResult | null;
  /** `git diff --stat` text; empty when the working tree is clean. */
  diffStat: string | null;
  diffStatError: string | null;
  branches: GitBranchListResult | null;
  error: string | null;
  /**
   * Backend error code for the failure that made the panel unavailable, so the
   * caller can tell "not a repository" from "the directory is gone".
   */
  errorCode: string | undefined;
  /** True when there is nothing to list: no bound workspace, or a backend refusal. */
  unavailable: boolean;
  selectedPath: string | null;
  selectFile: (relativePath: string | null) => void;
  pending: GitActionName | null;
  actionError: string | null;
  clearActionError: () => void;
  lastCommit: GitCommitResult | null;
  lastPush: GitPushResult | null;
  refresh: () => Promise<void>;
  stage: (relativePaths: string[]) => Promise<void>;
  unstage: (relativePath: string) => Promise<void>;
  discard: (relativePath: string) => Promise<void>;
  commit: (message: string) => Promise<boolean>;
  push: () => Promise<boolean>;
  createBranch: (name: string, checkoutAfterCreate: boolean) => Promise<boolean>;
  checkoutBranch: (name: string) => Promise<boolean>;
};

export function useGitWorkspace(client: RocClient, workspacePath: string | null): GitWorkspace {
  const [phase, setPhase] = useState<GitWorkspace['phase']>(workspacePath === null ? 'idle' : 'loading');
  const [snapshot, setSnapshot] = useState<GitStatusResult | null>(null);
  const [diffStat, setDiffStat] = useState<string | null>(null);
  const [diffStatError, setDiffStatError] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pending, setPending] = useState<GitActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<GitCommitResult | null>(null);
  const [lastPush, setLastPush] = useState<GitPushResult | null>(null);

  // Bumped on every workspace change and on every full reload: results that
  // belong to an older scope are dropped instead of overwriting the new one.
  const requestSeq = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;

  const applyStatus = useCallback((next: GitStatusResult): void => {
    setSnapshot(next);
    const nextSelected = findNextGitSelection(next.changes, selectedPathRef.current);
    selectedPathRef.current = nextSelected;
    setSelectedPath(nextSelected);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (workspacePath === null) {
      setPhase('idle');
      setSnapshot(null);
      setBranches(null);
      setDiffStat(null);
      setError(null);
      return;
    }
    requestSeq.current += 1;
    const seq = requestSeq.current;
    setPhase('loading');
    setError(null);
    setErrorCode(undefined);

    const [statusResult, statResult, branchResult] = await Promise.all([
      gitStatus(client),
      gitDiffStat(client),
      gitListBranches(client)
    ]);
    if (seq !== requestSeq.current) {
      return;
    }

    if (!statusResult.ok) {
      // The other two fail for the same reason; do not stack three copies of it.
      setSnapshot(null);
      setBranches(null);
      setDiffStat(null);
      setDiffStatError(null);
      setError(statusResult.error.message);
      setErrorCode(statusResult.error.code);
      setPhase('error');
      return;
    }

    setError(null);
    setErrorCode(undefined);
    setPhase('ready');
    applyStatus(statusResult.data);
    setBranches(branchResult.ok ? branchResult.data : null);
    // The stat is a summary: a failure here hides one line, it does not take the
    // change list down with it.
    setDiffStat(statResult.ok ? statResult.data.stat : null);
    setDiffStatError(statResult.ok ? null : statResult.error.message);
    if (!branchResult.ok) {
      setActionError(branchResult.error.message);
    }
  }, [client, workspacePath, applyStatus]);

  useEffect(() => {
    // Reset before loading so a project switch never shows the previous
    // repository's branch, changes or selection.
    setSnapshot(null);
    setBranches(null);
    setDiffStat(null);
    setDiffStatError(null);
    setSelectedPath(null);
    selectedPathRef.current = null;
    setActionError(null);
    setLastCommit(null);
    setLastPush(null);
    void load();
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setPending('refresh');
    await load();
    setPending(null);
  }, [load]);

  /**
   * Re-reads status + diffStat only.
   *
   * A file changing on disk (an external editor, or a command typed into the
   * embedded terminal) changes what `git status` says, but not the branch list.
   * Re-reading all three would triple the cost of a refresh for no new information.
   */
  const reloadStatusOnly = useCallback(async (): Promise<void> => {
    if (workspacePath === null) {
      return;
    }
    /**
     * A status-only refresh must never be the first thing that happens.
     *
     * It shares `requestSeq` with `load` (so a stale response can never win), which
     * means it *cancels* an in-flight full load. If a file happened to change while
     * the panel was still loading, the branch list would then stay `null` forever —
     * an empty branch switcher that no refresh explains. Falling back to the full
     * load in that window is cheaper than tracking two sequences.
     */
    if (branches === null) {
      await load();
      return;
    }
    requestSeq.current += 1;
    const seq = requestSeq.current;
    const [statusResult, statResult] = await Promise.all([gitStatus(client), gitDiffStat(client)]);
    if (seq !== requestSeq.current) {
      return;
    }
    if (!statusResult.ok) {
      setError(statusResult.error.message);
      setErrorCode(statusResult.error.code);
      setPhase('error');
      return;
    }
    setPhase('ready');
    setError(null);
    setErrorCode(undefined);
    applyStatus(statusResult.data);
    setDiffStat(statResult.ok ? statResult.data.stat : null);
    setDiffStatError(statResult.ok ? null : statResult.error.message);
  }, [applyStatus, branches, client, load, workspacePath]);

  /**
   * Watcher-driven refresh, with the same coalescing policy as the file tree: the
   * first event refreshes at once, and events arriving inside 200 ms are merged
   * into one trailing refresh.
   *
   * Without this the panel silently shows stale changes whenever a file is edited
   * while it is open — including by the app's own terminal, which is a flow the
   * panel invites. Events from another workspace are ignored, so a stale watcher
   * cannot repopulate the list after a project switch (gate 6).
   */
  useEffect(() => {
    if (workspacePath === null) {
      return;
    }
    let timer: number | null = null;
    let dirty = false;

    const refreshFromWatcher = (): void => {
      dirty = false;
      void reloadStatusOnly();
    };

    const unsubscribe = client.api.workspace.onChanged((event) => {
      if (event.workspacePath !== workspacePath) {
        return;
      }
      if (timer === null) {
        refreshFromWatcher();
        timer = window.setTimeout(() => {
          timer = null;
          if (dirty) {
            refreshFromWatcher();
          }
        }, WATCH_REFRESH_WINDOW_MS);
        return;
      }
      dirty = true;
    });

    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [client, reloadStatusOnly, workspacePath]);

  const runFileAction = useCallback(
    async (
      action: GitActionName,
      operation: () => Promise<{ ok: true; data: GitStatusResult } | { ok: false; error: { message: string } }>
    ): Promise<void> => {
      setPending(action);
      setActionError(null);
      const result = await operation();
      if (!result.ok) {
        setActionError(result.error.message);
        setPending(null);
        // A failed stage/unstage leaves the on-disk state unknown, so re-read it
        // rather than showing a list that may no longer be true.
        await load();
        return;
      }
      applyStatus(result.data);
      const statResult = await gitDiffStat(client);
      if (statResult.ok) {
        setDiffStat(statResult.data.stat);
        setDiffStatError(null);
      }
      setPending(null);
    },
    [applyStatus, client, load]
  );

  const stage = useCallback(
    async (relativePaths: string[]): Promise<void> => {
      const first = relativePaths[0];
      if (first === undefined) {
        return;
      }
      if (relativePaths.length === 1) {
        await runFileAction('stage', () => gitStageFile(client, first));
        return;
      }
      await runFileAction('stage', () => gitStageFiles(client, relativePaths));
    },
    [client, runFileAction]
  );

  const unstage = useCallback(
    async (relativePath: string): Promise<void> => {
      await runFileAction('unstage', () => gitUnstageFile(client, relativePath));
    },
    [client, runFileAction]
  );

  const discard = useCallback(
    async (relativePath: string): Promise<void> => {
      await runFileAction('discard', () => gitDiscardFile(client, relativePath));
    },
    [client, runFileAction]
  );

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      setPending('commit');
      setActionError(null);
      const result = await gitCommit(client, message);
      setPending(null);
      if (!result.ok) {
        setActionError(result.error.message);
        return false;
      }
      applyStatus(result.data.status);
      setLastCommit(result.data);
      const statResult = await gitDiffStat(client);
      if (statResult.ok) {
        setDiffStat(statResult.data.stat);
        setDiffStatError(null);
      }
      return true;
    },
    [applyStatus, client]
  );

  const push = useCallback(async (): Promise<boolean> => {
    setPending('push');
    setActionError(null);
    const result = await gitPush(client);
    setPending(null);
    if (!result.ok) {
      // Push failures (no remote, rejected, auth) must show the backend's own
      // text: git's message is the actionable part.
      setActionError(result.error.message);
      return false;
    }
    applyStatus(result.data.status);
    setLastPush(result.data);
    return true;
  }, [applyStatus, client]);

  const applyBranchMutation = useCallback(
    (data: { branchInfo: GitBranchListResult; status: GitStatusResult }): void => {
      setBranches(data.branchInfo);
      applyStatus(data.status);
    },
    [applyStatus]
  );

  const createBranch = useCallback(
    async (name: string, checkoutAfterCreate: boolean): Promise<boolean> => {
      setPending('branch');
      setActionError(null);
      const result = await gitCreateBranch(client, name, checkoutAfterCreate);
      setPending(null);
      if (!result.ok) {
        setActionError(result.error.message);
        return false;
      }
      applyBranchMutation(result.data);
      return true;
    },
    [applyBranchMutation, client]
  );

  const checkoutBranch = useCallback(
    async (name: string): Promise<boolean> => {
      setPending('branch');
      setActionError(null);
      const result = await gitCheckoutBranch(client, name);
      setPending(null);
      if (!result.ok) {
        setActionError(result.error.message);
        return false;
      }
      applyBranchMutation(result.data);
      return true;
    },
    [applyBranchMutation, client]
  );

  const selectFile = useCallback((relativePath: string | null): void => {
    selectedPathRef.current = relativePath;
    setSelectedPath(relativePath);
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);

  return useMemo(
    () => ({
      phase,
      snapshot,
      diffStat,
      diffStatError,
      branches,
      error,
      errorCode,
      unavailable: isNotAGitRepository(errorCode) || errorCode === BACKEND_ERROR_CODES.workspacePathMissing,
      selectedPath,
      selectFile,
      pending,
      actionError,
      clearActionError,
      lastCommit,
      lastPush,
      refresh,
      stage,
      unstage,
      discard,
      commit,
      push,
      createBranch,
      checkoutBranch
    }),
    [
      phase,
      snapshot,
      diffStat,
      diffStatError,
      branches,
      error,
      errorCode,
      selectedPath,
      selectFile,
      pending,
      actionError,
      clearActionError,
      lastCommit,
      lastPush,
      refresh,
      stage,
      unstage,
      discard,
      commit,
      push,
      createBranch,
      checkoutBranch
    ]
  );
}

/**
 * Note on `unavailable`: it is true for `git_repository_missing` and for
 * `workspace_path_missing` — both mean "there is nothing to list here", and both
 * are fixed by moving the project's working directory, so they share one surface.
 * They do **not** share wording: `errorCode` is exported so the panel can say
 * "this directory is gone" instead of "this directory has no .git".
 */
