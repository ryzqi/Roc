import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Suspense } from 'react';

import type { WindowStateSnapshot } from '../../shared/types';
import type { ChatRunState } from '../chat-run-state';
import type { ChatTaskSubmitPayload } from '../chat/task-run-payload';
import type { RocClient } from '../shared/roc-client';
import { ViewContent } from '../views/ViewContent';
import type { TaskDetailApprovalRequest, TaskDetailInputRequest } from '../views/tasks/TaskDetailView';
import type { TaskPromptSubmission } from '../views/tasks/TasksView';
import { RailOverlay } from '../workbench/RailOverlay';
import type { AppBootstrap } from './use-app-bootstrap';
import type { LazyLoadState, ViewId, WorkbenchTool, WorkspaceData } from './types';
import { WORKBENCH_VIEWS } from './view-routing';

interface AppWorkspaceShellProps {
  activeTaskDetailId: string | null;
  activeView: ViewId;
  activeWorkbenchTool: WorkbenchTool;
  chatSelectionVersion: number;
  client: RocClient;
  clearDeletingTaskSelection: () => void;
  createTaskFromWorkbench: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  memoryLoadState: LazyLoadState;
  openTaskDetail: (taskId: string, boardUiState?: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  operationsLoadState: LazyLoadState;
  resumeTaskApprovalFromDetail: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  returnToTaskBoard: () => void;
  selectWorkspaceFromDialog: () => Promise<void>;
  setActiveView: Dispatch<SetStateAction<ViewId>>;
  setActiveWorkbenchTool: Dispatch<SetStateAction<WorkbenchTool>>;
  setSelectedTaskSurfaceTaskId: Dispatch<SetStateAction<string | null | undefined>>;
  setState: AppBootstrap['setState'];
  setTaskBoardUiState: Dispatch<SetStateAction<{ railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }>>;
  setWorkbenchWidth: Dispatch<SetStateAction<number>>;
  setWorkbenchVisible: Dispatch<SetStateAction<boolean>>;
  selectedThreadId: string | null;
  startChatRun: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: NonNullable<AppBootstrap['state']>;
  submitTaskDetailInput: (request: TaskDetailInputRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  taskBoardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number };
  taskLiveRunState: ChatRunState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
  workbenchPanel: React.LazyExoticComponent<(props: {
    activeTool: WorkbenchTool;
    activeView: ViewId;
    client: RocClient;
    onToolChange: Dispatch<SetStateAction<WorkbenchTool>>;
    onClose: () => void;
    state: NonNullable<AppBootstrap['state']>;
    updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
    workspaceLoadState: LazyLoadState;
    width: number;
    onWidthChange: Dispatch<SetStateAction<number>>;
    windowState: WindowStateSnapshot;
  }) => React.JSX.Element>;
  workbenchVisible: boolean;
  workbenchWidth: number;
  windowState: WindowStateSnapshot;
  workspaceLoadState: LazyLoadState;
}

export function AppWorkspaceShell({
  activeTaskDetailId,
  activeView,
  activeWorkbenchTool,
  chatSelectionVersion,
  client,
  clearDeletingTaskSelection,
  createTaskFromWorkbench,
  memoryLoadState,
  openTaskDetail,
  operationsLoadState,
  resumeTaskApprovalFromDetail,
  returnToTaskBoard,
  selectWorkspaceFromDialog,
  setActiveView,
  setActiveWorkbenchTool,
  setSelectedTaskSurfaceTaskId,
  setState,
  setTaskBoardUiState,
  setWorkbenchWidth,
  setWorkbenchVisible,
  selectedThreadId,
  startChatRun,
  state,
  submitTaskDetailInput,
  taskBoardUiState,
  taskLiveRunState,
  updateWorkspaceData,
  workbenchPanel: WorkbenchPanel,
  workbenchVisible,
  workbenchWidth,
  windowState,
  workspaceLoadState
}: AppWorkspaceShellProps): React.JSX.Element {
  const hasWorkbench = activeView === 'chat' ? workbenchVisible : WORKBENCH_VIEWS.has(activeView);
  const workspaceShellStyle = hasWorkbench ? { '--workbench-width': `${workbenchWidth}px` } as CSSProperties : undefined;
  const workspaceShellClassName =
    activeView === 'chat'
      ? hasWorkbench
        ? 'workspace-shell workspace-shell--chat'
        : 'workspace-shell workspace-shell--chat-collapsed'
      : hasWorkbench
        ? 'workspace-shell workspace-shell--with-workbench'
        : 'workspace-shell';

  return (
    <div style={workspaceShellStyle} className={workspaceShellClassName}>
      <main className={activeView === 'chat' ? 'workspace-main workspace-main--chat' : 'workspace-main'} data-testid="active-view">
        <section className={activeView === 'chat' ? 'canvas canvas--chat' : 'canvas'}>
          <div className="canvas-scroll">
            <ViewContent
              activeView={activeView}
              chatSelectionVersion={chatSelectionVersion}
              client={client}
              liveTaskRun={taskLiveRunState.mode === 'task' ? taskLiveRunState : null}
              memoryLoadState={memoryLoadState}
              onOpenTaskDetail={openTaskDetail}
              onTaskApprovalDecision={resumeTaskApprovalFromDetail}
              onBackToTaskBoard={returnToTaskBoard}
              onDeleteTaskStarted={clearDeletingTaskSelection}
              operationsLoadState={operationsLoadState}
              onQueueTaskPrompt={createTaskFromWorkbench}
              onSelectWorkspace={selectWorkspaceFromDialog}
              onSubmitChatTask={startChatRun}
              onSubmitTaskDetailInput={submitTaskDetailInput}
              onTaskSurfaceSelectionChange={setSelectedTaskSurfaceTaskId}
              selectedTaskDetailId={activeTaskDetailId}
              selectedThreadId={selectedThreadId}
              state={state}
              taskBoardUiState={taskBoardUiState}
              onTaskBoardUiStateChange={setTaskBoardUiState}
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
        <Suspense fallback={<aside className="workbench" data-testid="workbench-panel" />}>
          <WorkbenchPanel
            activeTool={activeWorkbenchTool}
            activeView={activeView}
            client={client}
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
        </Suspense>
      ) : null}
    </div>
  );
}
