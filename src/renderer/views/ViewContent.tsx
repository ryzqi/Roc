import { ChatView } from '../chat/chat-view';
import type { LazyLoadState, ViewId } from '../app/types';
import type { LoadedState } from '../loaded-state';
import { DiagnosticsView } from './diagnostics/DiagnosticsView';
import { DoctorView } from './doctor/DoctorView';
import { QuickEntryView } from './floating/QuickEntryView';
import { TrayEntryView } from './floating/TrayEntryView';
import { GitView } from './git/GitView';
import { McpView } from './mcp/McpView';
import { MemoryView } from './memory/MemoryView';
import { PreviewView } from './preview/PreviewView';
import { SkillsHostView } from './skills/SkillsHostView';
import { TasksView } from './tasks/TasksView';
import { TerminalView } from './terminal/TerminalView';
import { WorkspaceView } from './workspace/WorkspaceView';

export function ViewContent({
  activeView,
  chatSelectionVersion,
  memoryLoadState,
  operationsLoadState,
  onSelectWorkspace,
  onSubmitChatTask,
  selectedThreadId,
  state,
  updateLoadedState,
  workspaceLoadState
}: {
  activeView: ViewId;
  chatSelectionVersion: number;
  memoryLoadState: LazyLoadState;
  operationsLoadState: LazyLoadState;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (input: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
}): React.JSX.Element {
  if (activeView === 'tasks') {
    return <TasksView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'workspace') {
    return <WorkspaceView loadState={workspaceLoadState} onSelectWorkspace={onSelectWorkspace} state={state} />;
  }
  if (activeView === 'git') {
    return <GitView loadState={workspaceLoadState} state={state} />;
  }
  if (activeView === 'terminal') {
    return <TerminalView state={state} />;
  }
  if (activeView === 'preview') {
    return <PreviewView loadState={workspaceLoadState} state={state} />;
  }
  if (activeView === 'mcp') {
    return <McpView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'skills') {
    return <SkillsHostView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'memory') {
    return <MemoryView loadState={memoryLoadState} state={state} />;
  }
  if (activeView === 'doctor') {
    return <DoctorView loadState={operationsLoadState} state={state} />;
  }
  if (activeView === 'diagnostics') {
    return <DiagnosticsView loadState={operationsLoadState} state={state} />;
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
      selectedThreadId={selectedThreadId}
      state={state}
      updateLoadedState={updateLoadedState}
    />
  );
}
