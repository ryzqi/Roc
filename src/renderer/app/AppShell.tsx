import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { canvasViewForDrawerSection, isCanvasTabId, type DrawerSectionId, type MenuIntent } from '../../shared/surfaces';
import { errorMessage } from './loaded-state';
import { DEFAULT_VIEW, routeForMenuIntent, type AppViewId } from './routes';
import { useMenuIntentBridge, useAppRoute } from './use-app-route';
import { useLayoutState } from './use-layout-state';
import { useKeyboardShortcuts } from './shortcuts';
import { clearUiState, purgeLegacyStorage } from './ui-state';
import { ViewContent } from './ViewContent';
import { WorkspaceLayout } from './WorkspaceLayout';
import { WorkspaceScopeProvider, type WorkspaceScope } from './workspace-scope';
import { WorkspaceCanvas, type CanvasTabId } from '../canvas/WorkspaceCanvas';
import type { ManagementTabId } from '../management/use-management-stores';
import { ManagementScopeProvider, type ManagementScope } from '../management/management-scope';
import { ProjectPortalView } from '../project/ProjectPortalView';
import { useCurrentProject } from '../project/use-projects';
import { useProjectWorkspace } from '../project/use-project-workspace';
import { isProjectWritable } from '../project/project-store';
import type { RocClient } from '../shared/roc-client';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ErrorBar } from '../shell/ErrorBar';
import { LeftSidebar } from '../shell/LeftSidebar';
import { ModalShell } from '../shell/ModalShell';
import { SearchPaletteModal } from '../shell/SearchPaletteModal';
import { useSearchGroups } from '../shell/use-search-groups';
import { StartupFailure, StartupLoading } from '../shell/StartupSurface';
import { WindowChrome } from '../shell/WindowChrome';
import { useAppearanceOverride, useAppearanceSync } from '../shell/appearance';
import { useTraySummaryLabel } from '../shell/use-tray-summary';
import { useWindowState } from '../shell/use-window-state';
import { useBoundWorkspace } from '../workspace/use-bound-workspace';
import { LiteratureScopeProvider } from '../literature/literature-scope';
import { useLiteratureStore } from '../literature/use-literature-store';
import { deriveWiki } from '../literature/derive-wiki';

/**
 * The application shell (P1).
 *
 * Responsibilities, in order:
 *   1. boot gate — `app.getStatus` decides loading / failed / ready
 *   2. appearance — system snapshot + in-app override drive the token layer
 *   3. navigation — the URL is the single source of truth (ADR-M05); the native
 *      menu arrives through `app.onNavigate`
 *   4. layout — three columns with persisted widths and ADR-M12 breakpoints
 *   5. overlays — settings (URL-driven), search, management, Git
 *
 * Deliberately *not* here: any product data. Projects, literature, files and
 * sessions arrive in P2–P9; this shell proves the frame, the routing contract,
 * focus/Escape layering, and the shortcut split with the native menu.
 *
 * The window's own controls are system traffic lights
 * (`titleBarStyle: 'hiddenInset'`), so nothing is drawn for them.
 */

type BootState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; appStatus: AppStatus };

/**
 * Whether the routed view is one of the three canvas tabs.
 *
 * The tab list lives in the surface table and it comes with a type guard, so this is a narrowing
 * rather than a cast over a locally-kept copy of the list (which is what it used to be: a
 * `PRIMARY_TABS` set here, an `APP_VIEW_IDS` set in `routes.ts`, a `TABS` array in
 * `WorkspaceCanvas`, each covering a different part of the same fact).
 */
function canvasTabForView(view: AppViewId): CanvasTabId | null {
  return isCanvasTabId(view) ? view : null;
}

/**
 * Lazily loaded overlays and panels.
 *
 * Two things have to be true for these imports, and both are easy to get wrong:
 *
 *   1. **They must be `import()`**, because `check-renderer-chunks.mjs` forbids
 *      `markdown|streamdown|highlight|settings` from the eager graph (R4 /
 *      ADR-M11). The assistant pulls in the whole Markdown + KaTeX family in P4
 *      and settings pulls in every section in P8, so the boundary has to exist
 *      before those phases land.
 *   2. **They must be mounted on demand.** `React.lazy` starts fetching on first
 *      *render*, not first open, so a lazy element left in the tree with only a
 *      falsy `open` prop still downloads at boot — which would fetch the
 *      assistant's Markdown bundle at startup even though the assistant defaults
 *      to closed. The `latch` below defers the first render until something
 *      actually opens, then keeps the subtree mounted so state and scroll
 *      position survive toggling.
 *
 * The manifest also only inspects *static* imports, so a stray eager import here
 * would pass the check while defeating it. Keeping these lazy is a discipline.
 */
const AssistantPanel = lazy(async () => ({ default: (await import('../assistant/AssistantPanel')).AssistantPanel }));
const SettingsModal = lazy(async () => ({ default: (await import('../settings/SettingsModal')).SettingsModal }));
const ManagementPanel = lazy(async () => ({ default: (await import('../management/ManagementPanel')).ManagementPanel }));
/**
 * The Git drawer pulls in `react-diff-view` (a manual chunk, ~50 KB). It is lazy
 * for the same reason as the panels above, and it needs no mount latch: the
 * drawer's `ModalShell` renders `null` while closed, so the module is only
 * fetched when the drawer actually opens.
 */
const GitPanel = lazy(async () => ({ default: (await import('../canvas/git/GitPanel')).GitPanel }));

export function AppShell({ client }: { client: RocClient }): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  /**
   * Bumped on every palette open so the ⌘K groups re-read what can change while
   * the palette is closed (the project list has no server-side query to key on).
   */
  const [searchToken, setSearchToken] = useState(0);
  const openSearch = useCallback((): void => {
    setSearchToken((current) => current + 1);
    setSearchOpen(true);
  }, []);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementTab, setManagementTab] = useState<ManagementTabId>('memory');
  /**
   * A prompt handed to the assistant's composer by the management drawer (P9/T9.1).
   *
   * The drawer must not start a run itself: run state, the transcript and the HITL cards live in
   * the assistant panel, so a run started from a drawer would be invisible. The nonce makes the
   * hand-off idempotent per request (the same text twice still replaces the draft).
   */
  const [assistantSeed, setAssistantSeed] = useState<{ text: string; nonce: number } | null>(null);
  const assistantSeedNonceRef = useRef(0);
  // The selected conversation lives here because two surfaces need it: the sidebar lists
  // threads, the assistant panel renders one. Cleared when the project changes (gate 6).
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  // Mount-on-demand latches; see the lazy block comment above.
  const [assistantMounted, setAssistantMounted] = useState(false);
  /** A file another surface asked the 文件 tab to preview (see `openFileInCanvas`). */
  const [filePreview, setFilePreview] = useState<{ relativePath: string; nonce: number } | null>(null);
  const previewNonceRef = useRef(0);
  const [managementMounted, setManagementMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);

  const { override, setOverride, cycle: cycleTheme } = useAppearanceOverride();
  const { route, navigate } = useAppRoute();
  const layout = useLayoutState();

  /**
   * `?tool=files` as a one-shot request to show the 文件 tab.
   *
   * The file tree lives in the sidebar now, so the native menu's "文件/工作区" item has nothing
   * to open in the canvas — what it means is "put me in front of the tree". Handled on the
   * *transition* into `files`, not on the value: forcing the tab while the parameter is present
   * would make 会话 unreachable until the URL changed.
   */
  const previousToolRef = useRef(route.tool);
  const previousViewRef = useRef(route.view);
  useEffect(() => {
    if (route.tool === 'files' && previousToolRef.current !== 'files') {
      layout.setSidebarTab('files');
    }
    /**
     * Changing the canvas view dismisses the drawer.
     *
     * The scrim covers the canvas, so a view change while it is up can only come from outside
     * the drawer — a tab click, a deep link, another surface's navigation. Leaving the drawer
     * open would put it on top of the view the user just asked for, with the canvas unreachable
     * behind it and nothing on screen explaining why. Same reasoning as the canvas tab strip's
     * own 「clear the tool on tab change」.
     */
    if (route.view !== previousViewRef.current && route.tool !== null) {
      navigate({ ...route, tool: null });
    }
    previousToolRef.current = route.tool;
    previousViewRef.current = route.view;
  }, [route, layout, navigate]);

  const windowState = useWindowState(client);
  // The chrome and the read-only gate need the real project, not the raw id.
  const currentProject = useCurrentProject(client, route.projectId);

  useAppearanceSync(client, boot.status === 'ready' ? boot.appStatus.appearance : null, override);

  const backgroundRunLabel = useTraySummaryLabel(client, windowState.hidden);

  const inProject = route.projectId !== null;
  const settingsOpen = route.page === 'settings';
  const project = currentProject.data;
  const projectName = project?.title ?? null;
  const projectWritable = isProjectWritable(project);
  /**
   * A project that failed to load must not silently render an empty workspace.
   * ADR-M07: surface the backend message with a retry instead of pretending the
   * project exists (a stale deep link or a deleted project is the common case).
   */
  const projectLoadFailed = inProject && currentProject.status === 'error';

  // A conversation belongs to one project, so a project switch drops the selection.
  useEffect(() => {
    setAssistantThreadId(null);
  }, [route.projectId]);

  const reloadCurrentProject = currentProject.reload;
  const workspaceBinding = useProjectWorkspace(client, project, reloadCurrentProject);
  // T3.1: the project's `workspacePath` is inert data until `workspace.select`
  // scopes the backend to it. Every file/Git/terminal call is keyed on the
  // **bound** path, so a project switch rebuilds all three (gate 6).
  const boundWorkspace = useBoundWorkspace(client, project);

  /**
   * The literature store lives here, not in the literature view.
   *
   * The sidebar's 文献 tab and the canvas hub are siblings in different subtrees,
   * and T5.1 requires them to share one state: importing from the canvas must show
   * up in the sidebar, and selecting in one must select in the other. Creating the
   * store once and providing it (like the workspace scope in P3) is what makes
   * "shared" structural rather than a convention.
   */
  const literature = useLiteratureStore(client, route.projectId);

  /**
   * Latest route, readable from callbacks that live inside the memoised scope.
   *
   * `navigate` compares against its own ref and writes the URL, but merging a change
   * into the *current* route needs that route at call time. Reading `route` from the
   * closure would freeze whatever was current when the scope was built: switching the
   * canvas view does not change `projectId`/`openFile`, so the memo would not
   * recompute and 「打开设置中心」 would merge `page=settings` into the view the user
   * had left. (Opening a file had the same shape but overwrites `view`, so it was
   * invisible there.)
   */
  const routeRef = useRef(route);
  routeRef.current = route;

  /**
   * Asks the 文件 tab to reveal a file **and open its preview**.
   *
   * There is no canvas `files` view any more (the reference opens files from the sidebar tree
   * and shows the preview in a modal), so "open a file" is two things now:
   *
   *   1. `?file=` — the URL field the tree reads to reveal and select the row (ADR-M05);
   *   2. a nonce the 文件 tab compares against the last one it saw, because which overlay is on
   *      screen is view state, not navigation, and the panel that owns the modal is mounted
   *      inside the sidebar.
   *
   * Selection and reveal also have to make the 文件 tab *visible*: asking for a file from the
   * literature hub while the 会话 tab is open would otherwise set a selection nobody can see.
   * `view` and `tool` are deliberately left alone — touching `tool` would pop the Git drawer
   * over the preview the user just asked for.
   */
  const openFileInCanvas = (relativePath: string): void => {
    layout.setSidebarTab('files');
    previewNonceRef.current += 1;
    setFilePreview({ relativePath, nonce: previewNonceRef.current });
    navigate({ ...routeRef.current, openFile: relativePath });
  };

  /**
   * Opens one management section, on the host it actually has.
   *
   * 记忆 / 技能 / MCP exist twice (canvas view and drawer section), so which one the user gets is a
   * decision, and it used to be written out twice — once for the drawer's own entry and once for the
   * ⌘K palette, with the two copies already drifting (one merged into `routeRef.current`, the other
   * into a captured `route`). 任务 has **only** the drawer: ADR 0024 removed the task board because
   * two surfaces over one dataset diverge, so there is no canvas view to fall back to.
   */
  const openManagementSection = useCallback(
    (section: DrawerSectionId): void => {
      const canvasView = canvasViewForDrawerSection(section);
      if (canvasView === null) {
        setManagementTab(section);
        setManagementOpen(true);
        return;
      }
      // Closing the drawer is part of the jump: both are `fixed inset-0 z-50` portals, and the
      // drawer's width would cover the canvas view it just asked for.
      setManagementOpen(false);
      navigate({ ...routeRef.current, view: canvasView });
    },
    [navigate]
  );

  /**
   * The shell's handling of the four things the native menu, the tray and the global hotkey can ask
   * for (`src/shared/surfaces.ts` owns the list and the meaning of each).
   *
   * Three of them are pure route changes, so they live in `routes.routeForMenuIntent` where they can
   * be asserted without a renderer. The fourth is 打开任务, and it is the reason this handler exists
   * at all: a route cannot carry "open the management drawer on its 任务 section", and the old
   * implementation expressed that by returning the *current* route — which `navigate`'s
   * `sameAppRoute` early-return then dropped, so the tray item only raised the window while its own
   * comment claimed the drawer was opened. `RoutableMenuIntent` excludes that case at the type
   * level, so this branch cannot be forgotten again.
   */
  const handleMenuIntent = useCallback(
    (intent: MenuIntent): void => {
      if (intent.kind === 'management') {
        openManagementSection(intent.section);
        return;
      }
      navigate(routeForMenuIntent(intent, routeRef.current));
    },
    [navigate, openManagementSection]
  );

  useMenuIntentBridge(client, handleMenuIntent);

  /**
   * The canvas data scope (P3). Memoised because every view reads it and a new
   * identity on each render would re-render them all on unrelated shell state
   * changes (the tray label updates on background task ticks).
   */
  const scope = useMemo<WorkspaceScope>(
    () => ({
      client,
      projectId: route.projectId,
      projectTitle: projectName,
      writable: projectWritable,
      workspacePath: boundWorkspace.path,
      workspaceStatus: boundWorkspace.status,
      workspaceError: boundWorkspace.error,
      rebindWorkspace: boundWorkspace.rebind,
      openFile: route.openFile,
      openFileInCanvas,
      // Closing the drawer is part of the jump: both are `fixed inset-0 z-50` portals, and the
      // drawer's width would cover the settings panel it just asked for.
      openSettings: () => {
        setManagementOpen(false);
        navigate({ ...routeRef.current, page: 'settings' });
      },
      openView: (view) => navigate({ ...routeRef.current, view })
    }),
    [
      client,
      route.projectId,
      route.openFile,
      navigate,
      projectName,
      projectWritable,
      boundWorkspace.path,
      boundWorkspace.status,
      boundWorkspace.error,
      boundWorkspace.rebind
    ]
  );

  /**
   * The management scope (P9/T9.5).
   *
   * Built once for the same structural reason as the literature and workflow scopes: the drawer and
   * the three canvas views are siblings in different subtrees, and both need the four datasets plus
   * the two actions that leave the management surface. `routeRef` is read at call time so a
   * hand-off merges into the *current* route rather than the one captured when this memo was built.
   */
  const managementScope = useMemo<ManagementScope>(
    () => ({
      client,
      projectId: route.projectId,
      workspacePath: boundWorkspace.path,
      onOpenThread: (threadId) => {
        setAssistantThreadId(threadId);
        setManagementOpen(false);
        navigate({ ...routeRef.current, assistantOpen: true });
      },
      onAskAssistant: (prompt) => {
        assistantSeedNonceRef.current += 1;
        setAssistantSeed({ text: prompt, nonce: assistantSeedNonceRef.current });
        setManagementOpen(false);
        navigate({ ...routeRef.current, assistantOpen: true });
      },
      // Closing the drawer is part of the jump: both are `fixed inset-0 z-50` portals, and the
      // drawer's width would cover the settings panel it just asked for.
      openSettings: () => {
        setManagementOpen(false);
        navigate({ ...routeRef.current, page: 'settings' });
      },
      openManagementView: openManagementSection
    }),
    [client, route.projectId, boundWorkspace.path, navigate, openManagementSection]
  );

  /**
   * Concept rows for the ⌘K 概念 group.
   *
   * Derived with the same `deriveWiki` the 知识库 panel renders, from the same
   * claims/evidence snapshot the store already holds — so the palette cannot claim
   * a concept the panel would not show. Empty until the project's claims/evidence
   * have loaded, which the group's own wording says.
   */
  const conceptRows = useMemo(() => {
    const claims = literature.claims;
    const evidence = literature.evidence;
    if (claims === null || evidence === null) {
      return [];
    }
    return deriveWiki({ claims, evidence, libraryItems: literature.items }).pages.map((page) => ({
      id: page.claimId,
      label: page.title,
      subtitle: page.evidence.length === 0 ? '尚无引用证据' : `引用 ${page.evidence.length} 条证据`
    }));
  }, [literature.claims, literature.evidence, literature.items]);

  const searchGroups = useSearchGroups({
    client,
    query: searchQuery,
    workspacePath: boundWorkspace.path,
    openFile: openFileInCanvas,
    projectId: route.projectId,
    libraryItems: literature.items,
    concepts: conceptRows,
    conceptsLoaded: literature.claims !== null && literature.evidence !== null,
    onOpenLiterature: (libraryItemId) => {
      literature.select(libraryItemId);
      navigate({ ...route, view: 'literature' });
    },
    onOpenConcept: () => {
      navigate({ ...route, view: 'literature' });
    },
    onOpenProject: (projectId) => {
      navigate({ ...route, projectId, view: DEFAULT_VIEW }, { mode: 'push' });
    },
    onOpenManagementView: openManagementSection,
    onOpenSession: (threadId) => {
      setAssistantThreadId(threadId);
      navigate({ ...route, assistantOpen: true });
    },
    searchToken
  });

  /**
   * Adopts the thread a literature-triggered run landed in.
   *
   * The reader's 「问助手」 button calls `chat.startRun` (from the shared store) and
   * the run therefore exists **before** the panel is mounted; selecting the thread
   * and opening the panel is what lets P4's `getActiveRun` + event replay pick the
   * running run up. Navigation stays here because the URL has one writer
   * (ADR-M05) — the store only reports which thread to show.
   */
  const literatureAssistantThreadId = literature.assistant.threadId;
  useEffect(() => {
    if (literatureAssistantThreadId === null) {
      return;
    }
    setAssistantThreadId(literatureAssistantThreadId);
    navigate({ ...route, assistantOpen: true });
    literature.adoptAssistantThread();
  }, [literature, literatureAssistantThreadId, navigate, route]);

  // Cleanup of pre-migration keys. Deliberately not a compatibility layer:
  // nothing reads these values, we just stop them from accumulating.
  useEffect(() => {
    purgeLegacyStorage();
  }, []);

  useEffect(() => {
    if (managementOpen) {
      setManagementMounted(true);
    }
  }, [managementOpen]);

  useEffect(() => {
    if (settingsOpen) {
      setSettingsMounted(true);
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (inProject && route.assistantOpen) {
      setAssistantMounted(true);
    }
  }, [inProject, route.assistantOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.api.app.getStatus();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setBoot({ status: 'failed', message: result.error.message });
          return;
        }
        setBoot({ status: 'ready', appStatus: result.data });
      } catch (error) {
        if (!cancelled) {
          setBoot({ status: 'failed', message: errorMessage(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const toggleAssistant = (): void => {
    navigate({ ...route, assistantOpen: !route.assistantOpen });
  };

  useKeyboardShortcuts({
    onToggleSidebar: layout.toggleSidebar,
    onToggleAssistant: toggleAssistant,
    onOpenSearch: openSearch,
    onCycleTheme: cycleTheme
  });

  if (boot.status === 'loading') {
    return <StartupLoading />;
  }
  if (boot.status === 'failed') {
    return <StartupFailure message={boot.message} />;
  }

  /**
   * The Git surface is rendered **once** (M-2).
   *
   * `?tool=git` drives the drawer, and now it is the **only** Git surface: the canvas
   * `changes` view is gone, so there is no second `GitPanel` to keep from mounting at the
   * same time (two instances meant two `useGitWorkspace` states that disagreed after an
   * action). The reference opens Git as a drawer, and so does this shell.
   */
  const gitDrawerOpen = route.tool === 'git';

  return (
    <ManagementScopeProvider value={managementScope}>
    <div
      className="app-shell flex h-full w-full flex-col bg-bg text-ink"
      data-testid="roc-app"
      data-mode={boot.appStatus.mode}
    >
      {/* Keyboard users can jump the chrome and the sidebar in one Tab
          (MASTER v2 §9). Visible only while focused. */}
      <a
        href="#roc-main"
        className="sr-only rounded-control border border-line bg-surface px-3 py-1 text-ink focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
        data-testid="skip-to-canvas"
      >
        跳到内容
      </a>

      <WindowChrome
        projectName={projectName}
        onBackToPortal={() => navigate({ ...route, projectId: null, view: DEFAULT_VIEW })}
        onOpenSearch={openSearch}
        sidebarCollapsed={layout.sidebarCollapsed}
        onToggleSidebar={layout.toggleSidebar}
        assistantOpen={route.assistantOpen}
        onToggleAssistant={toggleAssistant}
        onOpenGit={() => navigate({ ...route, tool: 'git' })}
        onOpenManagement={() => {
          setManagementTab('memory');
          setManagementOpen(true);
        }}
        onOpenSettings={() => navigate({ ...route, page: 'settings' })}
        backgroundRunLabel={backgroundRunLabel}
      />

      {projectLoadFailed ? (
        <main id="roc-main" className="flex min-h-0 flex-1 flex-col p-4" data-testid="project-load-error" tabIndex={-1}>
          <ErrorBar
            error={{
              level: 'page',
              message: currentProject.error ?? '读取当前科研项目失败',
              retry: currentProject.reload,
              actionLabel: '也可以返回项目列表'
            }}
          />
          <div className="mt-2">
            <button
              type="button"
              data-testid="project-load-error-back"
              onClick={() => navigate({ ...route, projectId: null, view: DEFAULT_VIEW })}
              className="h-[var(--control-height)] rounded-control border border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
            >
              返回项目列表
            </button>
          </div>
        </main>
      ) : inProject ? (
        // One literature store for the sidebar's 文献 tab and the canvas hub (T5.1):
        // the provider sits *above* the layout so both subtrees read the same state.
        <LiteratureScopeProvider value={literature}>
          <WorkspaceLayout
          layout={layout}
          assistantOpen={route.assistantOpen}
          onToggleSidebar={layout.toggleSidebar}
          onToggleAssistant={toggleAssistant}
          assistantAvailable
          sidebar={
            <LeftSidebar
              activeTab={layout.sidebarTab}
              onTabChange={layout.setSidebarTab}
              client={client}
              projectId={route.projectId}
              projectName={projectName ?? route.projectId ?? ''}
              binding={boundWorkspace}
              writable={projectWritable}
              openFile={route.openFile}
              onOpenFile={openFileInCanvas}
              previewRequest={filePreview}
              // The request is one-shot: once the 文件 tab has adopted it, it must stop existing, so a
              // remount cannot re-deliver it into a workspace whose files are different. This panel is
              // keyed on the bound path (`LeftSidebar`), so a project switch does remount it — see
              // `FileSidebarPanel`'s adopt effect for the failure that produced.
              onPreviewRequestConsumed={() => setFilePreview(null)}
              activeThreadId={assistantThreadId}
              onSelectThread={setAssistantThreadId}
              onStartNewThread={() => setAssistantThreadId(null)}
              onThreadDeleted={(threadId) =>
                setAssistantThreadId((current) => (current === threadId ? null : current))
              }
              onSelectWorkspace={workspaceBinding.bind}
              workspacePending={workspaceBinding.pending}
              workspaceError={workspaceBinding.error}
              onBackToPortal={() => navigate({ ...route, projectId: null, view: DEFAULT_VIEW })}
              onOpenLiterature={(libraryItemId) => {
                // The sidebar tab has already selected the row in the shared store;
                // re-selecting is a no-op (`setState` with the same value bails out)
                // and keeps this callback correct if it is ever called without that
                // first step.
                if (libraryItemId !== null) {
                  literature.select(libraryItemId);
                }
                navigate({ ...route, view: 'literature' });
              }}
              themeOverride={override}
              onCycleTheme={cycleTheme}
              onOpenManagement={() => {
                setManagementTab('memory');
                setManagementOpen(true);
              }}
            />
          }
          canvas={
            <div className="flex h-full min-h-0 flex-col">
              {project !== null && !projectWritable ? (
                <p
                  role="note"
                  data-testid="project-readonly-banner"
                  className="shrink-0 border-b border-line bg-bg-soft px-3 py-1.5 text-[var(--st-warn)] text-[var(--font-meta-size)]"
                >
                  项目已归档，仅可阅读：无法启动阶段运行、修改产物或写入文件。恢复项目后才能继续。
                </p>
              ) : null}
              <WorkspaceCanvas
                activeTab={canvasTabForView(route.view)}
                onTabChange={(tab) =>
                  // Switching canvas tabs clears the drawer tool rather than leaving it open
                  // behind an unrelated view — a `?tool=git` that survived a tab click would sit
                  // over the terminal with no way to tell why. No canvas tab is the files view,
                  // so this cannot drop an open file.
                  navigate({ ...route, view: tab, tool: null })
                }
              >
                {/* The scope is what lazily loaded views read; the routing
                    props stay on `ViewContent` (see workspace-scope.tsx). */}
                <WorkspaceScopeProvider value={scope}>
                  <ViewContent view={route.view} projectId={route.projectId} />
                </WorkspaceScopeProvider>
              </WorkspaceCanvas>
            </div>
          }
          assistant={
            assistantMounted ? (
              <Suspense fallback={<DelayedFallback label="正在加载助手…" />}>
                <AssistantPanel
                  client={client}
                  projectId={route.projectId}
                  threadId={assistantThreadId}
                  onThreadIdChange={setAssistantThreadId}
                  workspacePath={boundWorkspace.path}
                  projectName={projectName}
                  composerSeed={assistantSeed}
                  onComposerSeedConsumed={() => setAssistantSeed(null)}
                  onOpenSettings={() => navigate({ ...route, page: 'settings' })}
                  // Same handler the divider's double-click and Home key use, so the
                  // header button cannot drift from the drag handle (reference has it
                  // in the header; the shell had it only on the divider).
                  onResetWidth={layout.resetAssistant}
                />
              </Suspense>
            ) : null
          }
          />
        </LiteratureScopeProvider>
      ) : (
        <main id="roc-main" className="flex min-h-0 flex-1 flex-col" data-testid="portal-column" tabIndex={-1}>
          <ProjectPortalView
            client={client}
            createFormRequested={route.newProject}
            onRequestConsumed={(requested) => navigate({ ...route, newProject: requested })}
            onOpenProject={(projectId) => navigate({ ...route, projectId, view: DEFAULT_VIEW }, { mode: 'push' })}
          />
        </main>
      )}

      {settingsMounted ? (
        <Suspense fallback={<DelayedFallback label="正在加载设置…" />}>
          <SettingsModal
            open={settingsOpen}
            client={client}
            projectId={route.projectId}
            workspacePath={boundWorkspace.path}
            themeOverride={override}
            onThemeOverrideChange={setOverride}
            // 「重置本地界面偏好」 is the only writer of `roc.ui.*` outside ui-state.ts's
            // own helpers, so the live appearance override has to be reset here too —
            // otherwise the DOM keeps an override whose stored value was just deleted.
            onResetUiPreferences={() => {
              clearUiState();
              setOverride('system');
            }}
            onClose={() => navigate({ ...route, page: 'research' })}
          />
        </Suspense>
      ) : null}

      <SearchPaletteModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        groups={searchGroups}
      />

      {managementMounted ? (
        <Suspense fallback={<DelayedFallback label="正在加载管理面板…" />}>
          <ManagementPanel
            open={managementOpen}
            onClose={() => setManagementOpen(false)}
            activeTab={managementTab}
            onTabChange={setManagementTab}
          />
        </Suspense>
      ) : null}

      <ModalShell
        open={gitDrawerOpen}
        kind="drawer"
        title="Git"
        onClose={() => navigate({ ...route, tool: null })}
        widthClassName="w-[520px]"
        testId="git-drawer"
      >
        <Suspense fallback={<DelayedFallback label="正在加载 Git 面板…" />}>
          <GitPanel
            client={client}
            workspacePath={boundWorkspace.path}
            writable={projectWritable}
            layout="drawer"
          />
        </Suspense>
      </ModalShell>
    </div>
    </ManagementScopeProvider>
  );
}
