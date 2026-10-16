import { useCallback, useEffect, useState } from 'react';
import type { ResearchProject } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { getCurrentWorkspace, selectWorkspace } from './workspace-store';

/**
 * Binds the project's `workspacePath` to the backend's *current* workspace
 * (P3/T3.1).
 *
 * This is the step that actually makes files, Git and the terminal work.
 * `files.*`, `git.*` and `files.listTree` all take **workspace-relative** paths
 * and resolve them against `WorkspaceService.getCurrentWorkspace()`, which only
 * `workspace.select` changes. The project's `workspacePath` field alone is inert
 * data — a project can be opened (P2) without the backend being scoped to its
 * directory, in which case every file call would read the wrong directory, or
 * fail with `workspace_not_selected`.
 *
 * The legacy shell did this at each entry point (project open, tool open). Doing
 * it in one effect keyed on `workspacePath` is strictly better: there is a single
 * place that can forget, and the reconciliation is derived from the project
 * rather than from which button was pressed.
 *
 * `path` is the **bound** directory, which is what callers key file/Git/terminal
 * state on, so switching projects rebuilds them instead of leaking the previous
 * project's data (gate 6).
 */

export type WorkspaceBindingStatus = 'idle' | 'binding' | 'bound' | 'error';

export type BoundWorkspace = {
  /** Absolute path the backend is scoped to, or null when nothing is bound. */
  path: string | null;
  /** What the project asks for, even while binding or after a failure. */
  desiredPath: string | null;
  status: WorkspaceBindingStatus;
  error: string | null;
  /** Retries after a failure (directory temporarily unavailable, etc.). */
  rebind: () => void;
};

export function useBoundWorkspace(client: RocClient, project: ResearchProject | null): BoundWorkspace {
  const desiredPath = project?.workspacePath ?? null;
  const [path, setPath] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkspaceBindingStatus>(desiredPath === null ? 'idle' : 'binding');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (desiredPath === null) {
      setPath(null);
      setStatus('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus('binding');
    setError(null);
    // Drop the previous binding immediately: showing the old directory's tree
    // while the new one is being selected is the leak gate 6 is about.
    setPath(null);

    void (async () => {
      const current = await getCurrentWorkspace(client);
      if (cancelled) {
        return;
      }
      if (current.ok && current.data !== null && current.data.path === desiredPath) {
        setPath(desiredPath);
        setStatus('bound');
        return;
      }
      // Either the backend is scoped elsewhere (a previously opened project) or
      // it has nothing selected yet; both need `workspace.select`.
      const selected = await selectWorkspace(client, desiredPath);
      if (cancelled) {
        return;
      }
      if (!selected.ok) {
        setPath(null);
        setStatus('error');
        setError(selected.error.message);
        return;
      }
      setPath(selected.data.path);
      setStatus('bound');
    })();

    return () => {
      cancelled = true;
    };
  }, [client, desiredPath, nonce]);

  const rebind = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { path, desiredPath, status, error, rebind };
}
