/**
 * URL route contract (ADR-M05).
 *
 * `src/main/application-menu.ts` (⌘N, ⌘,) and `app.onNavigate` write these query
 * parameters, and so do deep links.
 *
 *   ?page=research|settings          outer surface
 *   ?project=<id>                    presence means "inside a project"
 *   ?view=<canvas view>              canvas view inside a project
 *   ?tool=files|git|terminal         workbench tool for files/changes/terminal views
 *   ?file=<workspace-relative path>  file open in the files view (P3)
 *   ?assistant=1                     assistant panel open
 *
 * `page=research-new` (menu "新建研究项目") is normalised to `page=research`
 * plus `newProject=1`, which the portal uses to expand the create form.
 *
 * `?stage=<group|tab|workflow-stage>` used to be part of this contract. The stage
 * surface was removed so the canvas matches the reference's information architecture
 * (one strip: 文献 / LaTeX / 终端), so the parameter is **no longer read or written**.
 * An incoming `?stage=` is simply ignored, which is why the native menu and any stale
 * deep link keep working without a backend change.
 *
 * ## Round-trip guarantee
 *
 * `normalizeAppRoute` is the single source of truth for the invariants:
 * `parseAppRoute(writeAppRoute(r))` and `writeAppRoute(parseAppRoute(q))` both
 * preserve every field of an already-normalized route. Both directions apply
 * the same normalizer, so the URL never encodes state the parser would drop.
 *
 * ## Default view
 *
 * A missing `view` becomes `latex`, which is what the reference defaults its canvas
 * tab to (`useState<WorkspaceTab>('latex')` in its `App`). Two earlier defaults are
 * gone: `changes` (the legacy shell) and `overview` (P2–P6, when the in-project
 * landing view was 总览).
 */

export type AppPage = 'research' | 'settings';

export type AppViewId =
  | 'literature'
  | 'latex'
  | 'terminal'
  | 'mcp'
  | 'skills'
  | 'memory';

/**
 * Route-selected *auxiliary surface*.
 *
 * `git` opens the top-bar Git drawer; `files` asks the sidebar to show its 文件 tab. Both sit
 * beside the canvas rather than in it, which is why they are not view ids.
 *
 * `terminal` used to be here as well. The terminal is a canvas tab, so the marker was
 * redundant — and worse, it was *sticky*: because a tool no longer belongs to a view, a route
 * that carried `tool=terminal` could not express “close the Git drawer and show the terminal”
 * at the same time as `tool=git`. Removing it makes `view=terminal` mean exactly that.
 */
export type WorkbenchTool = 'files' | 'git';

/**
 * Workspace-**relative** path revealed and selected in the sidebar's file tree, or null.
 *
 * Navigation state, not product data: it is what a "which file am I looking at" deep link
 * means, so it lives in the URL. It used to name the canvas `files` view as its host; that
 * view is gone and the sidebar tree reads the parameter instead, which is why
 * `viewCarriesOpenFile` now answers `false` for every view and why this is the one route
 * field the normaliser keeps regardless of `view`.
 */
export type AppRoute = {
  page: AppPage;
  projectId: string | null;
  view: AppViewId;
  tool: WorkbenchTool | null;
  /**
   * Workspace-**relative** path open in the files view (P3), or null.
   *
   * This is navigation state, not product data: it is what a "which file am I
   * looking at" deep link means, and it lives in the URL for the same reason
   * `stage` used to — a reload must land on the same file, and the path is refused
   * locally if it tries to escape the workspace (R10).
   */
  openFile: string | null;
  assistantOpen: boolean;
  /** Only ever true transiently: the create form is expanded on arrival. */
  newProject: boolean;
};

export const DEFAULT_VIEW: AppViewId = 'latex';

/**
 * Every canvas view is project-scoped: with no project selected the shell shows
 * the portal, so the view parameter is normalised away. (There is deliberately
 * no global, project-less canvas view yet.)
 */
export const APP_VIEW_IDS: ReadonlySet<AppViewId> = new Set<AppViewId>([
  'literature',
  'latex',
  'terminal',
  'mcp',
  'skills',
  'memory'
]);

export const WORKBENCH_TOOLS: ReadonlySet<WorkbenchTool> = new Set<WorkbenchTool>(['files', 'git']);

function emptyToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parsePage(value: string | null): { page: AppPage; newProject: boolean } {
  if (value === 'settings') {
    return { page: 'settings', newProject: false };
  }
  if (value === 'research-new') {
    return { page: 'research', newProject: true };
  }
  return { page: 'research', newProject: false };
}

function parseView(value: string | null): AppViewId {
  if (value !== null && APP_VIEW_IDS.has(value as AppViewId)) {
    return value as AppViewId;
  }
  return DEFAULT_VIEW;
}

function parseTool(value: string | null): WorkbenchTool | null {
  if (value !== null && WORKBENCH_TOOLS.has(value as WorkbenchTool)) {
    return value as WorkbenchTool;
  }
  return null;
}

/**
 * Collapses a route onto the set of states the URL can actually represent.
 *
 * Anything the writer would silently drop is dropped here instead, so that
 * `sameAppRoute(normalize(r), parseAppRoute(writeAppRoute(r)))` is always true.
 */
export function normalizeAppRoute(route: AppRoute): AppRoute {
  const page: AppPage = route.page;
  // The portal cannot show a canvas view, a drawer tool or the assistant.
  const projectId = route.projectId;
  const portal = projectId === null;

  const view: AppViewId = portal ? DEFAULT_VIEW : route.view;
  // Tools are no longer view-scoped: `?tool=git` and `?tool=files` select a **drawer**, and the
  // reference opens both from the top bar while any canvas view stays on screen. `terminal` is
  // still a view and still carries its tool (the tab is the terminal's own). The portal is the one
  // place with no chrome to open a drawer from, so it clears the tool the way it clears the view.
  const tool: WorkbenchTool | null = portal ? null : route.tool;
  // Kept regardless of `view`: it is the sidebar tree's selection, not a view parameter (ADR-M05
  // note above). The `portal` half is the only thing that clears it.
  const openFile = portal ? null : emptyToNull(route.openFile);
  // `newProject` is a one-shot *request* to open the portal's create form, so it
  // is only meaningful on a project-less portal. The form's open state and its
  // draft are component state in `ProjectPortalView`; that is what keeps an
  // accidental ⌘, from discarding typed input (settings is an overlay, so the
  // portal stays mounted underneath). Keeping it out of the URL also keeps
  // parse∘write identity, since `page` can only hold one value.
  const newProject = page === 'research' && portal ? route.newProject : false;

  return {
    page,
    projectId,
    view,
    tool,
    openFile,
    // The assistant lives in a project; with no project it cannot be open.
    assistantOpen: portal ? false : route.assistantOpen,
    newProject
  };
}

export function parseAppRoute(search: URLSearchParams): AppRoute {
  const parsedPage = parsePage(search.get('page'));
  return normalizeAppRoute({
    page: parsedPage.page,
    projectId: emptyToNull(search.get('project')),
    view: parseView(search.get('view')),
    tool: parseTool(search.get('tool')),
    openFile: emptyToNull(search.get('file')),
    assistantOpen: search.get('assistant') === '1',
    newProject: parsedPage.newProject
  });
}

export function readAppRoute(): AppRoute {
  return parseAppRoute(new URLSearchParams(window.location.search));
}

export function appRouteToSearch(route: AppRoute): string {
  const normalized = normalizeAppRoute(route);
  const params = new URLSearchParams();

  if (normalized.page === 'settings') {
    params.set('page', 'settings');
  } else if (normalized.newProject) {
    params.set('page', 'research-new');
  } else {
    params.set('page', 'research');
  }

  if (normalized.projectId !== null) {
    params.set('project', normalized.projectId);
    // Written explicitly, never implied: the parser's default differs from the
    // legacy shell's (see the header comment).
    params.set('view', normalized.view);
  }

  if (normalized.tool !== null) {
    params.set('tool', normalized.tool);
  }

  if (normalized.openFile !== null) {
    params.set('file', normalized.openFile);
  }

  if (normalized.assistantOpen) {
    params.set('assistant', '1');
  }

  return params.toString();
}

/**
 * Writes the route with `replaceState`, matching the legacy `syncRendererUrl`
 * behaviour so the assistant panel toggle does not flood history.
 */
export function writeAppRoute(route: AppRoute, mode: 'replace' | 'push' = 'replace'): void {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    // A malformed location must never take the view down.
    return;
  }

  url.search = appRouteToSearch(route);

  if (mode === 'push') {
    window.history.pushState({}, '', url);
    return;
  }
  window.history.replaceState({}, '', url);
}

export function sameAppRoute(left: AppRoute, right: AppRoute): boolean {
  if (
    left.page !== right.page ||
    left.projectId !== right.projectId ||
    left.view !== right.view ||
    left.tool !== right.tool ||
    left.openFile !== right.openFile ||
    left.assistantOpen !== right.assistantOpen ||
    left.newProject !== right.newProject
  ) {
    return false;
  }
  return true;
}

/** Entry-point mapping for `app.onNavigate` payloads from the native menu. */
export function routeForNavigate(page: string, current: AppRoute): AppRoute {
  const base = normalizeAppRoute(current);
  if (page === 'settings') {
    return normalizeAppRoute({ ...base, page: 'settings' });
  }
  if (page === 'research-new') {
    // The legacy shell ignored ⌘N while already inside a project.
    if (base.projectId !== null) {
      return base;
    }
    return normalizeAppRoute({ ...base, page: 'research', newProject: true, view: DEFAULT_VIEW });
  }
  if (page === 'chat') {
    return normalizeAppRoute({
      ...base,
      page: 'research',
      view: 'literature',
      assistantOpen: base.projectId !== null
    });
  }
  if (page === 'tasks' || page === 'tasks-board') {
    // 后台任务 has one home in this shell: the management drawer's 任务 tab. The native
    // menu item is honoured by opening that rather than a second canvas surface, which
    // would be a second writer over one dataset.
    return normalizeAppRoute({ ...base, page: 'research' });
  }
  if (page === 'workspace' || page === 'files') {
    // `?tool=files` now selects a **drawer** rather than a canvas view: the file tree lives
    // in the sidebar and the preview opens in a modal, as in the reference.
    return normalizeAppRoute({ ...base, page: 'research', view: 'literature', tool: 'files' });
  }
  if (page === 'git') {
    // Likewise: `?tool=git` drives the drawer, and the wide change view is gone.
    return normalizeAppRoute({ ...base, page: 'research', view: 'literature', tool: 'git' });
  }
  if (page === 'terminal') {
    // No tool marker: the terminal is a canvas tab, and a sticky `tool` would keep whatever
    // drawer was open on top of it.
    return normalizeAppRoute({ ...base, page: 'research', view: 'terminal', tool: null });
  }
  if (page === 'memory' || page === 'mcp' || page === 'skills') {
    return normalizeAppRoute({ ...base, page: 'research', view: page });
  }
  if (page === 'research') {
    return normalizeAppRoute({ ...base, page: 'research' });
  }
  return base;
}
