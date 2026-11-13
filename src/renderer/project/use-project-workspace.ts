import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResearchProject } from '../../shared/types';
import { errorMessage, runIpcAction } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { updateProject } from './project-store';
import { useInvalidateProjectList } from './use-project-list';

/**
 * Binds a workspace directory to a project (P2/T2.5).
 *
 * Kept out of `AppShell`'s own `useProjects` because the shell needs this one
 * action, not the whole project list — loading every project just to change one
 * directory would be a pointless round-trip.
 *
 * The native panel's three outcomes stay distinct (picked / cancelled / failed).
 * Collapsing them made a backend failure look like the user closing the panel, so
 * nothing happened and nothing was said.
 */

export type ProjectWorkspaceBinding = {
  /** Opens the native panel and, on pick, writes the path to the project. */
  bind: () => void;
  pending: boolean;
  /** Panel failure or update failure, with the backend's own message. */
  error: string | null;
  clearError: () => void;
};

export function useProjectWorkspace(
  client: RocClient,
  project: ResearchProject | null,
  onBound: () => void
): ProjectWorkspaceBinding {
  const scope = useMemo(() => ({}), [client, project?.id]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {mountedRef.current = false;};
  }, []);
  const [pickError, setPickError] = useState<{scope: object; message: string} | null>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const invalidateProjectList = useInvalidateProjectList();

  const bind = useCallback(() => {
    if (project === null || !mountedRef.current || scopeRef.current !== scope || pickingRef.current) {
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    setPickError(null);
    const current = (): boolean => mountedRef.current && scopeRef.current === scope;
    void (async () => {
      try {
        const selection = await client.api.workspace.selectFromDialog();
        if (!current()) return;
        if (!selection.ok) {
          setPickError({scope, message: selection.error.message});
          return;
        }
        if (selection.data === null) {
          // Genuine cancel: say nothing.
          return;
        }
        const workspacePath = selection.data.path;
        const updated = await runIpcAction(() => updateProject(client, { id: project.id, workspacePath }));
        if (updated.ok) {
          invalidateProjectList();
          if (current()) onBound();
        } else if (current()) setPickError({scope, message: updated.error});
      } catch (error) {
        if (current()) setPickError({scope, message: errorMessage(error)});
      } finally {
        pickingRef.current = false;
        if (mountedRef.current) setPicking(false);
      }
    })();
  }, [client, invalidateProjectList, onBound, project, scope]);

  const clearError = useCallback(() => {
    setPickError(null);
  }, []);

  return { bind, pending: picking, error: pickError?.scope === scope ? pickError.message : null, clearError };
}
