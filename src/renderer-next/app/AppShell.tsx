import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { AppStatus } from '../../shared/types';import { errorMessage } from './loaded-state';
import type { AppViewId } from './routes';
import { useAppNavigateBridge, useAppRoute } from './use-app-route';
import { useLayoutState } from './use-layout-state';
import { useKeyboardShortcuts } from './shortcuts';
import { purgeLegacyStorage } from './ui-state';
import { ViewContent } from './ViewContent';
import { WorkspaceLayout } from './WorkspaceLayout';
import { WorkspaceScopeProvider, type WorkspaceScope } from './workspace-scope';
import { WorkspaceCanvas, type CanvasTabId } from '../canvas/WorkspaceCanvas';
import type { ManagementTabId } from '../management/ManagementPanel';
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

const PRIMARY_TABS: ReadonlySet<AppViewId> = new Set<AppViewId>(['literature', 'latex', 'terminal']);

function canvasTabForView(view: AppViewId): CanvasTabId | null {
  return PRIMARY_TABS.has(view) ? (view as CanvasTabId) : null;
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
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementTab, setManagementTab] = useState<ManagementTabId>('memory');
  // The selected conversation lives here because two surfaces need it: the sidebar lists
  // threads, the assistant panel renders one. Cleared when the project changes (gate 6).
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  // Mount-on-demand latches; see the lazy block comment above.
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [managementMounted, setManagementMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);

  const { override, cycle: cycleTheme } = useAppearanceOverride();
  const { route, navigate } = useAppRoute();
  const layout = useLayoutState();
  const windowState = useWindowState(client);
  // The chrome and the read-only gate need the real project, not the raw id.
  const currentProject = useCurrentProject(client, route.projectId);

  useAppNavigateBridge(client, { route, navigate });
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

  const openFileInCanvas = (relativePath: string): void => {
    // `tool: 'files'` explicitly rather than `route.tool ?? 'files'`: opening a file
    // from the tree is the files workbench, so it must not inherit `git` (which would
    // pop the Git drawer over the preview the user just asked for).
    navigate({ ...route, view: 'files', tool: 'files', openFile: relativePath });
  };

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
      openFileInCanvas
    }),
    [
      client,
      route.projectId,
      route.openFile,
      projectName,
      projectWritable,
      boundWorkspace.path,
      boundWorkspace.status,
      boundWorkspace.error,
      boundWorkspace.rebind
    ]
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
    }
  });

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
    onOpenSearch: () => setSearchOpen(true),
    onCycleTheme: cycleTheme,
    projectViewSlotsEnabled: inProject,
    onProjectViewSlot: (slot) => {
      const view: AppViewId = slot === 1 ? 'overview' : slot === 2 ? 'activity' : 'provenance';
      navigate({ ...route, view });
    }
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
   * `?tool=git` drives the drawer, which is what P1 built and the capability
   * matrix documents. The canvas `changes` view renders the same `GitPanel` in its
   * wide layout, so when that view is already on screen the drawer stays closed —
   * otherwise both would mount, each with its own `useGitWorkspace` (two sets of
   * status/diffStat/listBranches calls and two states that disagree after an
   * action).
   */
  const gitDrawerOpen = route.tool === 'git' && route.view !== 'changes';

  return (
    <div
      className={boot.appStatus.mode === 'smoke' ? 'app-shell app-shell--smoke flex h-full w-full flex-col bg-bg text-ink' : 'app-shell flex h-full w-full flex-col bg-bg text-ink'}
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
        onBackToPortal={() => navigate({ ...route, projectId: null, view: 'overview' })}
        onOpenSearch={() => setSearchOpen(true)}
        sidebarCollapsed={layout.sidebarCollapsed}
        onToggleSidebar={layout.toggleSidebar}
        assistantOpen={route.assistantOpen}
        onToggleAssistant={toggleAssistant}
        onOpenGit={() => navigate({ ...route, view: 'changes', tool: 'git' })}
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
              onClick={() => navigate({ ...route, projectId: null, view: 'overview' })}
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
              activeThreadId={assistantThreadId}
              onSelectThread={setAssistantThreadId}
              onStartNewThread={() => setAssistantThreadId(null)}
              onThreadDeleted={(threadId) =>
                setAssistantThreadId((current) => (current === threadId ? null : current))
              }
              onSelectWorkspace={workspaceBinding.bind}
              workspacePending={workspaceBinding.pending}
              workspaceError={workspaceBinding.error}
              onBackToPortal={() => navigate({ ...route, projectId: null, view: 'overview' })}
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
                  // Switching tabs retargets the workbench tool instead of leaving
                  // the previous one open behind an unrelated view (the terminal
                  // tab carries its own tool; the other two carry none). No canvas
                  // tab is the files view, so this cannot drop an open file.
                  navigate({ ...route, view: tab, tool: tab === 'terminal' ? 'terminal' : null })
                }
              >
                {/* The scope is what lazily loaded views read; the routing
                    props stay on `ViewContent` (see workspace-scope.tsx). */}
                <WorkspaceScopeProvider value={scope}>
                  <ViewContent
                    view={route.view}
                    projectId={route.projectId}
                    stageHint={route.view === 'stage' ? route.stageTab : null}
                  />
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
                  onOpenSettings={() => navigate({ ...route, page: 'settings' })}
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
            onOpenProject={(projectId) => navigate({ ...route, projectId, view: 'overview' }, { mode: 'push' })}
          />
        </main>
      )}

      {settingsMounted ? (
        <Suspense fallback={<DelayedFallback label="正在加载设置…" />}>
          <SettingsModal
            open={settingsOpen}
            onClose={() => navigate({ ...route, page: 'research' })}
            dirtyCount={0}
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
  );
}
