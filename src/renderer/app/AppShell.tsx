import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppStatus,
  ChatStartRunRequest,
  TaskSnapshot
} from '../../shared/types';
import { applyChatRunEvent, createEmptyChatRunState, type ChatRunState } from '../chat-run-state';
import { useChatFeature } from '../features/chat/use-chat-feature';
import { filterHistoryItems } from '../history-sidebar';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { applySystemAppearance } from '../system-appearance';
import { AppSettingsLayer } from './AppSettingsLayer';
import { AppSidebar } from './AppSidebar';
import { AppWorkspaceShell } from './AppWorkspaceShell';
import {
  loadTaskSurfaceData,
  loadWorkspaceData
} from './data-loading';
import {
  buildControlNavItems,
  buildHistoryItems,
  buildHistoryNavItems,
  buildWorkspaceNavItems
} from './nav-items';
import type {
  MainViewId,
  ViewId,
  WorkbenchTool,
  WorkspaceData
} from './types';
import { useAgentCapabilityPreview } from './use-agent-capability-preview';
import type { AppBootstrap } from './use-app-bootstrap';
import { useAppStartupResources } from './use-app-startup-resources';
import { useAppTaskRuns } from './use-app-task-runs';
import { useChatWorkspaceScale } from './use-chat-workspace-scale';
import { useWindowControls } from './use-window-controls';
import {
  WORKBENCH_VIEWS,
  buildTopMeta,
  defaultWorkbenchTool,
  parseViewId,
  parseWorkbenchTool,
  syncRendererUrl
} from './view-routing';
import { WindowWorkband } from './WindowWorkband';

const WorkbenchPanel = lazy(() =>
  import('../workbench/WorkbenchPanel').then((module) => ({ default: module.WorkbenchPanel }))
);

type HistoryContextMenuState = {
  threadId: string;
  x: number;
  y: number;
};

export function AppShell({ bootstrap, client }: { bootstrap: AppBootstrap; client: RocClient }): React.JSX.Element {
  const { error, setError, setState, setWindowState, state, windowState } = bootstrap;
  const initialParams = new URLSearchParams(window.location.search);
  const initialView = parseViewId(initialParams.get('page'));
  const [activeView, setActiveView] = useState<ViewId>(initialView === 'settings' ? 'chat' : initialView);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(initialView === 'settings');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedTaskSurfaceTaskId, setSelectedTaskSurfaceTaskId] = useState<string | null | undefined>(undefined);
  const selectedTaskSurfaceTaskIdRef = useRef<string | null | undefined>(selectedTaskSurfaceTaskId);
  const [activeTaskDetailId, setActiveTaskDetailId] = useState<string | null>(null);
  const [taskBoardUiState, setTaskBoardUiState] = useState<{
    railId: 'all' | 'todo' | 'running' | 'paused' | 'done';
    scrollTop: number;
  }>({
    railId: 'all',
    scrollTop: 0
  });
  const [taskLiveRunState, setTaskLiveRunState] = useState<ChatRunState>(() => createEmptyChatRunState());
  const [chatSelectionVersion, setChatSelectionVersion] = useState(0);
  const [pendingWorkflowHint, setPendingWorkflowHint] = useState<ChatStartRunRequest['workflowHint']>(null);
  const [pendingTaskSource, setPendingTaskSource] = useState<ChatStartRunRequest['taskSource'] | null>(null);
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
  const historySearchInputRef = useRef<HTMLInputElement | null>(null);
  const chatWorkspaceScaleHostRef = useRef<HTMLDivElement | null>(null);

  const refreshTaskState = useCallback(async (): Promise<void> => {
    const selectedTaskId = selectedTaskSurfaceTaskIdRef.current;
    const [taskSnapshot, taskSurfaceData] = await Promise.all([
      client.api.tasks.getSnapshot(),
      loadTaskSurfaceData(selectedTaskId, client)
    ]);
    const selectedTaskWasRemoved =
      typeof selectedTaskId === 'string' &&
      taskSurfaceData.activeTasks.every((task) => task.taskId !== selectedTaskId);
    if (selectedTaskWasRemoved && selectedTaskSurfaceTaskIdRef.current === selectedTaskId) {
      selectedTaskSurfaceTaskIdRef.current = null;
      setSelectedTaskSurfaceTaskId(null);
      setActiveTaskDetailId(null);
      setActiveView((current) => (current === 'task-detail' ? 'tasks-board' : current));
    }
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
            ...taskSurfaceData
          }
    );
  }, [client, setState]);

  useEffect(() => {
    return client.api.app.onAppearanceUpdated(applySystemAppearance);
  }, []);

  useEffect(() => {
    return client.api.app.onNavigate((page) => {
      const view = parseViewId(page);
      if (view === 'settings') {
        setSettingsOpen(true);
        return;
      }
      setActiveView(view);
      setWorkbenchVisible(view !== 'chat' && WORKBENCH_VIEWS.has(view));
    });
  }, []);

  useEffect(() => {
    return client.api.tasks.onUpdated(() => {
      void refreshTaskState().catch((refreshError: unknown) => {
        setError(refreshError instanceof Error ? refreshError.message : 'Roc 任务状态刷新失败。');
      });
    });
  }, [refreshTaskState]);

  useEffect(() => {
    return client.api.chat.onRunEvent((event) => {
      if (event.type === 'run_started' && event.mode !== 'task') {
        return;
      }
      setTaskLiveRunState((current) => applyChatRunEvent(current, event));
      if (
        event.type === 'run_completed' ||
        event.type === 'run_failed' ||
        event.type === 'run_interrupted'
      ) {
        void refreshTaskState().catch((refreshError: unknown) => {
          setError(refreshError instanceof Error ? refreshError.message : 'Roc 任务状态刷新失败。');
        });
      }
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
  const currentWorkspacePath = resolveCurrentWorkspacePath(state);
  const currentAppMode = state?.appStatus.mode ?? null;
  const currentAgentExecution = state?.agent.execution ?? null;
  const currentSelectedMcpServers = state?.selectedMcpServers ?? [];
  const currentSelectedSkills = state?.selectedSkills ?? [];
  const chatFeature = useChatFeature(client);
  const {
    memoryLoadState,
    operationsLoadState,
    setWorkspaceLoadState,
    workspaceLoadState
  } = useAppStartupResources({
    activeView,
    activeWorkbenchTool,
    client,
    currentAppMode,
    currentWorkspace,
    selectedTaskSurfaceTaskId,
    setError,
    setState,
    state,
    workbenchVisible
  });
  const chatWorkspaceScale = useChatWorkspaceScale({
    activeView,
    chatSidebarCollapsed,
    hostRef: chatWorkspaceScaleHostRef
  });
  const { closeWindow, minimizeWindow, toggleWindowMaximize } = useWindowControls(client, setWindowState);

  useEffect(() => {
    selectedTaskSurfaceTaskIdRef.current = selectedTaskSurfaceTaskId;
  }, [selectedTaskSurfaceTaskId]);

  const startNewConversation = useCallback((): void => {
    setActiveView('chat');
    setSelectedThreadId(null);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const selectHistoryThread = useCallback((threadId: string): void => {
    setActiveView('chat');
    setSelectedThreadId(threadId);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const openTaskDetail = useCallback((taskId: string, boardUiState?: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }): void => {
    if (boardUiState !== undefined) {
      setTaskBoardUiState(boardUiState);
    }
    selectedTaskSurfaceTaskIdRef.current = taskId;
    setSelectedTaskSurfaceTaskId(taskId);
    setActiveTaskDetailId(taskId);
    setActiveView('task-detail');
    setHistoryContextMenu(null);
  }, []);

  const clearDeletingTaskSelection = useCallback((): void => {
    selectedTaskSurfaceTaskIdRef.current = null;
    setSelectedTaskSurfaceTaskId(null);
  }, []);

  const returnToTaskBoard = useCallback((): void => {
    setActiveTaskDetailId(null);
    setActiveView('tasks-board');
    setHistoryContextMenu(null);
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

  const {
    createTaskFromWorkbench,
    resumeTaskApprovalFromDetail,
    startChatRun,
    submitTaskDetailInput
  } = useAppTaskRuns({
    chatFeature,
    client,
    currentSelectedMcpServers,
    currentSelectedSkills,
    currentWorkspacePath,
    openTaskDetail,
    pendingTaskSource,
    pendingWorkflowHint,
    refreshTaskState,
    selectedThreadId,
    setHistoryContextMenu,
    setPendingTaskSource,
    setPendingWorkflowHint,
    setSelectedTaskSurfaceTaskId,
    setSelectedThreadId,
    setState,
    taskBoardUiState
  });

  const deleteHistoryThread = useCallback(
    async (threadId: string): Promise<void> => {
      setHistoryContextMenu(null);
      const result = await client.api.tasks.deleteThread({ threadId });
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

  useAgentCapabilityPreview({
    client,
    currentAgentExecution,
    currentSelectedMcpServers,
    currentSelectedSkills,
    setState,
    state
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
    const selected = await client.api.workspace.selectFromDialog();
    if (!selected.ok) {
      setWorkspaceSelectError(selected.error.message);
      return;
    }
    if (selected.data === null) {
      return;
    }

    const [appStatus, workspaceData] = await Promise.all([
      client.api.app.getStatus(),
      loadWorkspaceData(selected.data, {}, client)
    ]);
    const selectedAppStatus = unwrap<AppStatus>('app status', appStatus);
    applySystemAppearance(selectedAppStatus.appearance);
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
            appStatus: selectedAppStatus,
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

  const topMeta = buildTopMeta(activeView as MainViewId, state);
  const historyNavItems = buildHistoryNavItems(selectedThreadId, activeView);
  const historyItems = buildHistoryItems(state);
  const visibleHistoryItems = activeView === 'chat' ? filterHistoryItems(historyItems, historySearchQuery) : historyItems;
  const showHistorySearch = activeView === 'chat' && historySearchVisible;
  const showHistorySearchEmpty = showHistorySearch && historyItems.length > 0 && visibleHistoryItems.length === 0;
  const showChatSidebar = activeView !== 'chat' || !chatSidebarCollapsed;
  const workspaceNavItems = buildWorkspaceNavItems(state);
  const controlNavItems = buildControlNavItems(state);
  const workspaceShellNode = (
    <AppWorkspaceShell
      activeTaskDetailId={activeTaskDetailId}
      activeView={activeView}
      activeWorkbenchTool={activeWorkbenchTool}
      chatSelectionVersion={chatSelectionVersion}
      client={client}
      clearDeletingTaskSelection={clearDeletingTaskSelection}
      createTaskFromWorkbench={createTaskFromWorkbench}
      memoryLoadState={memoryLoadState}
      openTaskDetail={openTaskDetail}
      operationsLoadState={operationsLoadState}
      resumeTaskApprovalFromDetail={resumeTaskApprovalFromDetail}
      returnToTaskBoard={returnToTaskBoard}
      selectWorkspaceFromDialog={selectWorkspaceFromDialog}
      selectedThreadId={selectedThreadId}
      setActiveView={setActiveView}
      setActiveWorkbenchTool={setActiveWorkbenchTool}
      setSelectedTaskSurfaceTaskId={setSelectedTaskSurfaceTaskId}
      setState={setState}
      setTaskBoardUiState={setTaskBoardUiState}
      setWorkbenchVisible={setWorkbenchVisible}
      setWorkbenchWidth={setWorkbenchWidth}
      startChatRun={startChatRun}
      state={state}
      submitTaskDetailInput={submitTaskDetailInput}
      taskBoardUiState={taskBoardUiState}
      taskLiveRunState={taskLiveRunState}
      updateWorkspaceData={updateWorkspaceData}
      workbenchPanel={WorkbenchPanel}
      workbenchVisible={workbenchVisible}
      workbenchWidth={workbenchWidth}
      windowState={windowState}
      workspaceLoadState={workspaceLoadState}
    />
  );

  return (
    <div className={state.appStatus.mode === 'smoke' ? 'app-shell app-shell--smoke' : 'app-shell'} data-testid="roc-app">
      <WindowWorkband
        activeView={activeView}
        chatSidebarCollapsed={chatSidebarCollapsed}
        onHistorySearchToggle={toggleHistorySearch}
        onNewConversation={startNewConversation}
        onSidebarToggle={toggleChatSidebar}
        onWindowClose={closeWindow}
        onWindowMaximizeToggle={toggleWindowMaximize}
        onWindowMinimize={minimizeWindow}
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
          <AppSidebar
            activeView={activeView}
            controlNavItems={controlNavItems}
            deleteHistoryThread={deleteHistoryThread}
            historyContextMenu={historyContextMenu}
            historyItems={historyItems}
            historyNavItems={historyNavItems}
            historySearchInputRef={historySearchInputRef}
            historySearchQuery={historySearchQuery}
            selectHistoryThread={selectHistoryThread}
            selectWorkspaceFromDialog={selectWorkspaceFromDialog}
            selectedThreadId={selectedThreadId}
            setActiveView={setActiveView}
            setHistoryContextMenu={setHistoryContextMenu}
            setHistorySearchQuery={setHistorySearchQuery}
            setSettingsOpen={setSettingsOpen}
            showHistorySearch={showHistorySearch}
            showHistorySearchEmpty={showHistorySearchEmpty}
            startNewConversation={startNewConversation}
            state={state}
            visibleHistoryItems={visibleHistoryItems}
            workspaceNavItems={workspaceNavItems}
            workspaceSelectError={workspaceSelectError}
          />
        ) : null}
        {activeView === 'chat' ? (
          <div
            className="chat-workspace-scale-host"
            data-chat-scale-active={chatWorkspaceScale.active ? 'true' : 'false'}
            ref={chatWorkspaceScaleHostRef}
            style={chatWorkspaceScale.style}
          >
            <div className="chat-workspace-scale-frame">{workspaceShellNode}</div>
          </div>
        ) : (
          workspaceShellNode
        )}
      </div>
      <AppSettingsLayer
        client={client}
        open={settingsOpen}
        setOpen={setSettingsOpen}
        setState={setState}
        state={state}
      />
    </div>
  );
}

function resolveCurrentWorkspacePath(state: AppBootstrap['state']): string | null {
  if (state === null) {
    return null;
  }
  if (state.workspace !== null) {
    return state.workspace.path;
  }
  if (state.appStatus.workspace.selectedPath !== null) {
    return state.appStatus.workspace.selectedPath;
  }
  return null;
}
