import { createContext, useContext } from 'react';
import type { AppViewTarget, WorkbenchTool } from './routes';
import type { RocClient } from '../shared/roc-client';
import type { WorkspaceBindingStatus } from '../workspace/use-bound-workspace';
import type {OpenResearchArtifact, OpenReviewInspector} from '../artifacts/artifact-interactions';
import type {ChatStartRunResult} from '../../shared/types';

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

export type LiteratureOpenTarget =
  | { kind: 'concept'; claimId: string }
  | { kind: 'reader'; libraryItemId: string | null; parseId?: string | null;
      locator?: string | null; text?: string | null; returnToSearch?: boolean };

/** One accepted object-opening command, consumed by the retained literature host. */
export type LiteratureOpenRequest = {
  projectId: string;
  nonce: number;
  target: LiteratureOpenTarget;
};

/** Internal handoff from a current request after chat.startRun returns its receipt. */
export type AdoptAcceptedRun = (input: {
  projectId: string; workspacePath: string; receipt: ChatStartRunResult;
}) => void;

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
   * Needed by panels that must *not* own a configuration: RAG's index
   * and embedding settings only show their effective values and send the user
   * here. Navigation itself stays in the shell, so the route contract has one
   * writer.
   */
  openSettings: () => void;
  firstStepsVisible: boolean;
  firstStepsRequestId: number;
  openFirstSteps: () => void;
  dismissFirstSteps: () => void;
  /** Whether project context is visible, so canvas views can avoid duplicate navigation. */
  contextDrawerOpen: boolean;
  /**
   * Navigates the canvas to another view in the same project.
   *
   * The shell writes the route, including any discovery or knowledge subview.
   */
  openView: (view: AppViewTarget, onNavigated?: () => void) => void;
  openLiterature: (target: LiteratureOpenTarget) => void;
  literatureRequest: LiteratureOpenRequest | null;
  consumeLiteratureRequest: (nonce: number) => void;
  tool: WorkbenchTool | null;
  openTool: (tool: WorkbenchTool | null) => void;
  openTasks: (taskId?: string) => void;
  /** Open the current project's composer without starting a run. */
  openAssistant: () => void;
  adoptAcceptedRun: AdoptAcceptedRun;
  openReviewInspector: OpenReviewInspector;
  openArtifact: OpenResearchArtifact;
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
