import { lazy, Suspense, useEffect, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { errorMessage } from './loaded-state';
import type { AppViewId } from './routes';
import { useAppNavigateBridge, useAppRoute } from './use-app-route';
import { useLayoutState } from './use-layout-state';
import { useKeyboardShortcuts } from './shortcuts';
import { purgeLegacyStorage } from './ui-state';
import { ViewContent } from './ViewContent';
import { WorkspaceLayout } from './WorkspaceLayout';
import { WorkspaceCanvas, type CanvasTabId } from '../canvas/WorkspaceCanvas';
import type { ManagementTabId } from '../management/ManagementPanel';
import { ProjectPortalView } from '../project/ProjectPortalView';
import { useCurrentProject } from '../project/use-projects';
import { useProjectWorkspace } from '../project/use-project-workspace';
import { isProjectWritable } from '../project/project-store';
import type { RocClient } from '../shared/roc-client';
import { DelayedFallback } from '../shell/DelayedFallback';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { LeftSidebar } from '../shell/LeftSidebar';
import { ModalShell } from '../shell/ModalShell';
import { SearchPaletteModal, type SearchGroup } from '../shell/SearchPaletteModal';
import { StartupFailure, StartupLoading } from '../shell/StartupSurface';
import { WindowChrome } from '../shell/WindowChrome';
import { useAppearanceOverride, useAppearanceSync } from '../shell/appearance';
import { useTraySummaryLabel } from '../shell/use-tray-summary';
import { useWindowState } from '../shell/use-window-state';

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
 * Search groups in P1. Every domain reports *why* it is unavailable rather than
 * showing an empty result that implies "nothing matched". P5/T5.8 replaces each
 * entry with a real concurrent query that degrades on its own.
 */
const P1_SEARCH_GROUPS: SearchGroup[] = [
  { id: 'projects', label: '项目', status: 'unavailable', items: [], unavailableReason: 'P2 接入 research.projects.list' },
  { id: 'literature', label: '文献', status: 'unavailable', items: [], unavailableReason: 'P5 接入 research.library.list' },
  { id: 'files', label: '文件', status: 'unavailable', items: [], unavailableReason: 'P3 接入 files.searchByName' },
  { id: 'sessions', label: '会话', status: 'unavailable', items: [], unavailableReason: 'P4 接入 agent.sessions.search' },
  { id: 'skills', label: '技能', status: 'unavailable', items: [], unavailableReason: 'P9 接入 skills.list' },
  { id: 'concepts', label: '概念', status: 'unavailable', items: [], unavailableReason: 'P5 接入派生 wiki' },
  { id: 'artifacts', label: '产物', status: 'unavailable', items: [], unavailableReason: 'P6 接入 research.artifacts.list' }
];

export function AppShell({ client }: { client: RocClient }): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementTab, setManagementTab] = useState<ManagementTabId>('memory');
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

  const reloadCurrentProject = currentProject.reload;
  const workspaceBinding = useProjectWorkspace(client, project, reloadCurrentProject);

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

  const gitDrawerOpen = route.tool === 'git';

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
              projectName={projectName ?? route.projectId ?? ''}
              workspacePath={project?.workspacePath ?? null}
              onSelectWorkspace={workspaceBinding.bind}
              workspacePending={workspaceBinding.pending}
              workspaceError={workspaceBinding.error}
              onBackToPortal={() => navigate({ ...route, projectId: null, view: 'overview' })}
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
                onTabChange={(tab) => navigate({ ...route, view: tab })}
              >
                <ViewContent
                  view={route.view}
                  projectId={route.projectId}
                  stageHint={route.view === 'stage' ? route.stageTab : null}
                />
              </WorkspaceCanvas>
            </div>
          }
          assistant={
            assistantMounted ? (
              <Suspense fallback={<DelayedFallback label="正在加载助手…" />}>
                <AssistantPanel
                  projectName={projectName}
                  onOpenSettings={() => navigate({ ...route, page: 'settings' })}
                />
              </Suspense>
            ) : null
          }
        />
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
        groups={P1_SEARCH_GROUPS}
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
        <EmptyState
          title="尚无工作区改动"
          description="绑定项目工作目录后，这里显示分支、暂存区与提交。"
          testId="git-placeholder"
        />
        <p className="px-6 text-center text-[var(--font-micro-size)] text-subtle">
          P3 接入 git.status / git.diffStat / git.fileDiff
        </p>
      </ModalShell>
    </div>
  );
}
