/**
 * Canonical URL contract for the single project shell.
 *
 * `page=research|settings` selects the shell or settings overlay; `project`
 * identifies its scope. `view` selects one of five canvas destinations, `tool`
 * selects a project tool, `file` carries a workspace-relative file selection,
 * and `assistant=1` opens the assistant without changing the destination.
 *
 * Legacy view IDs migrate only at this input boundary. Writers always emit
 * canonical IDs; parsing a written normalized route preserves every field.
 */
import {
  canvasViewIdSet, defaultViewId, drawerSectionIds, isCanvasViewId,
  type CanvasViewId, type DrawerSectionId, type MenuIntent
} from '../../shared/surfaces';

export type AppPage = 'research' | 'settings';
export type AppViewId = CanvasViewId;
export type WorkbenchTool = 'files' | 'git' | 'terminal' | DrawerSectionId;

export type AppRoute = {
  page: AppPage;
  projectId: string | null;
  view: AppViewId;
  tool: WorkbenchTool | null;
  /** Workspace-relative selection; file access validates it through the existing IPC boundary. */
  openFile: string | null;
  assistantOpen: boolean;
  /** One-shot request to open the portal's project form. */
  newProject: boolean;
};

export const DEFAULT_VIEW: AppViewId = defaultViewId;
export const APP_VIEW_IDS: ReadonlySet<string> = canvasViewIdSet;
export const WORKBENCH_TOOLS: ReadonlySet<WorkbenchTool> = new Set<WorkbenchTool>([
  'files', 'git', 'terminal', ...drawerSectionIds
]);

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

function parseTool(value: string | null): WorkbenchTool | null {
  return value !== null && WORKBENCH_TOOLS.has(value as WorkbenchTool) ? value as WorkbenchTool : null;
}

/** Previous-release bookmarks are consumed here, never registered as parallel views. */
function migrateView(value: string | null, tool: WorkbenchTool | null): Pick<AppRoute, 'view' | 'tool'> {
  if (value !== null && isCanvasViewId(value)) return { view: value, tool };
  switch (value) {
    case 'latex': return { view: 'writing', tool };
    case 'literature': return { view: 'library', tool };
    case 'terminal': return { view: 'writing', tool: tool ?? 'terminal' };
    case 'memory':
    case 'skills':
    case 'mcp': return { view: DEFAULT_VIEW, tool: tool ?? value };
    default: return { view: DEFAULT_VIEW, tool };
  }
}

/** The portal cannot carry a canvas, project tool, file selection or assistant. */
export function normalizeAppRoute(route: AppRoute): AppRoute {
  const portal = route.projectId === null;
  return {
    page: route.page,
    projectId: route.projectId,
    view: portal ? DEFAULT_VIEW : route.tool === 'terminal' ? 'writing' : route.view,
    tool: portal ? null : route.tool,
    openFile: portal ? null : emptyToNull(route.openFile),
    assistantOpen: !portal && route.assistantOpen,
    newProject: route.page === 'research' && portal && route.newProject
  };
}

export function parseAppRoute(search: URLSearchParams): AppRoute {
  const page = search.get('page');
  return normalizeAppRoute({
    page: page === 'settings' ? 'settings' : 'research',
    projectId: emptyToNull(search.get('project')),
    ...migrateView(search.get('view'), parseTool(search.get('tool'))),
    openFile: emptyToNull(search.get('file')),
    assistantOpen: search.get('assistant') === '1',
    newProject: page === 'research-new'
  });
}

export function readAppRoute(): AppRoute {
  return parseAppRoute(new URLSearchParams(window.location.search));
}

export function appRouteToSearch(route: AppRoute): string {
  const normalized = normalizeAppRoute(route);
  const params = new URLSearchParams();
  params.set('page', normalized.page === 'settings' ? 'settings' : normalized.newProject ? 'research-new' : 'research');
  if (normalized.projectId !== null) {
    params.set('project', normalized.projectId);
    params.set('view', normalized.view);
  }
  if (normalized.tool !== null) params.set('tool', normalized.tool);
  if (normalized.openFile !== null) params.set('file', normalized.openFile);
  if (normalized.assistantOpen) params.set('assistant', '1');
  return params.toString();
}

export function writeAppRoute(route: AppRoute, mode: 'replace' | 'push' = 'replace'): void {
  const url = new URL(window.location.href);
  url.search = appRouteToSearch(route);
  if (mode === 'push') {
    window.history.pushState({}, '', url);
  } else {
    window.history.replaceState({}, '', url);
  }
}

export function sameAppRoute(left: AppRoute, right: AppRoute): boolean {
  return left.page === right.page && left.projectId === right.projectId &&
    left.view === right.view && left.tool === right.tool && left.openFile === right.openFile &&
    left.assistantOpen === right.assistantOpen && left.newProject === right.newProject;
}

/** Management intents are handled by the shell's shared drawer controller. */
export type RoutableMenuIntent = Exclude<MenuIntent, { kind: 'management' }>;

export function routeForMenuIntent(intent: RoutableMenuIntent, current: AppRoute): AppRoute {
  const base = normalizeAppRoute(current);
  if (intent.kind === 'settings') return normalizeAppRoute({ ...base, page: 'settings' });
  if (intent.kind === 'new-project') {
    if (base.projectId !== null) return base;
    return normalizeAppRoute({ ...base, page: 'research', newProject: true, view: DEFAULT_VIEW });
  }
  return normalizeAppRoute({ ...base, page: 'research', assistantOpen: base.projectId !== null });
}
