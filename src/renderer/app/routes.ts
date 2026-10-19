/**
 * URL route contract (ADR-M05).
 *
 * `src/main/application-menu.ts` (⌘N, ⌘,) and `app.onNavigate` write these query
 * parameters, and so do deep links.
 *
 * `?page=research|settings`          outer surface
 *   `?project=<id>`                    presence means "inside a project"
 *   `?view=<canvas view>`              canvas view inside a project
 *   `?tool=files|git`                  workbench tool for files/changes/terminal views
 *   `?file=<workspace-relative path>`  file open in the files view (P3)
 *   `?assistant=1`                     assistant panel open
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
 * A missing `view` becomes the table's default (`latex`, which is what the reference defaults its
 * canvas tab to — `useState<WorkspaceTab>('latex')` in its `App`). Two earlier defaults are gone:
 * `changes` (the legacy shell) and `overview` (P2–P6, when the in-project landing view was 总览).
 *
 * ## Where the classification lives now
 *
 * `AppViewId` is not a union written here any more: it is derived from the surface table in
 * `src/shared/surfaces.ts`, which also owns the default, the legal `?view=` set, the canvas tabs and
 * the management drawer's sections. This file keeps the *URL contract* (how a route is written and
 * parsed); the table keeps the *classification* (what exists and where it lands). Splitting them is
 * what stops the copies this file used to hold from drifting apart.
 *
 * The native-menu mapping used to live here too (`routeForNavigate` — 13 branches for 4 real menu
 * items, 9 of them with no producer). It is gone: `src/shared/surfaces.ts` declares the closed
 * `MenuPage` union and its intent, and `use-app-route.ts` hands that intent to the shell — because
 * one of the four intents (打开任务) is not expressible as a route field at all.
 */

import { canvasViewIdSet, defaultViewId, isCanvasViewId, type CanvasViewId, type MenuIntent } from '../../shared/surfaces';

export type AppPage = 'research' | 'settings';

/**
 * A `?view=` value. Derived from the surface table, so adding a canvas view is one edit.
 */
export type AppViewId = CanvasViewId;

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

export const DEFAULT_VIEW: AppViewId = defaultViewId;

/**
 * Every `?view=` value the parser accepts.
 *
 * Kept as a named export because it is the historical spelling, but it **is** the table's set —
 * the same object, not a copy. (It used to be a hand-written `new Set([...])` next to a union that
 * said the same thing.)
 */
export const APP_VIEW_IDS: ReadonlySet<string> = canvasViewIdSet;

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

/**
 * A `?view=` value, or the default.
 *
 * `parked`（有契约、有数据库、没界面）与 `unknown`（从来不存在）在这里**没有**区别：两者都必须给出确定
 * 答案，因为 `parseAppRoute(writeAppRoute(r))` 得成立（ADR-M05）。区分由 `surfaces.ts` 的
 * `resolveSurface` 提供，读它的是闸门脚手架——在那一个不认识的面应当**抛错**，而不是像 P10 之后的
 * `view=overview` 那样静默落到缺省视图上通过断言（八处，见 `surfaces.ts` 头部）。
 */
function parseView(value: string | null): AppViewId {
  if (value !== null && isCanvasViewId(value)) {
    return value;
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

/**
 * 能用路由表达的那几个菜单意图。
 *
 * `management` 被排除在外：抽屉的开合与当前分区**不是** URL 字段，所以它没有路由表示。
 * 排成类型而不是让函数返回 null，是为了让这个事实变成编译期的——调用方必须先把那个分支拿走，
 * 而拿不走的时候编译器会说话。
 */
export type RoutableMenuIntent = Exclude<MenuIntent, { kind: 'management' }>;

/**
 * 一个菜单意图落到路由上的结果。
 *
 * 这个函数换来了一件旧实现做不到的事：⌘N 在项目内被忽略、⌘, 打开设置、全局热键打开助手——
 * 三条都能写成纯函数，于是在没有渲染器的情况下可以断言"每条都产出一个能往返的路由"。
 * 旧的那个（`routeForNavigate`，十三个分支）把不可表达的那一条也宣成成功：托盘「打开任务」
 * 返回当前路由，`sameAppRoute` 再把它当无变化丢掉，菜单项于是什么都不做。
 */
export function routeForMenuIntent(intent: RoutableMenuIntent, current: AppRoute): AppRoute {
  const base = normalizeAppRoute(current);
  if (intent.kind === 'settings') {
    return normalizeAppRoute({ ...base, page: 'settings' });
  }
  if (intent.kind === 'new-project') {
    // ⌘N 在项目内被忽略，与旧壳一致。
    if (base.projectId !== null) {
      return base;
    }
    return normalizeAppRoute({ ...base, page: 'research', newProject: true, view: DEFAULT_VIEW });
  }
  return normalizeAppRoute({
    ...base,
    page: 'research',
    view: 'literature',
    assistantOpen: base.projectId !== null
  });
}
