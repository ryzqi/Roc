import {
  RESEARCH_STAGE_GROUPS,
  STAGE_GROUP_IDS,
  STAGE_TAB_IDS,
  defaultTabForGroup,
  stageGroupForStage,
  type ResearchStageGroupId,
  type ResearchStageTab
} from '../canvas/workflow/stage-groups';

/**
 * URL route contract, preserved from the legacy shell (ADR-M05).
 *
 * `src/main/application-menu.ts` (⌘N, ⌘,) and `app.onNavigate` write these query
 * parameters, and so do deep links. Changing the shape would require touching
 * the backend, which the migration forbids.
 *
 *   ?page=research|settings          outer surface
 *   ?project=<id>                    presence means "inside a project"
 *   ?view=<canvas view>              canvas view inside a project
 *   ?stage=<group|tab|workflow stage> only meaningful when view=stage
 *   ?tool=files|git|terminal         workbench tool for files/changes/terminal views
 *   ?file=<workspace-relative path>  file open in the files view (P3)
 *   ?assistant=1                     assistant panel open
 *
 * `page=research-new` (menu "新建研究项目") is normalised to `page=research`
 * plus `newProject=1`, which the portal uses to expand the create form.
 *
 * ## Round-trip guarantee
 *
 * `normalizeAppRoute` is the single source of truth for the invariants:
 * `parseAppRoute(writeAppRoute(r))` and `writeAppRoute(parseAppRoute(q))` both
 * preserve every field of an already-normalized route. Both directions apply
 * the same normalizer, so the URL never encodes state the parser would drop.
 *
 * ## One deliberate divergence from the legacy shell
 *
 * The legacy shell made `view=changes` implicit and defaulted a missing `view`
 * to `changes`. This module defaults to `overview` instead, because
 * design-system/MASTER.md v2 §0 and P2/P6 both fix the in-project landing view
 * as 总览 (falling back to 文献中心 until P6 lands the overview). The parameter
 * *meanings* are unchanged; only the default view differs, and it is written
 * explicitly rather than implied.
 */

export type AppPage = 'research' | 'settings';

export type AppViewId =
  | 'overview'
  | 'stage'
  | 'activity'
  | 'provenance'
  | 'changes'
  | 'literature'
  | 'latex'
  | 'terminal'
  | 'files'
  | 'tasks'
  | 'diagnostics'
  | 'mcp'
  | 'skills'
  | 'memory';

export type WorkbenchTool = 'files' | 'git' | 'terminal';

export type AppRoute = {
  page: AppPage;
  projectId: string | null;
  view: AppViewId;
  stageGroup: ResearchStageGroupId;
  stageTab: ResearchStageTab;
  tool: WorkbenchTool | null;
  /**
   * Workspace-**relative** path open in the files view (P3), or null.
   *
   * This is navigation state, not product data: it is what a "which file am I
   * looking at" deep link means, and it lives in the URL for the same reason
   * `stage` does — a reload must land on the same file, and the path is refused
   * locally if it tries to escape the workspace (R10).
   */
  openFile: string | null;
  assistantOpen: boolean;
  /** Only ever true transiently: the create form is expanded on arrival. */
  newProject: boolean;
};

export const DEFAULT_VIEW: AppViewId = 'overview';

/**
 * Every canvas view is project-scoped: with no project selected the shell shows
 * the portal, so the view parameter is normalised away. (There is deliberately
 * no global, project-less canvas view yet.)
 */
export const APP_VIEW_IDS: ReadonlySet<AppViewId> = new Set<AppViewId>([
  'overview',
  'stage',
  'activity',
  'provenance',
  'changes',
  'literature',
  'latex',
  'terminal',
  'files',
  'tasks',
  'diagnostics',
  'mcp',
  'skills',
  'memory'
]);

export const WORKBENCH_TOOLS: ReadonlySet<WorkbenchTool> = new Set<WorkbenchTool>(['files', 'git', 'terminal']);

/** Views that carry a workbench tool selection. */
const TOOL_BEARING_VIEWS: ReadonlySet<AppViewId> = new Set<AppViewId>(['files', 'changes', 'terminal']);

export function viewCarriesTool(view: AppViewId): boolean {
  return TOOL_BEARING_VIEWS.has(view);
}

/** Only the files view can have a file open in it. */
export function viewCarriesOpenFile(view: AppViewId): boolean {
  return view === 'files';
}

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

function parseStage(value: string | null): { group: ResearchStageGroupId; tab: ResearchStageTab } {
  if (value === null || value.trim().length === 0) {
    return { group: 'discover', tab: defaultTabForGroup('discover') };
  }
  if (STAGE_GROUP_IDS.has(value as ResearchStageGroupId)) {
    const group = value as ResearchStageGroupId;
    return { group, tab: defaultTabForGroup(group) };
  }
  if (STAGE_TAB_IDS.has(value as ResearchStageTab)) {
    const tab = value as ResearchStageTab;
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.tabs.some((entry) => entry.id === tab))?.id ?? 'discover';
    return { group, tab };
  }
  const workflowStage = RESEARCH_STAGE_GROUPS.flatMap((item) => item.stages).find((stage) => stage === value);
  if (workflowStage !== undefined) {
    const group = stageGroupForStage(workflowStage);
    return { group, tab: defaultTabForGroup(group) };
  }
  return { group: 'discover', tab: defaultTabForGroup('discover') };
}

function parseTool(value: string | null): WorkbenchTool | null {
  if (value !== null && WORKBENCH_TOOLS.has(value as WorkbenchTool)) {
    return value as WorkbenchTool;
  }
  return null;
}

/**
 * Makes a (group, tab) pair canonical.
 *
 * The URL can only carry one of the two, so a pair whose tab belongs to a
 * different group than the one given is ambiguous and would not survive a
 * round-trip. The tab is the finer-grained selector, so it wins.
 */
function normalizeStagePair(
  group: ResearchStageGroupId,
  tab: ResearchStageTab
): { group: ResearchStageGroupId; tab: ResearchStageTab } {
  if (STAGE_TAB_IDS.has(tab)) {
    const owner = RESEARCH_STAGE_GROUPS.find((item) => item.tabs.some((entry) => entry.id === tab));
    if (owner !== undefined) {
      return { group: owner.id, tab };
    }
  }
  if (STAGE_GROUP_IDS.has(group)) {
    return { group, tab: defaultTabForGroup(group) };
  }
  return { group: 'discover', tab: defaultTabForGroup('discover') };
}

/**
 * Collapses a route onto the set of states the URL can actually represent.
 *
 * Anything the writer would silently drop is dropped here instead, so that
 * `sameAppRoute(normalize(r), parseAppRoute(writeAppRoute(r)))` is always true.
 */
export function normalizeAppRoute(route: AppRoute): AppRoute {
  const page: AppPage = route.page;
  // The portal cannot show a canvas view, a tool, the assistant, or a stage.
  const projectId = route.projectId;
  const portal = projectId === null;

  const view: AppViewId = portal ? DEFAULT_VIEW : route.view;
  const parsedStage = view === 'stage' ? normalizeStagePair(route.stageGroup, route.stageTab) : parseStage(null);
  const tool: WorkbenchTool | null = viewCarriesTool(view) ? route.tool : null;
  // The open file belongs to the files view only; any other view drops it, which
  // is what keeps `parse(write(r))` stable for the fields that remain.
  const openFile = viewCarriesOpenFile(view) && !portal ? emptyToNull(route.openFile) : null;
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
    stageGroup: parsedStage.group,
    stageTab: parsedStage.tab,
    tool,
    openFile,
    // The assistant lives in a project; with no project it cannot be open.
    assistantOpen: portal ? false : route.assistantOpen,
    newProject
  };
}

export function parseAppRoute(search: URLSearchParams): AppRoute {
  const parsedPage = parsePage(search.get('page'));
  const parsedStage = parseStage(search.get('stage'));
  return normalizeAppRoute({
    page: parsedPage.page,
    projectId: emptyToNull(search.get('project')),
    view: parseView(search.get('view')),
    stageGroup: parsedStage.group,
    stageTab: parsedStage.tab,
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

  if (normalized.view === 'stage') {
    const stageValue =
      normalized.stageTab === defaultTabForGroup(normalized.stageGroup) ? normalized.stageGroup : normalized.stageTab;
    params.set('stage', stageValue);
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
  if (left.view !== 'stage') {
    return true;
  }
  return left.stageGroup === right.stageGroup && left.stageTab === right.stageTab;
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
      view: 'changes',
      assistantOpen: base.projectId !== null
    });
  }
  if (page === 'tasks' || page === 'tasks-board') {
    return normalizeAppRoute({ ...base, page: 'research', view: 'tasks' });
  }
  if (page === 'workspace' || page === 'files') {
    return normalizeAppRoute({ ...base, page: 'research', view: 'files', tool: 'files' });
  }
  if (page === 'git') {
    return normalizeAppRoute({ ...base, page: 'research', view: 'changes', tool: 'git' });
  }
  if (page === 'terminal') {
    return normalizeAppRoute({ ...base, page: 'research', view: 'terminal', tool: 'terminal' });
  }
  if (page === 'memory' || page === 'mcp' || page === 'skills' || page === 'diagnostics') {
    return normalizeAppRoute({ ...base, page: 'research', view: page });
  }
  if (page === 'research') {
    return normalizeAppRoute({ ...base, page: 'research' });
  }
  return base;
}
