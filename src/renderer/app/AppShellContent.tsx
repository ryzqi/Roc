import {useEffect, useRef, useState} from 'react';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import type {AppStatus} from '../../shared/types';
import {errorMessage} from './loaded-state';
import type {AppViewId, LayoutPreset} from './routes';
import {useAppRoute} from './use-app-route';
import {useContentPreferenceSync} from './use-content-preferences';
import {useLayoutPersistence} from './useLayoutPersistence';
import {useKeyboardShortcuts} from './shortcuts';
import {clearUiState, CONTENT_PREFERENCES_CHANGED} from './ui-state';
import {ViewContent} from './ViewContent';
import {WorkspaceLayout} from './WorkspaceLayout';
import {WorkspaceScopeProvider} from './workspace-scope';
import {WorkspaceCanvas} from '../canvas/WorkspaceCanvas';
import {ManagementScopeProvider} from '../management/management-scope';
import {ManagementStoresProvider} from '../management/management-stores-provider';
import {ProjectPortalView} from '../project/ProjectPortalView';
import type {RocClient} from '../shared/roc-client';
import {DelayedFallback} from '../shell/DelayedFallback';
import {ErrorBar} from '../shell/ErrorBar';
import {ActivityRail} from '../shell/ActivityRail';
import {ContextDrawer} from '../shell/ContextDrawer';
import {ArtifactDock, OverlayHost} from './OverlayHost';
import {requestArtifactInspectorChange} from '../artifacts/artifact-interactions';
import {StartupFailure, StartupLoading} from '../shell/StartupSurface';
import {WindowChrome} from '../shell/WindowChrome';
import {useThemeSync} from './hooks/useThemeSync';
import type {WindowStateResource} from '../shell/use-window-state';
import {LiteratureScopeProvider} from '../literature/literature-scope';
import {useWorkspaceController} from './workspace-controller';
import {useRunAttentionController} from './run-attention-controller';
import {usePanelController} from './panel-controller';

type BootState =
  | {status: 'loading'}
  | {status: 'failed'; message: string}
  | {status: 'ready'; appStatus: AppStatus};

// Import and mount on first demand: hidden panels must not pull Markdown into startup.
const AssistantPanel = retryableLazy(async () => ({default: (await import('../assistant/AssistantPanel')).AssistantPanel}));

/** Composes the single window; controllers own resources, object commands and run attention. */
export function AppShellContent({client, windowState}: {client: RocClient; windowState: WindowStateResource}): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({status: 'loading'});
  const {override, setOverride, cycle: cycleTheme} = useThemeSync(client, boot.status === 'ready' ? boot.appStatus.appearance : null);
  const navigation = useAppRoute();
  const {route, navigate} = navigation;
  const layout = useLayoutPersistence(route.layoutPreset ?? 'research', route.projectId);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useContentPreferenceSync();
  const workspace = useWorkspaceController(client, route);
  const {currentProject, projects, project, projectName, projectWritable, projectLoadFailed,
    inProject, boundWorkspace, workspaceBinding, gitSummary, literature} = workspace;
  const attention = useRunAttentionController(client, navigation, boundWorkspace.path, literature);
  const {assistantThreadId, setAssistantThreadId, assistantRunning, setAssistantRunning,
    assistantMounted, assistantSeed, setAssistantSeed, taskCenter} = attention;
  const panels = usePanelController(client, navigation, layout, workspace, attention);
  const {scope, managementScope, managementStoresScopeKey, managementStoresEnabled, openSearch,
    openView, openManagementSection, openProject, openSettings, openTask, openArtifact, openReviewInspector,
    openFileInCanvas, openFirstSteps, openLiterature, selectThread} = panels;

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

  const applyLayoutPreset = (next: LayoutPreset): void => {
    if (!inProject) return;
    navigate({ ...route, layoutPreset: next, assistantOpen: next !== 'writing' }, {
      onNavigated: () => layout.applyPreset(next)
    });
  };
  const closeAssistant = (): void => navigate({ ...route, assistantOpen: false });
  const toggleAssistant = (): void => {
    if (!inProject) return;
    const opening = !route.assistantOpen || (layout.mode === 'drawers' && layout.drawerOpen);
    navigate({ ...route, assistantOpen: opening }, { onNavigated: () => {
      if (opening && layout.mode === 'drawers') layout.setDrawerOpen(false);
    }});
  };
  const navigateMode = (view: AppViewId): void => {
    if (!inProject) return;
    if (view === 'runs') openManagementSection('tasks');
    else openView(view);
  };
  const toggleDrawer = (): void => {
    if (inProject) layout.toggleDrawer();
  };
  const resetLayout = (): void => {
    navigate({ ...route, assistantOpen: layout.preset === 'review' }, { onNavigated: layout.reset });
  };
  useKeyboardShortcuts({
    onToggleSidebar: toggleDrawer, onToggleAssistant: toggleAssistant, onOpenSearch: openSearch,
    onCycleTheme: cycleTheme, onLayoutPreset: applyLayoutPreset, onNavigateMode: navigateMode
  });

  if (boot.status === 'loading') {
    return <StartupLoading />;
  }
  if (boot.status === 'failed') {
    return <StartupFailure message={boot.message} />;
  }

  const activityRail = <ActivityRail view={inProject && !projectLoadFailed ? route.view : null}
    onNavigate={navigateMode} themeOverride={override} onCycleTheme={cycleTheme}
    onResetLayout={resetLayout} onOpenSettings={openSettings} />;

  return (
    <ManagementScopeProvider value={managementScope}>
      <ManagementStoresProvider
        enabled={managementStoresEnabled}
        scope={managementScope}
        scopeKey={managementStoresScopeKey}
      >
    <div
      className="app-shell flex h-full w-full flex-col bg-surface-base text-ink-primary"
      data-testid="roc-app"
      data-mode={boot.appStatus.mode}
    >
      {/* Keyboard users can jump the chrome and the sidebar in one Tab.
          Visible only while focused. */}
      <a
        href="#roc-main"
        className="sr-only rounded-control border-[0.5px] border-line bg-surface px-3 py-1 text-ink focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
        data-testid="skip-to-canvas"
      >
        跳到内容
      </a>

      <WindowChrome projectName={projectName} projectId={route.projectId} projects={projects}
        onOpenProject={openProject} onBackToPortal={() => openProject(null)} onOpenSearch={openSearch}
        sidebarCollapsed={!layout.drawerOpen} onToggleSidebar={toggleDrawer}
        assistantOpen={route.assistantOpen && !(layout.mode === 'drawers' && layout.drawerOpen)}
        onToggleAssistant={toggleAssistant} assistantRunning={assistantRunning}
        onOpenManagement={() => openManagementSection('memory')}
        onOpenGit={() => navigate({ ...route, tool: 'git' })} branchLabel={gitSummary.branch}
        gitChangeCount={gitSummary.changes} layoutPreset={layout.preset} onChangePreset={applyLayoutPreset} />

      {windowState.error === null ? null : (
        <div className="shrink-0 px-4 pt-2" data-testid="shell-window-state-error">
          <ErrorBar error={{level: 'page', message: `读取窗口状态失败：${windowState.error}`, retry: windowState.reload}} />
        </div>
      )}

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
              onClick={() => openProject(null)}
              className="h-[var(--control-height)] rounded-control border-[0.5px] border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
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
          onCloseAssistant={closeAssistant}
          inspectorOpen={panels.artifactSelection?.request.projectId === route.projectId && !route.assistantOpen}
          onCloseInspector={() => requestArtifactInspectorChange(() => panels.setArtifactSelection(null))}
          inspector={<ArtifactDock client={client} projectId={route.projectId}
            artifactSelection={panels.artifactSelection} projectWritable={projectWritable}
            artifactReadingLocations={panels.artifactReadingLocations} reviewProtocolDrafts={panels.reviewProtocolDrafts}
            onCloseArtifact={() => panels.setArtifactSelection(null)} onOpenTask={openTask} />}
          activityRail={activityRail}
          contextDrawer={
            <ContextDrawer key={route.projectId} view={route.view} client={client} projectId={route.projectId}
              projects={projects} onOpenProject={openProject} binding={boundWorkspace} writable={projectWritable}
              openFile={route.openFile} onOpenFile={openFileInCanvas} previewRequest={panels.filePreview}
              onPreviewRequestConsumed={() => panels.setFilePreview(null)} activeThreadId={assistantThreadId}
              onSelectThread={selectThread} onStartNewThread={() => selectThread(null)}
              onThreadDeleted={attention.deleteThread}
              onSelectWorkspace={workspaceBinding.bind} workspacePending={workspaceBinding.pending}
              workspaceError={workspaceBinding.error} onOpenHelp={openFirstSteps}
              onOpenWriting={() => openView('writing', () => layoutRef.current.setDrawerOpen(true))}
              onOpenLiterature={libraryItemId => openLiterature({kind: 'reader', libraryItemId})}
              onOpenTasks={() => openManagementSection('tasks')}
              taskLabel={taskCenter.label} taskSummary={taskCenter.summary}
            />
          }
          canvas={
            <div className="flex h-full min-h-0 flex-col">
              {project !== null && !projectWritable ? (
                <p
                  role="note"
                  data-testid="project-readonly-banner"
                  className="shrink-0 border-b-[0.5px] border-line bg-bg-soft px-3 py-1.5 text-[var(--st-warn)] text-[length:var(--font-meta-size)]"
                >
                  项目已归档，仅可阅读：无法启动阶段运行、修改产物或写入文件。恢复项目后才能继续。
                </p>
              ) : null}
              <WorkspaceCanvas activeTab={route.view} subview={route.subview} onTabChange={openView}>
                {/* The scope is what lazily loaded views read; the routing
                    props stay on `ViewContent` (see workspace-scope.tsx). */}
                <WorkspaceScopeProvider value={scope}>
                  <ViewContent key={route.projectId} view={route.view} subview={route.subview} projectId={route.projectId} />
                </WorkspaceScopeProvider>
              </WorkspaceCanvas>
            </div>
          }
          assistant={
            assistantMounted ? (
              <LazyBoundary label="助手加载失败" fallback={<DelayedFallback label="正在加载助手…" motion="lockstep" />}>
                <AssistantPanel
                  client={client}
                  projectId={route.projectId}
                  threadId={assistantThreadId}
                  onThreadIdChange={setAssistantThreadId}
                  showNewThread={route.view !== 'runs' || !layout.drawerOpen}
                  onOpenArtifact={openArtifact}
                  onOpenReviewInspector={openReviewInspector}
                  onOpenTask={(taskId) => {
                    if (route.projectId === null) throw new Error('research_task_project_required');
                     openTask(route.projectId, taskId);
                  }}
                  workspacePath={boundWorkspace.path}
                  projectName={projectName}
                  composerSeed={assistantSeed}
                  onComposerSeedConsumed={() => setAssistantSeed(null)}
                   onOpenSettings={openSettings}
                  // Same handler the divider's double-click and Home key use, so the
                  // header button cannot drift from the drag handle (the shell previously had it
                  // only on the divider).
                  onResetWidth={layout.resetAssistant}
                  onRunActivity={setAssistantRunning}
                />
              </LazyBoundary>
            ) : null
          }
          />
        </LiteratureScopeProvider>
      ) : (
        <div className="flex min-h-0 flex-1">
          {activityRail}
          <main id="roc-main" className="flex min-w-0 min-h-0 flex-1 flex-col" data-testid="portal-column" tabIndex={-1}>
          <ProjectPortalView
            client={client}
            createFormRequested={route.newProject}
            onRequestConsumed={(requested) => navigate({ ...route, newProject: requested })}
            onOpenProject={openProject}
          />
          </main>
        </div>
      )}

      <OverlayHost
        client={client}
        route={route}
        navigate={navigate}
        projectWritable={projectWritable}
        workspacePath={boundWorkspace.path}
        settingsMounted={panels.settingsMounted}
        settingsOpen={panels.settingsOpen}
        themeOverride={override}
        onThemeOverrideChange={setOverride}
        onResetUiPreferences={() => {
          clearUiState();
          window.dispatchEvent(new Event(CONTENT_PREFERENCES_CHANGED));
          setOverride('system');
          panels.setFirstStepsVisible(true);
        }}
        onCloseSettings={() => navigate({ ...route, page: 'research' })}
        searchOpen={panels.searchOpen}
        searchQuery={panels.searchQuery}
        onCloseSearch={() => panels.setSearchOpen(false)}
        onSearchQueryChange={panels.setSearchQuery}
        searchGroups={panels.searchGroups}
        managementMounted={panels.managementMounted}
        managementOpen={panels.managementOpen}
        managementTab={panels.managementTab}
        onCloseManagement={panels.closeManagement}
        onManagementTabChange={panels.setManagementTab}
        gitDrawerOpen={panels.gitDrawerOpen}
        gitBusy={panels.gitBusy}
        commitDrafts={panels.gitCommitDrafts}
        onGitBusyChange={panels.registerGitBusy}
      />
    </div>
      </ManagementStoresProvider>
    </ManagementScopeProvider>
  );
}
