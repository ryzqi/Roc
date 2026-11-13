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
  gitCancelPush,
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
type GitOperation = {action: GitActionName; workspacePath: string; generation: number};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const readFailure = (error: unknown): {ok: false; error: {message: string}} => ({ok: false, error: {message: errorMessage(error)}});

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
  /** Reads the operation lock before React has rendered the pending state. */
  isBusy: () => boolean;
  cancellingPush: boolean;
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
  cancelPush: () => Promise<void>;
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
  const [cancellingPush, setCancellingPush] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<GitCommitResult | null>(null);
  const [lastPush, setLastPush] = useState<GitPushResult | null>(null);
  const pushOperationId = useRef<string | null>(null);
  const pushWorkspacePath = useRef<string | null>(null);
  const pushWorkspaceGeneration = useRef<number | null>(null);
  const workspacePathRef = useRef(workspacePath);
  const previousWorkspacePath = useRef(workspacePath);
  const workspaceGeneration = useRef(0);
  const mounted = useRef(true);
  const operationRef = useRef<GitOperation | null>(null);
  const cancellationRef = useRef<GitOperation | null>(null);
  const watcherDirty = useRef(false);
  const watcherReload = useRef<(() => Promise<void>) | null>(null);
  workspacePathRef.current = workspacePath;

  const isCurrentWorkspaceScope = useCallback(
    (operationWorkspacePath: string | null, operationGeneration: number): boolean =>
      mounted.current && workspacePathRef.current === operationWorkspacePath && workspaceGeneration.current === operationGeneration,
    []
  );

  // Bumped on every workspace change and on every full reload: results that
  // belong to an older scope are dropped instead of overwriting the new one.
  const requestSeq = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;

  const beginOperation = useCallback((action: GitActionName): GitOperation | null => {
    if (!mounted.current || workspacePath === null || workspacePathRef.current !== workspacePath ||
      operationRef.current !== null) return null;
    const operation = {action, workspacePath, generation: workspaceGeneration.current};
    operationRef.current = operation;
    // A snapshot requested before a mutation cannot overwrite the mutation's receipt.
    requestSeq.current++;
    setPending(action);
    setActionError(null);
    return operation;
  }, [workspacePath]);

  const finishOperation = useCallback((operation: GitOperation): void => {
    if (operationRef.current !== operation || !isCurrentWorkspaceScope(operation.workspacePath, operation.generation) ||
      cancellationRef.current === operation) return;
    operationRef.current = null;
    setPending(null);
    if (watcherDirty.current) {
      watcherDirty.current = false;
      void watcherReload.current?.();
    }
  }, [isCurrentWorkspaceScope]);

  const applyStatus = useCallback((next: GitStatusResult): void => {
    setSnapshot(next);
    const nextSelected = findNextGitSelection(next.changes, selectedPathRef.current);
    selectedPathRef.current = nextSelected;
    setSelectedPath(nextSelected);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    if (workspacePath === null) {
      setPhase('idle');
      setSnapshot(null);
      setBranches(null);
      setDiffStat(null);
      setError(null);
      return;
    }
    setPhase('loading');
    setError(null);
    setErrorCode(undefined);

    try {
      const [statusResult, statResult, branchResult] = await Promise.all([
        gitStatus(client),
        Promise.resolve().then(() => gitDiffStat(client)).catch(readFailure),
        Promise.resolve().then(() => gitListBranches(client)).catch(readFailure)
      ]);
      if (!mounted.current || seq !== requestSeq.current) return;

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
      // The stat is a summary: a failure here does not take the change list down.
      setDiffStat(statResult.ok ? statResult.data.stat : null);
      setDiffStatError(statResult.ok ? null : statResult.error.message);
      if (!branchResult.ok) setActionError(branchResult.error.message);
    } catch (failure) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setSnapshot(null);
      setBranches(null);
      setDiffStat(null);
      setDiffStatError(null);
      setError(errorMessage(failure));
      setErrorCode(undefined);
      setPhase('error');
    }
  }, [client, workspacePath, applyStatus]);

  useEffect(() => {
    mounted.current = true;
    if (previousWorkspacePath.current !== workspacePath) {
      previousWorkspacePath.current = workspacePath;
      workspaceGeneration.current += 1;
    }
    const activePushId = pushOperationId.current;
    const activePushWorkspace = pushWorkspacePath.current;
    const activePushGeneration = pushWorkspaceGeneration.current;
    if (
      activePushId !== null &&
      (activePushWorkspace !== workspacePath || activePushGeneration !== workspaceGeneration.current)
    ) {
      pushOperationId.current = null;
      pushWorkspacePath.current = null;
      pushWorkspaceGeneration.current = null;
      setPending((current) => current === 'push' ? null : current);
      void Promise.resolve().then(() => gitCancelPush(client, activePushId)).then((result) => {
        if (
          !result.ok &&
          activePushGeneration !== null &&
          isCurrentWorkspaceScope(activePushWorkspace, activePushGeneration)
        ) {
          setActionError(result.error.message);
        }
      }, (error: unknown) => {
        if (
          activePushGeneration !== null &&
          isCurrentWorkspaceScope(activePushWorkspace, activePushGeneration)
        ) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      });
    }
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
    operationRef.current = null;
    cancellationRef.current = null;
    watcherDirty.current = false;
    setPending(null);
    setCancellingPush(false);
    void load();
    return () => {
      mounted.current = false;
      workspaceGeneration.current++;
      requestSeq.current++;
      operationRef.current = null;
    };
  }, [client, isCurrentWorkspaceScope, load, workspacePath]);

  const refresh = useCallback(async (): Promise<void> => {
    const operation = beginOperation('refresh');
    if (operation === null) return;
    try {
      await load();
    } finally {
      finishOperation(operation);
    }
  }, [beginOperation, finishOperation, load]);

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
    if (operationRef.current !== null) {
      watcherDirty.current = true;
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
    try {
      const [statusResult, statResult] = await Promise.all([
        gitStatus(client), Promise.resolve().then(() => gitDiffStat(client)).catch(readFailure)
      ]);
      if (!mounted.current || seq !== requestSeq.current) return;
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
    } catch (failure) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setError(errorMessage(failure));
      setErrorCode(undefined);
      setPhase('error');
    }
  }, [applyStatus, branches, client, load, workspacePath]);
  watcherReload.current = reloadStatusOnly;

  const refreshDiffStat = useCallback(async (operation: GitOperation): Promise<void> => {
    const result = await Promise.resolve().then(() => gitDiffStat(client)).catch(readFailure);
    if (!isCurrentWorkspaceScope(operation.workspacePath, operation.generation)) return;
    setDiffStat(result.ok ? result.data.stat : null);
    setDiffStatError(result.ok ? null : result.error.message);
  }, [client, isCurrentWorkspaceScope]);

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
      const scope = beginOperation(action);
      if (scope === null) return;
      try {
        const result = await operation();
        if (!isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) return;
        if (!result.ok) {
          setActionError(result.error.message);
          // The on-disk state is unknown after a failed file operation.
          await load();
          return;
        }
        applyStatus(result.data);
        await refreshDiffStat(scope);
      } catch (failure) {
        if (isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) {
          setActionError(errorMessage(failure));
          await load();
        }
      } finally {
        finishOperation(scope);
      }
    },
    [applyStatus, beginOperation, finishOperation, isCurrentWorkspaceScope, load, refreshDiffStat]
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
      const scope = beginOperation('commit');
      if (scope === null) return false;
      try {
        const result = await gitCommit(client, message);
        if (!isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) return false;
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        applyStatus(result.data.status);
        setLastCommit(result.data);
        await refreshDiffStat(scope);
        return isCurrentWorkspaceScope(scope.workspacePath, scope.generation);
      } catch (failure) {
        if (isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) setActionError(errorMessage(failure));
        return false;
      } finally {
        finishOperation(scope);
      }
    },
    [applyStatus, beginOperation, client, finishOperation, isCurrentWorkspaceScope, refreshDiffStat]
  );

  const push = useCallback(async (): Promise<boolean> => {
    const scope = beginOperation('push');
    if (scope === null) return false;
    const operationId = globalThis.crypto.randomUUID();
    const operationWorkspacePath = scope.workspacePath;
    const operationGeneration = scope.generation;
    pushOperationId.current = operationId;
    pushWorkspacePath.current = operationWorkspacePath;
    pushWorkspaceGeneration.current = operationGeneration;
    try {
      const result = await gitPush(client, operationId);
      if (
        pushOperationId.current !== operationId ||
        pushWorkspacePath.current !== operationWorkspacePath ||
        pushWorkspaceGeneration.current !== operationGeneration ||
        !isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration)
      ) {
        return false;
      }
      if (!result.ok) {
        // Push failures (no remote, rejected, auth) must show the backend's own
        // text: git's message is the actionable part.
        setActionError(result.error.message);
        return false;
      }
      applyStatus(result.data.status);
      setLastPush(result.data);
      return true;
    } catch (failure) {
      if (isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration)) setActionError(errorMessage(failure));
      return false;
    } finally {
      if (pushOperationId.current === operationId) {
        pushOperationId.current = null;
        pushWorkspacePath.current = null;
        pushWorkspaceGeneration.current = null;
      }
      finishOperation(scope);
    }
  }, [applyStatus, beginOperation, client, finishOperation, isCurrentWorkspaceScope]);

  const cancelPush = useCallback(async (): Promise<void> => {
    const operationId = pushOperationId.current;
    const operationWorkspacePath = pushWorkspacePath.current;
    const operationGeneration = pushWorkspaceGeneration.current;
    const scope = operationRef.current;
    if (operationId === null || operationWorkspacePath === null || operationGeneration === null ||
      scope?.action !== 'push' || cancellationRef.current !== null ||
      !isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration)) return;
    cancellationRef.current = scope;
    setCancellingPush(true);
    try {
      const result = await gitCancelPush(client, operationId);
      if (isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration) && !result.ok) {
        setActionError(result.error.message);
      }
    } catch (failure) {
      if (isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration)) setActionError(errorMessage(failure));
    } finally {
      if (cancellationRef.current === scope) {
        cancellationRef.current = null;
        if (isCurrentWorkspaceScope(operationWorkspacePath, operationGeneration)) setCancellingPush(false);
        if (pushOperationId.current === null) finishOperation(scope);
      }
    }
  }, [client, finishOperation, isCurrentWorkspaceScope]);

  const applyBranchMutation = useCallback(
    (data: { branchInfo: GitBranchListResult; status: GitStatusResult }): void => {
      setBranches(data.branchInfo);
      applyStatus(data.status);
    },
    [applyStatus]
  );

  const createBranch = useCallback(
    async (name: string, checkoutAfterCreate: boolean): Promise<boolean> => {
      const scope = beginOperation('branch');
      if (scope === null) return false;
      try {
        const result = await gitCreateBranch(client, name, checkoutAfterCreate);
        if (!isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) return false;
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        applyBranchMutation(result.data);
        return true;
      } catch (failure) {
        if (isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) setActionError(errorMessage(failure));
        return false;
      } finally {
        finishOperation(scope);
      }
    },
    [applyBranchMutation, beginOperation, client, finishOperation, isCurrentWorkspaceScope]
  );

  const checkoutBranch = useCallback(
    async (name: string): Promise<boolean> => {
      const scope = beginOperation('branch');
      if (scope === null) return false;
      try {
        const result = await gitCheckoutBranch(client, name);
        if (!isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) return false;
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        applyBranchMutation(result.data);
        return true;
      } catch (failure) {
        if (isCurrentWorkspaceScope(scope.workspacePath, scope.generation)) setActionError(errorMessage(failure));
        return false;
      } finally {
        finishOperation(scope);
      }
    },
    [applyBranchMutation, beginOperation, client, finishOperation, isCurrentWorkspaceScope]
  );

  const selectFile = useCallback((relativePath: string | null): void => {
    selectedPathRef.current = relativePath;
    setSelectedPath(relativePath);
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);
  const isBusy = useCallback(() => operationRef.current !== null || cancellationRef.current !== null, []);

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
      isBusy,
      cancellingPush,
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
      cancelPush,
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
      isBusy,
      cancellingPush,
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
      cancelPush,
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
