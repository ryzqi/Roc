import { Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  AppStatus,
  RtkStatus,
  TaskSnapshot,
  WindowBoundsSnapshot,
  WindowStateSnapshot,
  Workspace
} from '../shared/types';
import {
  emptyMemoryData,
  emptyOperationsData,
  emptyWorkspaceData,
  idleLazyLoadState
} from './app/empty-states';
import {
  buildControlNavItems,
  buildHistoryItems,
  buildHistoryNavItems,
  buildWorkspaceNavItems
} from './app/nav-items';
import { SidebarNavGroup } from './app/sidebar/SidebarNavGroup';
import { WindowWorkband } from './app/WindowWorkband';
import type {
  LazyLoadState,
  MemoryData,
  MainViewId,
  OperationsData,
  ViewId,
  WorkbenchTool,
  WorkspaceData
} from './app/types';
import {
  WORKBENCH_VIEWS,
  buildTopMeta,
  defaultWorkbenchTool,
  isFloatingView,
  parseViewId,
  parseWorkbenchTool,
  syncRendererUrl,
  visibleWorkspaceLabel
} from './app/view-routing';
import {
  loadMemoryData,
  loadOperationsData,
  loadSettingsState,
  loadTaskSurfaceData,
  loadWorkspaceData
} from './app/data-loading';
import { useLazyStartupResource } from './app/use-lazy-startup-resource';
import { useWindowDrag } from './app/use-window-drag';
import { PreviewIcon } from './components/PreviewIcon';
import { filterHistoryItems } from './history-sidebar';
import type { LoadedState } from './loaded-state';
import { unwrap } from './loaded-state';
import { SettingsView } from './settings';
import { SettingsModal } from './settings/settings-modal';
import { getStartupLoadIntent } from './startup-load-policy';
import { sanitizeTestId } from './utils/sanitize-test-id';
import { ViewContent } from './views/ViewContent';
import { RailOverlay } from './workbench/RailOverlay';
import { WorkbenchPanel } from './workbench/WorkbenchPanel';
import '@xterm/xterm/css/xterm.css';
import 'react-diff-view/style/index.css';

type HistoryContextMenuState = {
  threadId: string;
  x: number;
  y: number;
};

export function App(): React.JSX.Element {
  const initialParams = new URLSearchParams(window.location.search);
  const initialView = parseViewId(initialParams.get('page'));
  const [activeView, setActiveView] = useState<ViewId>(initialView === 'settings' ? 'chat' : initialView);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(initialView === 'settings');
  const [state, setState] = useState<LoadedState | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [chatSelectionVersion, setChatSelectionVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [historyContextMenu, setHistoryContextMenu] = useState<HistoryContextMenuState | null>(null);
  const [workspaceSelectError, setWorkspaceSelectError] = useState<string | null>(null);
  const [activeWorkbenchTool, setActiveWorkbenchTool] = useState<WorkbenchTool>(
    parseWorkbenchTool(initialParams.get('tool'), initialView)
  );
  const [workbenchVisible, setWorkbenchVisible] = useState(
    initialView === 'chat' ? initialParams.has('tool') : WORKBENCH_VIEWS.has(initialView)
  );
  const [workbenchWidth, setWorkbenchWidth] = useState(560);
  const [chatSidebarCollapsed, setChatSidebarCollapsed] = useState(false);
  const [historySearchVisible, setHistorySearchVisible] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [windowState, setWindowState] = useState<WindowStateSnapshot>({
    maximized: false,
    minimized: false,
    fullscreen: false
  });
  const [workspaceLoadState, setWorkspaceLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [memoryLoadState, setMemoryLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [operationsLoadState, setOperationsLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const historySearchInputRef = useRef<HTMLInputElement | null>(null);

  const refreshTaskState = useCallback(async (): Promise<void> => {
    const [taskSnapshot, taskSurfaceData] = await Promise.all([window.roc.tasks.getSnapshot(), loadTaskSurfaceData()]);
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
            ...taskSurfaceData
          }
    );
  }, []);

  useEffect(() => {
    return window.roc.app.onNavigate((page) => {
      const view = parseViewId(page);
      if (isFloatingView(view)) {
        return;
      }
      if (view === 'settings') {
        setSettingsOpen(true);
        return;
      }
      setActiveView(view);
      setWorkbenchVisible(view !== 'chat' && WORKBENCH_VIEWS.has(view));
    });
  }, []);

  useEffect(() => {
    return window.roc.tasks.onUpdated(() => {
      void refreshTaskState().catch((refreshError: unknown) => {
        setError(refreshError instanceof Error ? refreshError.message : 'Roc 任务状态刷新失败。');
      });
    });
  }, [refreshTaskState]);

  useEffect(() => {
    if (historyContextMenu === null) {
      return;
    }

    function closeHistoryContextMenu(event: PointerEvent): void {
      if (event.target instanceof Element && event.target.closest('.history-context-menu') !== null) {
        return;
      }
      setHistoryContextMenu(null);
    }

    window.addEventListener('pointerdown', closeHistoryContextMenu);
    return () => {
      window.removeEventListener('pointerdown', closeHistoryContextMenu);
    };
  }, [historyContextMenu]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const [appStatus, taskSnapshot, agent, workspace, rtkStatus, loadedWindowState, settingsSnapshot] = await Promise.all([
        window.roc.app.getStatus(),
        window.roc.tasks.getSnapshot(),
        window.roc.agent.getStatus(),
        window.roc.workspace.getCurrent(),
        window.roc.rtk.status(),
        window.roc.window.getState(),
        loadSettingsState()
      ]);

      const loadedWorkspace = unwrap<Workspace | null>('workspace', workspace);
      const loadedAppStatus = unwrap<AppStatus>('app status', appStatus);
      const taskSurfaceData = await loadTaskSurfaceData();
      const refreshedAppStatus =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AppStatus>('refreshed app status', await window.roc.app.getStatus())
          : loadedAppStatus;
      const loadedAgent =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AgentRuntimeStatus>('refreshed agent', await window.roc.agent.getStatus())
          : unwrap<AgentRuntimeStatus>('agent', agent);
      const selectedMcpServers = settingsSnapshot.mcpServers.filter((server) => server.enabled).map((server) => server.id);
      const selectedSkills = settingsSnapshot.skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id);

      if (cancelled) {
        return;
      }

      setWindowState(unwrap<WindowStateSnapshot>('window state', loadedWindowState));
      setState({
        appStatus: refreshedAppStatus,
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        ...settingsSnapshot,
        selectedMcpServers,
        selectedSkills,
        ...taskSurfaceData,
        ...emptyOperationsData(refreshedAppStatus.mode),
        agent: loadedAgent,
        agentCapabilityPreview: null,
        workspace: loadedWorkspace,
        rtkStatus: unwrap<RtkStatus>('rtk status', rtkStatus),
        ...emptyWorkspaceData(),
        ...emptyMemoryData()
      });
    }

    load().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Roc renderer failed to load.');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeView === 'chat') {
      return;
    }
    setActiveWorkbenchTool(defaultWorkbenchTool(activeView));
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'chat') {
      setHistorySearchVisible(false);
      setHistorySearchQuery('');
      setHistoryContextMenu(null);
      return;
    }
    if (historySearchVisible) {
      historySearchInputRef.current?.focus();
      historySearchInputRef.current?.select();
    }
  }, [activeView, historySearchVisible]);

  const currentWorkspace = state?.workspace ?? null;
  const currentAppMode = state?.appStatus.mode ?? null;
  const currentAgentExecution = state?.agent.execution ?? null;
  const currentSelectedMcpServers = state?.selectedMcpServers ?? [];
  const currentSelectedSkills = state?.selectedSkills ?? [];
  const { continueWindowDrag, finishWindowDrag, startWindowDrag } = useWindowDrag(windowState);

  const startNewConversation = useCallback((): void => {
    setActiveView('chat');
    setSelectedThreadId(null);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const selectHistoryThread = useCallback((threadId: string): void => {
    setActiveView('chat');
    setSelectedThreadId(threadId);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const toggleChatSidebar = useCallback((): void => {
    setHistoryContextMenu(null);
    setChatSidebarCollapsed((current) => {
      const next = !current;
      if (next) {
        setHistorySearchVisible(false);
        setHistorySearchQuery('');
      }
      return next;
    });
  }, []);

  const toggleHistorySearch = useCallback((): void => {
    setHistoryContextMenu(null);
    if (chatSidebarCollapsed) {
      setChatSidebarCollapsed(false);
      setHistorySearchVisible(true);
      return;
    }
    setHistorySearchVisible((current) => {
      const next = !current;
      if (!next) {
        setHistorySearchQuery('');
      }
      return next;
    });
  }, [chatSidebarCollapsed]);

  const startTaskRun = useCallback(
    async (input: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await window.roc.chat.startRun({
        input,
        mode: 'task',
        threadId: selectedThreadId,
        enabledCapabilities: {
          mcpServers: currentSelectedMcpServers,
          skills: currentSelectedSkills
        }
      });
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }
      setSelectedThreadId(result.data.threadId);
      setHistoryContextMenu(null);
      return { ok: true };
    },
    [currentSelectedMcpServers, currentSelectedSkills, selectedThreadId]
  );

  const deleteHistoryThread = useCallback(
    async (threadId: string): Promise<void> => {
      setHistoryContextMenu(null);
      const result = await window.roc.tasks.deleteThread({ threadId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (selectedThreadId === threadId) {
        startNewConversation();
      }
      await refreshTaskState();
    },
    [refreshTaskState, selectedThreadId, startNewConversation]
  );

  useEffect(() => {
    if (state === null) {
      return;
    }
    if (currentAgentExecution !== 'ready' || (currentSelectedMcpServers.length === 0 && currentSelectedSkills.length === 0)) {
      setState((current) =>
        current === null || current.agentCapabilityPreview === null
          ? current
          : {
              ...current,
              agentCapabilityPreview: null
            }
      );
      return;
    }

    let cancelled = false;
    void window.roc.agent
      .getCapabilityPreview({
        mcpServers: currentSelectedMcpServers,
        skills: currentSelectedSkills
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState((current) =>
          current === null
            ? current
            : {
                ...current,
                agentCapabilityPreview: unwrap<AgentCapabilityPreview>('agent capability preview', result)
              }
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentAgentExecution, currentSelectedMcpServers, currentSelectedSkills]);

  const startupLoadIntent = getStartupLoadIntent({
    activeView,
    activeWorkbenchTool,
    workbenchVisible
  });

  useLazyStartupResource<WorkspaceData>({
    apply: useCallback((workspaceData) => {
      setState((current) => (current === null ? current : { ...current, ...workspaceData }));
    }, []),
    cacheKey: state === null ? null : currentWorkspace?.path ?? 'no-workspace',
    enabled: state !== null && startupLoadIntent.targets.has('workspace'),
    load: useCallback(() => loadWorkspaceData(currentWorkspace), [currentWorkspace]),
    loadState: workspaceLoadState,
    setLoadState: setWorkspaceLoadState
  });

  useLazyStartupResource<MemoryData>({
    apply: useCallback((memoryData) => {
      setState((current) => (current === null ? current : { ...current, ...memoryData }));
    }, []),
    cacheKey: currentAppMode,
    enabled: currentAppMode !== null && startupLoadIntent.targets.has('memory'),
    load: useCallback(() => loadMemoryData(currentAppMode as AppStatus['mode']), [currentAppMode]),
    loadState: memoryLoadState,
    setLoadState: setMemoryLoadState
  });

  useLazyStartupResource<OperationsData>({
    apply: useCallback((operationsData) => {
      setState((current) => (current === null ? current : { ...current, ...operationsData }));
    }, []),
    cacheKey: currentAppMode,
    enabled: currentAppMode !== null && startupLoadIntent.targets.has('operations'),
    load: useCallback(() => loadOperationsData(currentAppMode as AppStatus['mode']), [currentAppMode]),
    loadState: operationsLoadState,
    setLoadState: setOperationsLoadState
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>('.sidebar, .sidebar-block-scroll, .canvas-scroll, .tool-stack, .workbench-tabs')
        .forEach((element) => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeView, activeWorkbenchTool]);

  useEffect(() => {
    syncRendererUrl(activeView, activeWorkbenchTool, workbenchVisible);
  }, [activeView, activeWorkbenchTool, workbenchVisible]);

  async function selectWorkspaceFromDialog(): Promise<void> {
    setWorkspaceSelectError(null);
    const selected = await window.roc.workspace.selectFromDialog();
    if (!selected.ok) {
      setWorkspaceSelectError(selected.error.message);
      return;
    }
    if (selected.data === null) {
      return;
    }

    const [appStatus, workspaceData] = await Promise.all([
      window.roc.app.getStatus(),
      loadWorkspaceData(selected.data)
    ]);
    setWorkspaceLoadState({
      status: 'ready',
      error: null,
      key: selected.data.path
    });
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            appStatus: unwrap<AppStatus>('app status', appStatus),
            workspace: selected.data,
            ...workspaceData
          }
    );
  }

  const updateWorkspaceData = useCallback((partial: Partial<WorkspaceData>): void => {
    setState((current) => (current === null ? current : { ...current, ...partial }));
  }, []);

  if (error !== null) {
    return <div className="fatal">Roc 启动失败：{error}</div>;
  }

  if (state === null) {
    return <div className="boot">Roc 正在加载本地工作台</div>;
  }

  if (isFloatingView(activeView)) {
    return (
      <main className="floating-stage" data-testid={`floating-${activeView}`}>
        <ViewContent
          activeView={activeView}
          chatSelectionVersion={chatSelectionVersion}
          memoryLoadState={memoryLoadState}
          operationsLoadState={operationsLoadState}
          onSelectWorkspace={selectWorkspaceFromDialog}
          onSubmitChatTask={startTaskRun}
          selectedThreadId={selectedThreadId}
          state={state}
          updateLoadedState={(partial) =>
            setState((current) => (current === null ? current : { ...current, ...partial }))
          }
          workspaceLoadState={workspaceLoadState}
        />
      </main>
    );
  }

  const hasWorkbench = activeView === 'chat' ? workbenchVisible : WORKBENCH_VIEWS.has(activeView);
  const topMeta = buildTopMeta(activeView as MainViewId, state);
  const historyNavItems = buildHistoryNavItems(selectedThreadId, activeView);
  const historyItems = buildHistoryItems(state);
  const visibleHistoryItems = activeView === 'chat' ? filterHistoryItems(historyItems, historySearchQuery) : historyItems;
  const showHistorySearch = activeView === 'chat' && historySearchVisible;
  const showHistorySearchEmpty = showHistorySearch && historyItems.length > 0 && visibleHistoryItems.length === 0;
  const showChatSidebar = activeView !== 'chat' || !chatSidebarCollapsed;
  const workspaceNavItems = buildWorkspaceNavItems(state);
  const controlNavItems = buildControlNavItems(state);

  return (
    <div className={state.appStatus.mode === 'smoke' ? 'app-shell app-shell--smoke' : 'app-shell'} data-testid="roc-app">
      <WindowWorkband
        activeView={activeView}
        chatSidebarCollapsed={chatSidebarCollapsed}
        onHistorySearchToggle={toggleHistorySearch}
        onNewConversation={startNewConversation}
        onSidebarToggle={toggleChatSidebar}
        onWindowClose={() => {
          void window.roc.window.close();
        }}
        onWindowDragMove={(event) => {
          continueWindowDrag(event.screenX, event.screenY);
        }}
        onWindowDragStart={startWindowDrag}
        onWindowDragStop={(event) => {
          finishWindowDrag(event.pointerId);
        }}
        onWindowMaximizeToggle={() => {
          void window.roc.window.toggleMaximize().then((result) => {
            setWindowState(unwrap<WindowStateSnapshot>('window toggle maximize', result));
          });
        }}
        onWindowMinimize={() => {
          void window.roc.window.minimize().then((result) => {
            setWindowState(unwrap<WindowStateSnapshot>('window minimize', result));
          });
        }}
        showHistorySearch={showHistorySearch}
        topMeta={topMeta}
        windowState={windowState}
      />

      <div
        className={
          activeView === 'chat'
            ? showChatSidebar
              ? 'workspace workspace--chat'
              : 'workspace workspace--chat workspace--chat-sidebar-collapsed'
            : 'workspace'
        }
      >
        {showChatSidebar ? (
          <aside className="sidebar">
            <div className="sidebar-head">
              <button
                className="workspace-pill"
                data-testid="workspace-select-button"
                title={visibleWorkspaceLabel(state)}
                type="button"
                onClick={() => void selectWorkspaceFromDialog()}
              >
                <PreviewIcon name="folder" />
                <span>{visibleWorkspaceLabel(state)}</span>
                <strong>选择</strong>
              </button>
              {workspaceSelectError === null ? null : <span className="inline-warning">{workspaceSelectError}</span>}
            </div>
            {historyNavItems.length === 0 ? null : (
              <SidebarNavGroup
                activeView={activeView}
                items={historyNavItems}
                title="对话"
                onSelect={(item) => {
                  if (item.id === 'chat') {
                    startNewConversation();
                    return;
                  }
                  setActiveView(item.id);
                }}
              />
            )}
            <div className="sidebar-block sidebar-block--history">
              <div className="side-title">历史会话</div>
              {showHistorySearch ? (
                <label className="history-search-field">
                  <Search aria-hidden="true" className="icon-svg" size={15} strokeWidth={1.8} />
                  <input
                    aria-label="搜索历史会话"
                    data-testid="chat-history-search-input"
                    placeholder="搜索历史会话"
                    ref={historySearchInputRef}
                    type="search"
                    value={historySearchQuery}
                    onChange={(event) => {
                      setHistoryContextMenu(null);
                      setHistorySearchQuery(event.target.value);
                    }}
                  />
                </label>
              ) : null}
              <div className="sidebar-block-scroll history-list">
                {historyItems.length === 0 ? (
                  <div className="history-empty">暂无历史会话</div>
                ) : showHistorySearchEmpty ? (
                  <div className="history-empty" data-testid="chat-history-search-empty">未找到匹配的历史会话</div>
                ) : (
                  visibleHistoryItems.map((item) => (
                    <button
                      className={item.id === selectedThreadId ? 'nav-button active' : 'nav-button'}
                      data-testid={`history-thread-${sanitizeTestId(item.id)}`}
                      key={item.id}
                      type="button"
                      onClick={() => selectHistoryThread(item.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setHistoryContextMenu({
                          threadId: item.id,
                          x: event.clientX,
                          y: event.clientY
                        });
                      }}
                    >
                      <PreviewIcon name={item.icon} />
                      <span className="nav-copy">
                        <span className="nav-label">{item.label}</span>
                        <span className="nav-meta">{item.meta}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
              {historyContextMenu === null ? null : (
                <div
                  className="history-context-menu"
                  style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
                >
                  <button
                    data-testid="history-thread-delete"
                    type="button"
                    onClick={() => void deleteHistoryThread(historyContextMenu.threadId)}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
            <SidebarNavGroup
              className="sidebar-block sidebar-block--tasks"
              activeView={activeView}
              items={workspaceNavItems}
              title="任务工作台"
              onSelect={(item) => setActiveView(item.id)}
            />
            <SidebarNavGroup
              className="sidebar-block sidebar-block--control"
              activeView={activeView}
              items={controlNavItems}
              title="控制区"
              onSelect={(item) => setActiveView(item.id)}
            />
            <div className="sidebar-footer">
              <button
                className="settings-gear"
                data-testid="settings-gear"
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="打开设置"
                aria-label="打开设置"
              >
                <PreviewIcon name="wrench" />
              </button>
            </div>
          </aside>
        ) : null}

        <div
          style={hasWorkbench ? { '--workbench-width': `${workbenchWidth}px` } as React.CSSProperties : undefined}
          className={
            activeView === 'chat'
              ? hasWorkbench
                ? 'workspace-shell workspace-shell--chat'
                : 'workspace-shell workspace-shell--chat-collapsed'
              : hasWorkbench
                ? 'workspace-shell workspace-shell--with-workbench'
                : 'workspace-shell'
          }
        >
          <main className={activeView === 'chat' ? 'workspace-main workspace-main--chat' : 'workspace-main'} data-testid="active-view">
            <section className={activeView === 'chat' ? 'canvas canvas--chat' : 'canvas'}>
              <div className="canvas-scroll">
                <ViewContent
                  activeView={activeView}
                  chatSelectionVersion={chatSelectionVersion}
                  memoryLoadState={memoryLoadState}
                  operationsLoadState={operationsLoadState}
                  onSelectWorkspace={selectWorkspaceFromDialog}
                  onSubmitChatTask={startTaskRun}
                  selectedThreadId={selectedThreadId}
                  state={state}
                  updateLoadedState={(partial) =>
                    setState((current) => (current === null ? current : { ...current, ...partial }))
                  }
                  workspaceLoadState={workspaceLoadState}
                />
              </div>
            </section>
          </main>

          {activeView === 'chat' ? (
            <RailOverlay
              activeTool={activeWorkbenchTool}
              activeView={activeView}
              workbenchVisible={hasWorkbench}
              onOpenToolView={(tool) => {
                setActiveWorkbenchTool(tool);
                setActiveView('chat');
                setWorkbenchVisible(true);
              }}
            />
          ) : null}
          {hasWorkbench ? (
            <WorkbenchPanel
              activeTool={activeWorkbenchTool}
              activeView={activeView}
              onToolChange={setActiveWorkbenchTool}
              onClose={() => {
                setActiveView('chat');
                setWorkbenchVisible(false);
              }}
              state={state}
              updateWorkspaceData={updateWorkspaceData}
              workspaceLoadState={workspaceLoadState}
              width={workbenchWidth}
              onWidthChange={setWorkbenchWidth}
              windowState={windowState}
            />
          ) : null}
        </div>
      </div>
      {settingsOpen ? (
        <SettingsModal onClose={() => setSettingsOpen(false)}>
          <SettingsView
            onNavigate={(target) => {
              setSettingsOpen(false);
              setActiveView(target);
              setWorkbenchVisible(false);
            }}
            state={state}
            updateLoadedState={(partial) =>
              setState((current) => (current === null ? current : { ...current, ...partial }))
            }
          />
        </SettingsModal>
      ) : null}
    </div>
  );
}
