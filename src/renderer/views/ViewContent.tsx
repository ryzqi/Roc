import { Suspense, lazy } from 'react';
import type { ChatRunState } from '../chat-run-state';
import type { ChatTaskSubmitPayload } from '../chat/task-run-payload';
import type { LazyLoadState, ViewId } from '../app/types';
import type { LoadedState } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { ChatFeature } from '../features/chat';
import { DiagnosticsFeature } from '../features/diagnostics';
import { MemoryFeature } from '../features/memory';
import { McpFeature } from '../features/mcp';
import { SkillsFeature } from '../features/skills';
import type { TaskBoardUiState } from '../features/tasks';
import { TaskDetailFeature, TasksBoardFeature } from '../features/tasks';
import { WorkspaceFeature } from '../features/workspace';
import type { TaskPromptSubmission } from './tasks/TasksView';

const GitView = lazy(() => import('./git/GitView').then((module) => ({ default: module.GitView })));
const TerminalView = lazy(() => import('./terminal/TerminalView').then((module) => ({ default: module.TerminalView })));
const PreviewView = lazy(() => import('./preview/PreviewView').then((module) => ({ default: module.PreviewView })));

export function ViewContent({
  activeView,
  chatSelectionVersion,
  client,
  liveTaskRun,
  memoryLoadState,
  onOpenTaskDetail,
  onBackToTaskBoard,
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
  workspaceLoadState
}: {
  activeView: ViewId;
  chatSelectionVersion: number;
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  memoryLoadState: LazyLoadState;
  onOpenTaskDetail: (taskId: string, boardUiState: TaskBoardUiState) => void;
  onBackToTaskBoard: () => void;
  operationsLoadState: LazyLoadState;
  onQueueTaskPrompt: (prompt: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSubmitTaskDetailInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onTaskSurfaceSelectionChange: (taskId: string | null | undefined) => void;
  selectedTaskDetailId: string | null;
  selectedThreadId: string | null;
  state: LoadedState;
  taskBoardUiState: TaskBoardUiState;
  onTaskBoardUiStateChange: (state: TaskBoardUiState) => void;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
}): React.JSX.Element {
  function renderLazyView(node: React.JSX.Element): React.JSX.Element {
    return <Suspense fallback={<div className="boot">Roc 正在加载视图</div>}>{node}</Suspense>;
  }

  if (activeView === 'tasks-board') {
    return (
      <TasksBoardFeature
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
  if (activeView === 'task-detail') {
    if (selectedTaskDetailId === null) {
      return (
        <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
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
    return (
      <TaskDetailFeature
        client={client}
        liveTaskRun={liveTaskRun}
        onBackToBoard={onBackToTaskBoard}
        onSubmitTaskInput={onSubmitTaskDetailInput}
        state={state}
        taskId={selectedTaskDetailId}
        updateLoadedState={updateLoadedState}
      />
    );
  }
  if (activeView === 'workspace') {
    return <WorkspaceFeature client={client} loadState={workspaceLoadState} onSelectWorkspace={onSelectWorkspace} state={state} />;
  }
  if (activeView === 'git') {
    return renderLazyView(<GitView loadState={workspaceLoadState} state={state} />);
  }
  if (activeView === 'terminal') {
    return renderLazyView(<TerminalView state={state} />);
  }
  if (activeView === 'preview') {
    return renderLazyView(<PreviewView loadState={workspaceLoadState} state={state} />);
  }
  if (activeView === 'mcp') {
    return <McpFeature client={client} state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'skills') {
    return <SkillsFeature client={client} state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'memory') {
    return <MemoryFeature client={client} loadState={memoryLoadState} state={state} />;
  }
  if (activeView === 'diagnostics') {
    return <DiagnosticsFeature client={client} loadState={operationsLoadState} state={state} />;
  }
  return (
    <ChatFeature
      chatSelectionVersion={chatSelectionVersion}
      client={client}
      onSubmitChatTask={onSubmitChatTask}
      queuedTaskPrompt={null}
      onQueuedTaskPromptHandled={() => {}}
      selectedThreadId={selectedThreadId}
      state={state}
      updateLoadedState={updateLoadedState}
    />
  );
}
