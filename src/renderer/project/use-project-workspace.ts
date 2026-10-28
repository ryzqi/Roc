import { useCallback, useRef, useState } from 'react';
import type { ResearchProject } from '../../shared/types';
import { errorMessage } from '../app/loaded-state';
import { useAsyncAction } from '../app/use-async-resource';
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
  const update = useAsyncAction<[{ id: string; workspacePath: string }], ResearchProject>(
    (input) => updateProject(client, input),
    { label: '绑定工作目录' }
  );
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const invalidateProjectList = useInvalidateProjectList();

  const bind = useCallback(() => {
    if (project === null || pickingRef.current || update.pending) {
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    setPickError(null);
    update.reset();
    void (async () => {
      try {
        const selection = await client.api.workspace.selectFromDialog().catch((error: unknown) => {
          setPickError(errorMessage(error));
          return null;
        });
        if (selection === null) {
          return;
        }
        if (!selection.ok) {
          setPickError(selection.error.message);
          return;
        }
        if (selection.data === null) {
          // Genuine cancel: say nothing.
          return;
        }
        const updated = await update.run({ id: project.id, workspacePath: selection.data.path });
        if (updated.ok) {
          invalidateProjectList();
          onBound();
        }
      } finally {
        pickingRef.current = false;
        setPicking(false);
      }
    })();
  }, [client, invalidateProjectList, onBound, project, update]);

  const clearError = useCallback(() => {
    setPickError(null);
    update.reset();
  }, [update]);

  return { bind, pending: picking || update.pending, error: pickError ?? update.error, clearError };
}
