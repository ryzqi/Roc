import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppStatus,
  ChatStartRunRequest,
  TaskSnapshot
} from '../../shared/types';
import { applyChatRunEvent, createEmptyChatRunState, type ChatRunState } from '../chat-run-state';
import { useChatFeature } from '../features/chat/use-chat-feature';
import { unwrap, type LoadedState } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { applySystemAppearance } from '../system-appearance';
import { restoreDialogFocus } from '../dialog-focus';
import type { ResearchServiceContext, ResearchServiceEntry } from '../views/research/research-services';
import { AppSettingsLayer } from './AppSettingsLayer';
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
import {
  WORKBENCH_VIEWS,
  buildTopMeta,
  defaultWorkbenchTool,
  isProjectServiceView,
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
  const { error, setError, setState, state, windowState } = bootstrap;
  const initialParams = new URLSearchParams(window.location.search);
  const initialView = parseViewId(initialParams.get('page'), initialParams.get('project'));
  const [activeView, setActiveView] = useState<ViewId>(initialView === 'settings' || initialView === 'chat' ? 'research' : initialView);
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
  const [activeWorkbenchTool, setActiveWorkbenchTool] = useState<WorkbenchTool>(
    parseWorkbenchTool(initialParams.get('tool'), initialView)
  );
  const [workbenchVisible, setWorkbenchVisible] = useState(
    initialView === 'chat' ? initialParams.has('tool') : WORKBENCH_VIEWS.has(initialView)
  );
  const [workbenchWidth, setWorkbenchWidth] = useState(560);
  const [researchTopMeta, setResearchTopMeta] = useState<string | null>(null);
  const [researchServiceContext, setResearchServiceContext] = useState<ResearchServiceContext | null>(null);
  const previousResearchProjectIdRef = useRef<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(initialView === 'chat' && initialParams.get('project') !== null);
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
      const view = parseViewId(page, new URLSearchParams(window.location.search).get('project'));
      if (view === 'settings') {
        settingsOpenerRef.current = null;
        setSettingsOpen(true);
        return;
      }
      if (view === 'chat') {
        const projectId = new URLSearchParams(window.location.search).get('project');
        if (projectId !== null && projectId.trim().length > 0) {
          setActiveView('research');
          setAssistantOpen(true);
          return;
        }
        setActiveView('research');
        setAssistantOpen(false);
        return;
      }
      setActiveView(view);
      setAssistantOpen(false);
      setWorkbenchVisible(WORKBENCH_VIEWS.has(view));
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
    hostRef: chatWorkspaceScaleHostRef
  });

  useEffect(() => {
    selectedTaskSurfaceTaskIdRef.current = selectedTaskSurfaceTaskId;
  }, [selectedTaskSurfaceTaskId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    const projectId = researchServiceContext?.projectId ?? null;
    const previous = previousResearchProjectIdRef.current;
    if (previous === projectId) {
      return;
    }
    previousResearchProjectIdRef.current = projectId;
    if (previous !== null) {
      setSelectedThreadId(null);
      setAssistantOpen(false);
    }
  }, [researchServiceContext?.projectId]);

  const startNewConversation = useCallback((): void => {
    const projectId = new URLSearchParams(window.location.search).get('project');
    if (projectId === null || projectId.trim().length === 0) {
      setActiveView('research');
      setAssistantOpen(false);
      return;
    }
    setAssistantOpen(true);
    setSelectedThreadId(null);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);

  const applySelectedWorkspace = useCallback(async (workspace: NonNullable<LoadedState['workspace']>): Promise<void> => {
    const [appStatus, workspaceData] = await Promise.all([
      client.api.app.getStatus(),
      loadWorkspaceData(workspace, {}, client)
    ]);
    const selectedAppStatus = unwrap<AppStatus>('app status', appStatus);
    applySystemAppearance(selectedAppStatus.appearance);
    setWorkspaceLoadState({
      status: 'ready',
      error: null,
      key: workspace.path
    });
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            appStatus: selectedAppStatus,
            workspace,
            ...workspaceData
          }
    );
  }, [client, setState, setWorkspaceLoadState]);

  const openResearchService = useCallback((service: ResearchServiceEntry): void => {
    if (service.projectId === null) {
      setActiveView('research');
      return;
    }
    if (service.id === 'assistant') {
      startNewConversation();
      return;
    }
    if (service.id === 'files') {
      if (service.workspacePath === null) {
        setError('打开文件与代码前必须先绑定工作目录。');
        return;
      }
      const workspacePath = service.workspacePath;
      void (async () => {
        const selected = await client.api.workspace.select({ path: workspacePath });
        if (!selected.ok) {
          setError(selected.error.message);
          return;
        }
        await applySelectedWorkspace(selected.data);
        setActiveWorkbenchTool('files');
        setWorkbenchVisible(true);
        setActiveView(service.view);
      })();
      return;
    }
    setActiveView(service.view);
  }, [applySelectedWorkspace, client, setError, startNewConversation]);

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
        .querySelectorAll<HTMLElement>('.canvas:not(.canvas--chat) .canvas-scroll')
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
    const projectId = new URLSearchParams(window.location.search).get('project');
    if (isProjectServiceView(activeView) && (projectId === null || projectId.trim().length === 0)) {
      setActiveView('research');
      setAssistantOpen(false);
      setWorkbenchVisible(false);
    }
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'workspace' && activeView !== 'git' && activeView !== 'terminal' && activeView !== 'preview') {
      return;
    }
    const projectId = new URLSearchParams(window.location.search).get('project');
    if (projectId === null || projectId.trim().length === 0) {
      return;
    }
    const currentPath = state?.workspace?.path ?? null;
    let cancelled = false;
    void (async () => {
      const listed = await client.api.research.listProjects();
      if (cancelled || !listed.ok) {
        if (!cancelled && !listed.ok) {
          setError(listed.error.message);
        }
        return;
      }
      const project = listed.data.find((item) => item.id === projectId);
      if (project === undefined) {
        setActiveView('research');
        setWorkbenchVisible(false);
        return;
      }
      if (project.workspacePath === null) {
        setError('打开文件与代码前必须先绑定工作目录。');
        setActiveView('research');
        setWorkbenchVisible(false);
        return;
      }
      if (currentPath === project.workspacePath) {
        return;
      }
      const selected = await client.api.workspace.select({ path: project.workspacePath });
      if (cancelled) {
        return;
      }
      if (!selected.ok) {
        setError(selected.error.message);
        return;
      }
      await applySelectedWorkspace(selected.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeView, applySelectedWorkspace, client, setError, state?.workspace?.path]);

  useEffect(() => {
    syncRendererUrl(activeView, activeWorkbenchTool, workbenchVisible, assistantOpen);
  }, [activeView, activeWorkbenchTool, assistantOpen, workbenchVisible]);

  const selectWorkspaceFromDialog = useCallback(async (): Promise<void> => {
    const selected = await client.api.workspace.selectFromDialog();
    if (!selected.ok) {
      setError(selected.error.message);
      return;
    }
    if (selected.data === null) {
      return;
    }
    await applySelectedWorkspace(selected.data);
  }, [applySelectedWorkspace, client, setError]);

  const updateWorkspaceData = useCallback((partial: Partial<WorkspaceData>): void => {
    setState((current) => (current === null ? current : { ...current, ...partial }));
  }, []);

  // 侧栏数据全部 memo 化：state 引用在 setTaskLiveRunState 这类高频 render 中不变，
  // 因此任务流流式运行期间侧栏子树不会被重渲。
  const topMeta = useMemo(
    () => {
      if (state === null) {
        return '';
      }
      if (activeView === 'research' && researchTopMeta !== null) {
        return researchTopMeta;
      }
      return buildTopMeta(activeView as MainViewId, state);
    },
    [activeView, researchTopMeta, state]
  );

  if (error !== null) {
    return <div className="fatal">Roc 启动失败：{error}</div>;
  }

  if (state === null) {
    return <div className="boot">Roc 正在加载本地工作台</div>;
  }

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
      onResearchContextChange={setResearchTopMeta}
      assistantOpen={assistantOpen}
      onCloseResearchAssistant={() => setAssistantOpen(false)}
      onOpenResearchAssistant={startNewConversation}
      onOpenResearchService={openResearchService}
      onResearchServiceContextChange={setResearchServiceContext}
      researchServiceContext={researchServiceContext}
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
        onNewConversation={startNewConversation}
        onNewProject={() => {
          setActiveView('research');
          window.dispatchEvent(new Event('research-new-project'));
        }}
        onOpenSettings={openSettings}
        onReturnToProjects={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('project');
          url.searchParams.delete('view');
          url.searchParams.delete('stage');
          url.searchParams.set('page', 'research');
          window.history.pushState({}, '', url);
          window.dispatchEvent(new PopStateEvent('popstate'));
          setActiveView('research');
          setAssistantOpen(false);
          setSelectedThreadId(null);
          setWorkbenchVisible(false);
        }}
        researchContext={researchServiceContext}
        topMeta={topMeta}
      />

      <div
        className={
          activeView === 'chat'
            ? 'workspace workspace--chat workspace--no-sidebar'
            : 'workspace workspace--no-sidebar'
        }
      >
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
