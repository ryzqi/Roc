import { Suspense, lazy } from 'react';
import type { ChatRunState } from '../chat-run-state';
import { ChatView } from '../chat/chat-view';
import type { LazyLoadState, ViewId } from '../app/types';
import type { LoadedState } from '../loaded-state';
import { QuickEntryView } from './floating/QuickEntryView';
import { TrayEntryView } from './floating/TrayEntryView';

const TasksView = lazy(() => import('./tasks/TasksView').then((module) => ({ default: module.TasksView })));
const WorkspaceView = lazy(() => import('./workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceView })));
const GitView = lazy(() => import('./git/GitView').then((module) => ({ default: module.GitView })));
const TerminalView = lazy(() => import('./terminal/TerminalView').then((module) => ({ default: module.TerminalView })));
const PreviewView = lazy(() => import('./preview/PreviewView').then((module) => ({ default: module.PreviewView })));
const McpView = lazy(() => import('./mcp/McpView').then((module) => ({ default: module.McpView })));
const SkillsHostView = lazy(() => import('./skills/SkillsHostView').then((module) => ({ default: module.SkillsHostView })));
const MemoryView = lazy(() => import('./memory/MemoryView').then((module) => ({ default: module.MemoryView })));
const DiagnosticsView = lazy(() =>
  import('./diagnostics/DiagnosticsView').then((module) => ({ default: module.DiagnosticsView }))
);

export function ViewContent({
  activeView,
  chatSelectionVersion,
  liveTaskRun,
  memoryLoadState,
  onNavigateToTaskThread,
  operationsLoadState,
  onQueueTaskPrompt,
  queuedTaskPrompt,
  onQueuedTaskPromptHandled,
  onSelectWorkspace,
  onSubmitChatTask,
  onTaskSurfaceSelectionChange,
  selectedThreadId,
  state,
  updateLoadedState,
  workspaceLoadState
}: {
  activeView: ViewId;
  chatSelectionVersion: number;
  liveTaskRun: ChatRunState | null;
  memoryLoadState: LazyLoadState;
  onNavigateToTaskThread: (threadId: string) => void;
  operationsLoadState: LazyLoadState;
  onQueueTaskPrompt: (prompt: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  queuedTaskPrompt: string | null;
  onQueuedTaskPromptHandled: () => void;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (input: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onTaskSurfaceSelectionChange: (taskId: string | null | undefined) => void;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
}): React.JSX.Element {
  function renderLazyView(node: React.JSX.Element): React.JSX.Element {
    return <Suspense fallback={<div className="boot">Roc 正在加载视图</div>}>{node}</Suspense>;
  }

  if (activeView === 'tasks') {
    return renderLazyView(
      <TasksView
        state={state}
        updateLoadedState={updateLoadedState}
        liveTaskRun={liveTaskRun}
        onNavigateToThread={onNavigateToTaskThread}
        onSelectedTaskIdChange={onTaskSurfaceSelectionChange}
        onSubmitTaskPrompt={onQueueTaskPrompt}
      />
    );
  }
  if (activeView === 'workspace') {
    return renderLazyView(<WorkspaceView loadState={workspaceLoadState} onSelectWorkspace={onSelectWorkspace} state={state} />);
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
    return renderLazyView(<McpView state={state} updateLoadedState={updateLoadedState} />);
  }
  if (activeView === 'skills') {
    return renderLazyView(<SkillsHostView state={state} updateLoadedState={updateLoadedState} />);
  }
  if (activeView === 'memory') {
    return renderLazyView(<MemoryView loadState={memoryLoadState} state={state} />);
  }
  if (activeView === 'diagnostics') {
    return renderLazyView(<DiagnosticsView loadState={operationsLoadState} state={state} />);
  }
  if (activeView === 'quick') {
    return <QuickEntryView onSubmitChatTask={onSubmitChatTask} state={state} />;
  }
  if (activeView === 'tray') {
    return <TrayEntryView state={state} updateLoadedState={updateLoadedState} />;
  }
  return (
    <ChatView
      chatSelectionVersion={chatSelectionVersion}
      onSubmitChatTask={onSubmitChatTask}
      queuedTaskPrompt={queuedTaskPrompt}
      onQueuedTaskPromptHandled={onQueuedTaskPromptHandled}
      selectedThreadId={selectedThreadId}
      state={state}
      updateLoadedState={updateLoadedState}
    />
  );
}
