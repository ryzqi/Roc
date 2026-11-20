/**
 * Canonical URL contract for the single project shell.
 *
 * `page=research|settings` selects the shell or settings overlay; `project`
 * identifies its scope. `view` selects the canvas destination, `subview`
 * selects discovery or knowledge, and `tool` selects a project tool. `file`
 * carries a workspace-relative file selection. `assistant=1` and
 * `layoutPreset` describe the workspace layout without changing its destination.
 *
 * Legacy view IDs migrate only at this input boundary. Writers always emit
 * canonical IDs; parsing a written normalized route preserves every field.
 */
import { drawerSectionIds, type DrawerSectionId, type MenuIntent } from '../../shared/surfaces';

export type AppPage = 'research' | 'settings';
export const APP_VIEWS = ['overview', 'library', 'writing', 'runs'] as const;
export type AppViewId = (typeof APP_VIEWS)[number];
export type AppSubview = 'discover' | 'knowledge';
export type AppViewTarget = AppViewId | AppSubview;
export type LayoutPreset = 'research' | 'writing' | 'review';
export type WorkbenchTool = 'files' | 'git' | 'terminal' | DrawerSectionId;

export type AppRoute = {
  page: AppPage;
  projectId: string | null;
  view: AppViewId;
  subview: AppSubview | null;
  tool: WorkbenchTool | null;
  /** Workspace-relative selection; file access validates it through the existing IPC boundary. */
  openFile: string | null;
  assistantOpen: boolean;
  layoutPreset: LayoutPreset | null;
  /** One-shot request to open the portal's project form. */
  newProject: boolean;
};

export const DEFAULT_VIEW = 'overview';
export const APP_VIEW_IDS: ReadonlySet<string> = new Set(APP_VIEWS);
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

export function routeForView(target: AppViewTarget): Pick<AppRoute, 'view' | 'subview'> {
  if (target === 'discover') return { view: 'overview', subview: target };
  if (target === 'knowledge') return { view: 'library', subview: target };
  return { view: target, subview: null };
}

export function isLayoutPreset(value: unknown): value is LayoutPreset {
  return value === 'research' || value === 'writing' || value === 'review';
}

/** Previous-release bookmarks are consumed here, never registered as parallel views. */
function migrateView(value: string | null, tool: WorkbenchTool | null): Pick<AppRoute, 'view' | 'subview' | 'tool'> {
  if (value !== null && (APP_VIEW_IDS.has(value) || value === 'discover' || value === 'knowledge')) {
    return { ...routeForView(value as AppViewTarget), tool };
  }
  switch (value) {
    case 'latex': return { ...routeForView('writing'), tool };
    case 'literature': return { ...routeForView('library'), tool };
    case 'terminal': return { ...routeForView('writing'), tool: tool ?? 'terminal' };
    case 'memory':
    case 'skills':
    case 'mcp': return { ...routeForView(DEFAULT_VIEW), tool: tool ?? value };
    default: return { ...routeForView(DEFAULT_VIEW), tool };
  }
}

/** The portal cannot carry a canvas, project tool, file selection or assistant. */
export function normalizeAppRoute(route: AppRoute): AppRoute {
  const portal = route.projectId === null;
  let view = route.view;
  if (portal) view = DEFAULT_VIEW;
  else if (route.tool === 'terminal' || route.tool === 'files') view = 'writing';
  else if (route.tool === 'tasks') view = 'runs';
  const subview = !portal && ((view === 'overview' && route.subview === 'discover') ||
    (view === 'library' && route.subview === 'knowledge')) ? route.subview : null;
  return {
    page: route.page,
    projectId: route.projectId,
    view,
    subview,
    tool: portal || route.tool === 'tasks' ? null : route.tool,
    openFile: portal ? null : emptyToNull(route.openFile),
    assistantOpen: !portal && route.assistantOpen,
    layoutPreset: route.layoutPreset,
    newProject: route.page === 'research' && portal && route.newProject
  };
}

export function parseAppRoute(search: URLSearchParams): AppRoute {
  const page = search.get('page');
  const destination = migrateView(search.get('view'), parseTool(search.get('tool')));
  const subview = search.get('subview');
  const layoutPreset = search.get('layoutPreset');
  return normalizeAppRoute({
    page: page === 'settings' ? 'settings' : 'research',
    projectId: emptyToNull(search.get('project')),
    ...destination,
    subview: destination.subview ?? (subview === 'discover' || subview === 'knowledge' ? subview : null),
    openFile: emptyToNull(search.get('file')),
    assistantOpen: search.get('assistant') === '1',
    layoutPreset: isLayoutPreset(layoutPreset) ? layoutPreset : null,
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
    if (normalized.subview !== null) params.set('subview', normalized.subview);
  }
  if (normalized.tool !== null) params.set('tool', normalized.tool);
  if (normalized.openFile !== null) params.set('file', normalized.openFile);
  if (normalized.assistantOpen) params.set('assistant', '1');
  if (normalized.layoutPreset !== null) params.set('layoutPreset', normalized.layoutPreset);
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
    left.view === right.view && left.subview === right.subview && left.tool === right.tool && left.openFile === right.openFile &&
    left.assistantOpen === right.assistantOpen && left.layoutPreset === right.layoutPreset && left.newProject === right.newProject;
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
