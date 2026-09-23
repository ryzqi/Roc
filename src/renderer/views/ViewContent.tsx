import { lazy, useEffect, useLayoutEffect, useState, type ComponentType } from 'react';
import type { ChatRunState } from '../chat-run-state';
import type { ChatTaskSubmitPayload } from '../chat/task-run-payload';
import type { LazyLoadState, ViewId } from '../app/types';
import type { LoadedState } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import type { TaskBoardUiState } from '../features/tasks';
import type { TaskDetailApprovalRequest, TaskDetailInputRequest } from './tasks/TaskDetailView';
import type { TaskPromptSubmission } from './tasks/TasksView';
import type { ResearchServiceContext, ResearchServiceEntry } from './research/research-services';
import { ResearchServiceContextBanner } from './research/ResearchServiceContextBanner';

const GitView = lazy(() => import('./git/GitView').then((module) => ({ default: module.GitView })));
const ChatFeature = lazy(() => import('../features/chat').then((module) => ({ default: module.ChatFeature })));
const TerminalView = lazy(() => import('./terminal/TerminalView').then((module) => ({ default: module.TerminalView })));
const PreviewView = lazy(() => import('./preview/PreviewView').then((module) => ({ default: module.PreviewView })));
const DiagnosticsFeature = lazy(() => import('../features/diagnostics').then((module) => ({ default: module.DiagnosticsFeature })));
const MemoryFeature = lazy(() => import('../features/memory').then((module) => ({ default: module.MemoryFeature })));
const McpFeature = lazy(() => import('../features/mcp').then((module) => ({ default: module.McpFeature })));
const SkillsFeature = lazy(() => import('../features/skills').then((module) => ({ default: module.SkillsFeature })));
const TaskDetailFeature = lazy(() =>
  import('../features/tasks').then((module) => ({ default: module.TaskDetailFeature }))
);
const TasksBoardFeature = lazy(() =>
  import('../features/tasks').then((module) => ({ default: module.TasksBoardFeature }))
);
const WorkspaceFeature = lazy(() =>
  import('../features/workspace').then((module) => ({ default: module.WorkspaceFeature }))
);
const ResearchAppShell = lazy(() => import('./research/ResearchAppShell').then((module) => ({ default: module.ResearchAppShell })));

const viewCache = new Map<ViewId, ComponentType<any>>();

function loadView(view: ViewId): Promise<ComponentType<any>> {
  switch (view) {
    case 'chat':
    case 'settings':
      return import('../features/chat').then((module) => module.ChatFeature);
    case 'research':
      return import('./research/ResearchAppShell').then((module) => module.ResearchAppShell);
    case 'tasks-board':
    case 'task-detail':
      return import('../features/tasks').then((module) => {
        viewCache.set('tasks-board', module.TasksBoardFeature);
        viewCache.set('task-detail', module.TaskDetailFeature);
        return view === 'tasks-board' ? module.TasksBoardFeature : module.TaskDetailFeature;
      });
    case 'workspace':
      return import('../features/workspace').then((module) => module.WorkspaceFeature);
    case 'git':
      return import('./git/GitView').then((module) => module.GitView);
    case 'terminal':
      return import('./terminal/TerminalView').then((module) => module.TerminalView);
    case 'preview':
      return import('./preview/PreviewView').then((module) => module.PreviewView);
    case 'diagnostics':
      return import('../features/diagnostics').then((module) => module.DiagnosticsFeature);
    case 'memory':
      return import('../features/memory').then((module) => module.MemoryFeature);
    case 'mcp':
      return import('../features/mcp').then((module) => module.McpFeature);
    case 'skills':
      return import('../features/skills').then((module) => module.SkillsFeature);
  }
}

function useShownView(activeView: ViewId): ViewId | null {
  const [shown, setShown] = useState<ViewId | null>(() => (viewCache.has(activeView) ? activeView : null));
  if (viewCache.has(activeView) && shown !== activeView) {
    setShown(activeView);
  }
  useEffect(() => {
    if (viewCache.has(activeView)) {
      return;
    }
    let cancelled = false;
    const requested = activeView;
    void loadView(requested).then((component) => {
      viewCache.set(requested, component);
      if (!cancelled) {
        setShown(requested);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeView]);
  if (viewCache.has(activeView)) {
    return activeView;
  }
  return shown === activeView ? null : shown;
}

function cachedView(view: ViewId): ComponentType<any> {
  const component = viewCache.get(view);
  if (component === undefined) {
    throw new Error(`view ${view} is not loaded`);
  }
  return component;
}


export function ViewContent({
  activeView,
  chatSelectionVersion,
  client,
  liveTaskRun,
  memoryLoadState,
  onOpenTaskDetail,
  onTaskApprovalDecision,
  onBackToTaskBoard,
  onDeleteTaskStarted,
  operationsLoadState,
  onQueueTaskPrompt,
  onSelectWorkspace,
  onSubmitChatTask,
  onSubmitTaskDetailInput,
  onTaskSurfaceSelectionChange,
  selectedTaskDetailId,
  selectedThreadId,
  state,
  taskBoardUiState,
  onTaskBoardUiStateChange,
  updateLoadedState,
  workspaceLoadState,
  onResearchContextChange,
  onOpenResearchAssistant,
  onOpenResearchService,
  onResearchServiceContextChange,
  researchServiceContext
}: {
  activeView: ViewId;
  chatSelectionVersion: number;
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  memoryLoadState: LazyLoadState;
  onOpenTaskDetail: (taskId: string, boardUiState: TaskBoardUiState) => void;
  onTaskApprovalDecision: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBackToTaskBoard: () => void;
  onDeleteTaskStarted: () => void;
  operationsLoadState: LazyLoadState;
  onQueueTaskPrompt: (prompt: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSubmitTaskDetailInput: (payload: TaskDetailInputRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  onTaskSurfaceSelectionChange: (taskId: string | null | undefined) => void;
  selectedTaskDetailId: string | null;
  selectedThreadId: string | null;
  state: LoadedState;
  taskBoardUiState: TaskBoardUiState;
  onTaskBoardUiStateChange: (state: TaskBoardUiState) => void;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
  onResearchContextChange?: (meta: string) => void;
  onOpenResearchAssistant?: () => void;
  onOpenResearchService?: (service: ResearchServiceEntry) => void;
  onResearchServiceContextChange?: (context: ResearchServiceContext | null) => void;
  researchServiceContext?: ResearchServiceContext | null;
}): React.JSX.Element {
  const shownView = useShownView(activeView);
  useLayoutEffect(() => {
    if (shownView === null) {
      return;
    }
    document.querySelectorAll<HTMLElement>('.canvas:not(.canvas--chat) .canvas-scroll').forEach((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
  }, [shownView]);

  if (activeView === 'task-detail' && selectedTaskDetailId === null) {
    return (
      <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
        <ResearchServiceContextBanner context={researchServiceContext} />
        <button className="action-button" type="button" onClick={onBackToTaskBoard}>
          返回任务工作台
        </button>
        <div className="section-empty-state">
          <strong>任务不存在</strong>
          <p>当前任务不存在或已经删除。</p>
        </div>
      </section>
    );
  }

  if (shownView === null) {
    return <div className="view-loading" role="status">正在加载视图…</div>;
  }

  function renderServiceView(node: React.JSX.Element): React.JSX.Element {
    return (
      <>
        <ResearchServiceContextBanner context={researchServiceContext} />
        {node}
      </>
    );
  }

  if (shownView === 'tasks-board') {
    const TasksBoard = cachedView('tasks-board');
    return renderServiceView(
      <TasksBoard
        client={client}
        liveTaskRun={liveTaskRun}
        onCreateTask={onQueueTaskPrompt}
        onOpenTaskDetail={onOpenTaskDetail}
        onSelectedTaskIdChange={onTaskSurfaceSelectionChange}
        state={state}
        updateLoadedState={updateLoadedState}
        boardUiState={taskBoardUiState}
        onBoardUiStateChange={onTaskBoardUiStateChange}
      />
    );
  }
  if (shownView === 'research') {
    const ResearchShell = cachedView('research');
    return (
      <ResearchShell
        client={client}
        onContextChange={onResearchContextChange}
        onOpenAssistant={onOpenResearchAssistant}
        onOpenService={onOpenResearchService}
        onServiceContextChange={onResearchServiceContextChange}
        state={state}
      />
    );
  }
  if (shownView === 'task-detail' && selectedTaskDetailId !== null) {
    const TaskDetail = cachedView('task-detail');
    return renderServiceView(
      <TaskDetail
        client={client}
        liveTaskRun={liveTaskRun}
        onApprovalDecision={onTaskApprovalDecision}
        onBackToBoard={onBackToTaskBoard}
        onDeleteTaskStarted={onDeleteTaskStarted}
        onSubmitTaskInput={onSubmitTaskDetailInput}
        state={state}
        taskId={selectedTaskDetailId}
        updateLoadedState={updateLoadedState}
      />
    );
  }
  if (shownView === 'workspace') {
    const Workspace = cachedView('workspace');
    return renderServiceView(<Workspace client={client} loadState={workspaceLoadState} onSelectWorkspace={onSelectWorkspace} state={state} />);
  }
  if (shownView === 'git') {
    const Git = cachedView('git');
    return renderServiceView(<Git loadState={workspaceLoadState} state={state} />);
  }
  if (shownView === 'terminal') {
    const Terminal = cachedView('terminal');
    return renderServiceView(<Terminal state={state} />);
  }
  if (shownView === 'preview') {
    const Preview = cachedView('preview');
    return renderServiceView(<Preview loadState={workspaceLoadState} state={state} />);
  }
  if (shownView === 'mcp') {
    const Mcp = cachedView('mcp');
    return renderServiceView(<Mcp client={client} state={state} updateLoadedState={updateLoadedState} />);
  }
  if (shownView === 'skills') {
    const Skills = cachedView('skills');
    return renderServiceView(<Skills client={client} state={state} updateLoadedState={updateLoadedState} />);
  }
  if (shownView === 'memory') {
    const Memory = cachedView('memory');
    return renderServiceView(<Memory client={client} loadState={memoryLoadState} state={state} />);
  }
  if (shownView === 'diagnostics') {
    const Diagnostics = cachedView('diagnostics');
    return renderServiceView(<Diagnostics client={client} loadState={operationsLoadState} state={state} />);
  }
  if (shownView !== 'chat' && shownView !== 'settings') {
    return <div className="view-loading" role="status">正在加载视图…</div>;
  }
  const Chat = cachedView(shownView);
  return (
    <Chat
      chatSelectionVersion={chatSelectionVersion}
      client={client}
      onSubmitChatTask={onSubmitChatTask}
      selectedThreadId={selectedThreadId}
      state={state}
      updateLoadedState={updateLoadedState}
      researchContext={researchServiceContext ?? null}
    />
  );
}
