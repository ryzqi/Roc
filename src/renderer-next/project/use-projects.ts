import { useCallback, useState } from 'react';
import type { ResearchProject } from '../../shared/types';
import { useAsyncAction, useAsyncResource, type AsyncAction, type AsyncResource } from '../app/use-async-resource';
import { readStarredProjectIds, writeStarredProjectIds } from '../app/ui-state';
import type { RocClient } from '../shared/roc-client';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type ProjectCreateInput,
  type ProjectUpdateInput
} from './project-store';

/**
 * Project portal data hooks (P2/T2.1).
 *
 * Wraps `research.projects.*` in the shared async primitives (ADR-M07): reads use
 * `useAsyncResource` (keyed, with a reload used by the error bar's retry), writes
 * use `useAsyncAction` (with the backend message passed straight through).
 *
 * Pinning is a local preference and lives in `ui-state.ts`; it is kept here so
 * components never touch `localStorage` directly (ADR-M06).
 */

/**
 * Result of the native directory panel.
 *
 * `cancelled` and `failed` are deliberately distinct: collapsing both into
 * `null` made a backend failure look like the user closing the panel, so clicking
 * 「选择目录」 did nothing visible and said nothing (ADR-M07 forbids that).
 */
export type WorkspacePickResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export type ProjectsState = {
  list: AsyncResource<ResearchProject[]>;
  create: AsyncAction<[ProjectCreateInput], ResearchProject>;
  update: AsyncAction<[ProjectUpdateInput], ResearchProject>;
  remove: AsyncAction<[string], { deleted: true; id: string }>;
  pinnedIds: readonly string[];
  togglePin: (projectId: string) => void;
  pickWorkspace: () => Promise<WorkspacePickResult>;
  /** Re-reads the list after a successful write. */
  refresh: () => void;
};

export function useProjects(client: RocClient): ProjectsState {
  const list = useAsyncResource<ResearchProject[]>('projects', () => listProjects(client), {
    label: '读取科研项目'
  });
  const create = useAsyncAction<[ProjectCreateInput], ResearchProject>(
    (input) => createProject(client, input),
    { label: '创建科研项目' }
  );
  const update = useAsyncAction<[ProjectUpdateInput], ResearchProject>(
    (input) => updateProject(client, input),
    { label: '更新科研项目' }
  );
  const remove = useAsyncAction<[string], { deleted: true; id: string }>(
    (id) => deleteProject(client, id),
    { label: '删除科研项目' }
  );

  const [pinnedIds, setPinnedIds] = useState<readonly string[]>(() => readStarredProjectIds());

  const togglePin = useCallback((projectId: string) => {
    setPinnedIds((current) => {
      const next = current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId];
      writeStarredProjectIds(next);
      return next;
    });
  }, []);

  /**
   * Native directory panel only. The plan forbids typing a path and forbids the
   * browser File API (no `createObjectURL`, no `<input type="file">`).
   */
  const pickWorkspace = useCallback(async (): Promise<WorkspacePickResult> => {
    const result = await client.api.workspace.selectFromDialog();
    if (!result.ok) {
      return { status: 'failed', message: result.error.message };
    }
    if (result.data === null) {
      return { status: 'cancelled' };
    }
    return { status: 'picked', path: result.data.path };
  }, [client]);

  // `list.reload` is a stable callback, so this stays stable too. The resource
  // objects are memoised inside `use-async-resource`, which is what keeps this
  // chain from changing identity every render.
  const reloadList = list.reload;
  const refresh = useCallback(() => {
    reloadList();
  }, [reloadList]);

  return { list, create, update, remove, pinnedIds, togglePin, pickWorkspace, refresh };
}

/**
 * Loads the project named by the URL, for the shell's chrome and the read-only
 * gate. The key is `null` in portal state, which keeps the resource idle.
 */
export function useCurrentProject(
  client: RocClient,
  projectId: string | null
): AsyncResource<ResearchProject> {
  return useAsyncResource<ResearchProject>(projectId, () => getProject(client, projectId ?? ''), {
    label: '读取当前科研项目'
  });
}
