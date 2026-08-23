import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { restoreDialogFocus } from '../dialog-focus';
import { AppSettingsLayer } from './AppSettingsLayer';
import { AppSidebar } from './AppSidebar';
import { AppWorkspaceShell } from './AppWorkspaceShell';
import {
  completeTaskRunEvent,
  shouldApplyTaskRunEvent,
  syncKnownTaskRunIds
} from './task-run-event-filter';
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
  NavItem,
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

function resetScrollPosition(element: HTMLElement): void {
  element.scrollTop = 0;
  element.scrollLeft = 0;
}

export function AppShell({ bootstrap, client }: { bootstrap: AppBootstrap; client: RocClient }): React.JSX.Element {
  const { error, setError, setState, setWindowState, state, windowState } = bootstrap;
  const initialParams = new URLSearchParams(window.location.search);
  const initialView = parseViewId(initialParams.get('page'));
  const [activeView, setActiveView] = useState<ViewId>(initialView === 'settings' ? 'chat' : initialView);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(initialView === 'settings');
  const settingsOpenerRef = useRef<HTMLElement | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
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
  const taskRunIdsRef = useRef(new Set<string>());
  const [chatSelectionVersion, setChatSelectionVersion] = useState(0);
  const [pendingWorkflowHint, setPendingWorkflowHint] = useState<ChatStartRunRequest['workflowHint']>(null);
  const [pendingTaskSource, setPendingTaskSource] = useState<ChatStartRunRequest['taskSource'] | null>(null);
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
        settingsOpenerRef.current = null;
        setSettingsOpen(true);
        return;
      }
      setActiveView(view);
      setWorkbenchVisible(view !== 'chat' && WORKBENCH_VIEWS.has(view));
    });
  }, []);

  const openSettings = useCallback((opener: HTMLElement): void => {
    settingsOpenerRef.current = opener;
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
  }, []);

  const completeSettingsExit = useCallback((): void => {
    restoreDialogFocus(settingsOpenerRef.current);
    settingsOpenerRef.current = null;
  }, []);

  useEffect(() => {
    return client.api.tasks.onUpdated(() => {
      void refreshTaskState().catch((refreshError: unknown) => {
        setError(refreshError instanceof Error ? refreshError.message : 'Roc 任务状态刷新失败。');
      });
    });
  }, [refreshTaskState]);

  useEffect(() => {
    if (state === null) {
      return;
    }
    syncKnownTaskRunIds({
      target: taskRunIdsRef.current,
      snapshot: state.taskSnapshot,
      taskDetail: state.taskDetail
    });
  }, [state]);

  useEffect(() => {
    return client.api.chat.onRunEvent((event) => {
      if (!shouldApplyTaskRunEvent(taskRunIdsRef.current, event)) {
        return;
      }
      setTaskLiveRunState((current) => applyChatRunEvent(current, event));
      completeTaskRunEvent(taskRunIdsRef.current, event);
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
    if (activeView === 'chat') {
      return;
    }
    setActiveWorkbenchTool(defaultWorkbenchTool(activeView));
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'chat') {
      setHistorySearchVisible(false);
      setHistorySearchQuery('');
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

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const startNewConversation = useCallback((): void => {
    setActiveView('chat');
    setSelectedThreadId(null);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const selectHistoryThread = useCallback((threadId: string): void => {
    setActiveView('chat');
    setSelectedThreadId(threadId);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
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
  }, []);

  const clearDeletingTaskSelection = useCallback((): void => {
    selectedTaskSurfaceTaskIdRef.current = null;
    setSelectedTaskSurfaceTaskId(null);
  }, []);

  const returnToTaskBoard = useCallback((): void => {
    setActiveTaskDetailId(null);
    setActiveView('tasks-board');
  }, []);

  const toggleChatSidebar = useCallback((): void => {
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
    openTaskDetail,
    pendingTaskSource,
    pendingWorkflowHint,
    refreshTaskState,
    selectedThreadId,
    setPendingTaskSource,
    setPendingWorkflowHint,
    setSelectedTaskSurfaceTaskId,
    setSelectedThreadId,
    setState,
    taskBoardUiState
  });

  const deleteHistoryThread = useCallback(
    async (threadId: string): Promise<void> => {
      const result = await client.api.tasks.deleteThread({ threadId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      // 走 ref 读取当前选中会话，避免 selectedThreadId 变化让回调引用失效、击穿侧栏 memo。
      if (selectedThreadIdRef.current === threadId) {
        startNewConversation();
      }
      await refreshTaskState();
    },
    [refreshTaskState, startNewConversation]
  );

  const selectNavItem = useCallback(
    (item: NavItem): void => {
      if (item.id === 'chat') {
        startNewConversation();
        return;
      }
      setActiveView(item.id);
    },
    [startNewConversation]
  );

  useAgentCapabilityPreview({
    client,
    currentAgentExecution,
    currentSelectedMcpServers,
    currentSelectedSkills,
    setState,
    state
  });

  // 视图切换只重置侧栏容器自身与非 chat 内容区；不碰 .sidebar-block-scroll，
  // 侧栏内部（历史列表、各导航列表）的滚动位置跨视图保留。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>('.sidebar, .canvas:not(.canvas--chat) .canvas-scroll')
        .forEach(resetScrollPosition);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeView]);

  // 工作台工具切换只重置工作台内部滚动面。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('.tool-stack, .workbench-tabs').forEach(resetScrollPosition);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeWorkbenchTool]);

  useEffect(() => {
    syncRendererUrl(activeView, activeWorkbenchTool, workbenchVisible);
  }, [activeView, activeWorkbenchTool, workbenchVisible]);

  const selectWorkspaceFromDialog = useCallback(async (): Promise<void> => {
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
  }, [client, setState, setWorkspaceLoadState]);

  const updateWorkspaceData = useCallback((partial: Partial<WorkspaceData>): void => {
    setState((current) => (current === null ? current : { ...current, ...partial }));
  }, []);

  // 侧栏数据全部 memo 化：state 引用在 setTaskLiveRunState 这类高频 render 中不变，
  // 因此任务流流式运行期间侧栏子树不会被重渲。
  const topMeta = useMemo(
    () => (state === null ? '' : buildTopMeta(activeView as MainViewId, state)),
    [activeView, state]
  );
  const historyNavItems = useMemo(
    () => buildHistoryNavItems(selectedThreadId, activeView),
    [activeView, selectedThreadId]
  );
  const historyItems = useMemo(() => (state === null ? [] : buildHistoryItems(state)), [state]);
  const visibleHistoryItems = useMemo(
    () => (activeView === 'chat' ? filterHistoryItems(historyItems, historySearchQuery) : historyItems),
    [activeView, historyItems, historySearchQuery]
  );
  const workspaceNavItems = useMemo(() => (state === null ? [] : buildWorkspaceNavItems(state)), [state]);
  const controlNavItems = useMemo(() => (state === null ? [] : buildControlNavItems(state)), [state]);

  if (error !== null) {
    return <div className="fatal">Roc 启动失败：{error}</div>;
  }

  if (state === null) {
    return <div className="boot">Roc 正在加载本地工作台</div>;
  }

  const showHistorySearch = activeView === 'chat' && historySearchVisible;
  const showHistorySearchEmpty = showHistorySearch && historyItems.length > 0 && visibleHistoryItems.length === 0;
  const showChatSidebar = activeView !== 'chat' || !chatSidebarCollapsed;
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
            historyItems={historyItems}
            historyNavItems={historyNavItems}
            historySearchInputRef={historySearchInputRef}
            historySearchQuery={historySearchQuery}
            selectHistoryThread={selectHistoryThread}
            selectWorkspaceFromDialog={selectWorkspaceFromDialog}
            selectedThreadId={selectedThreadId}
            setHistorySearchQuery={setHistorySearchQuery}
            onOpenSettings={openSettings}
            onSelectNavItem={selectNavItem}
            showHistorySearch={showHistorySearch}
            showHistorySearchEmpty={showHistorySearchEmpty}
            state={state}
            visibleHistoryItems={visibleHistoryItems}
            workspaceNavItems={workspaceNavItems}
            workspaceSelectError={workspaceSelectError}
          />
        ) : null}
        <div
          className="chat-workspace-scale-host"
          data-chat-scale-active={chatWorkspaceScale.active ? 'true' : 'false'}
          ref={chatWorkspaceScaleHostRef}
          style={chatWorkspaceScale.style}
        >
          <div className="chat-workspace-scale-frame">{workspaceShellNode}</div>
        </div>
      </div>
      <AppSettingsLayer
        client={client}
        onClose={closeSettings}
        onExitComplete={completeSettingsExit}
        open={settingsOpen}
        setState={setState}
        state={state}
      />
    </div>
  );
}
