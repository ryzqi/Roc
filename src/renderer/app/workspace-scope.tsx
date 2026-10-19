import { createContext, useContext } from 'react';
import type { AppViewId } from './routes';
import type { RocClient } from '../shared/roc-client';
import type { WorkspaceBindingStatus } from '../workspace/use-bound-workspace';

/**
 * The project/workspace scope a canvas view renders inside (P3).
 *
 * Deliberately **not** part of `ViewProps`: those are route-derived (`view`,
 * `projectId`), and a view must be able to stay mounted while the
 * route's query parameters change. Scope is different — it is the identity of the
 * thing being viewed, and every P3–P9 view needs the same four facts:
 *
 *   - `client`            the IPC handle
 *   - `workspacePath`     the workspace the backend is **actually** bound to
 *                         (`useBoundWorkspace`), not the raw project field
 *   - `writable`          the P2 archived-project predicate; the single gate for
 *                         every write action
 *   - `openFile`          the workspace-relative file open in the files view
 *
 * Passing these down as props through `ViewContent` would make that component a
 * funnel that grows with every phase, and a lazily loaded view would receive
 * props it does not need. A context keeps the routing contract and the data scope
 * separate, which is the same split the shell already makes.
 */

export type WorkspaceScope = {
  client: RocClient;
  projectId: string | null;
  projectTitle: string | null;
  writable: boolean;
  /** Absolute path of the bound workspace, or null when nothing is bound. */
  workspacePath: string | null;
  workspaceStatus: WorkspaceBindingStatus;
  workspaceError: string | null;
  /** Retry the workspace binding after a failure. */
  rebindWorkspace: () => void;
  /** Workspace-relative path open in the files view (route `?file=`). */
  openFile: string | null;
  /** Navigates the canvas to the files view with this file open. */
  openFileInCanvas: (relativePath: string) => void;
  /**
   * Opens the settings centre.
   *
   * Needed by panels that must *not* own a configuration (ADR-M09): RAG's index
   * and embedding settings only show their effective values and send the user
   * here. Navigation itself stays in the shell, so the route contract has one
   * writer.
   */
  openSettings: () => void;
  /**
   * Navigates the canvas to another view in the same project.
   *
   * Navigation, not state: the view is a URL field (ADR-M05) and only the shell
   * writes the route. Without this a view would have to synthesise a URL — which is
   * how a second writer of the route contract appears. The literature hub's jump to
   * the files view is the remaining caller.
   */
  openView: (view: AppViewId) => void;
};

const WorkspaceScopeContext = createContext<WorkspaceScope | null>(null);

export const WorkspaceScopeProvider = WorkspaceScopeContext.Provider;

/**
 * Throws rather than returning null: a view rendered outside a project scope is a
 * wiring bug, and a silent empty render would hide it until the view looked
 * broken for an unrelated reason.
 */
export function useWorkspaceScope(): WorkspaceScope {
  const scope = useContext(WorkspaceScopeContext);
  if (scope === null) {
    throw new Error('workspace_scope_missing: 画布视图必须在项目作用域内渲染。');
  }
  return scope;
}
