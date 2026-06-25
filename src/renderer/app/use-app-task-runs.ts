import type { Dispatch, SetStateAction } from 'react';
import { useCallback } from 'react';

import type { ChatStartRunRequest } from '../../shared/types';
import type { ChatTaskSubmitPayload } from '../chat/task-run-payload';
import type { ChatFeatureActions } from '../features/chat/use-chat-feature';
import type { RocClient } from '../shared/roc-client';
import type { TaskDetailApprovalRequest, TaskDetailInputRequest } from '../views/tasks/TaskDetailView';
import type { TaskPromptSubmission } from '../views/tasks/TasksView';
import { loadTaskSurfaceData } from './data-loading';
import { loadTaskSurfaceForCreatedRun } from './task-creation-surface';
import type { HistoryContextMenuState } from './types';
import type { AppBootstrap } from './use-app-bootstrap';

interface UseAppTaskRunsOptions {
  chatFeature: ChatFeatureActions;
  client: RocClient;
  currentSelectedMcpServers: string[];
  currentSelectedSkills: string[];
  openTaskDetail: (taskId: string, boardUiState?: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  pendingTaskSource: ChatStartRunRequest['taskSource'] | null;
  pendingWorkflowHint: ChatStartRunRequest['workflowHint'];
  refreshTaskState: () => Promise<void>;
  selectedThreadId: string | null;
  setHistoryContextMenu: Dispatch<SetStateAction<HistoryContextMenuState | null>>;
  setPendingTaskSource: (value: ChatStartRunRequest['taskSource'] | null) => void;
  setPendingWorkflowHint: (value: ChatStartRunRequest['workflowHint']) => void;
  setSelectedTaskSurfaceTaskId: (value: string | null | undefined) => void;
  setSelectedThreadId: (value: string) => void;
  setState: AppBootstrap['setState'];
  taskBoardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number };
}

type TaskRunStartOptions = {
  threadId: string | null;
};

export function useAppTaskRuns({
  chatFeature,
  client,
  currentSelectedMcpServers,
  currentSelectedSkills,
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
}: UseAppTaskRunsOptions): {
  createTaskFromWorkbench: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  resumeTaskApprovalFromDetail: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  startChatRun: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitTaskDetailInput: (request: TaskDetailInputRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
} {
  const startChatRun = useCallback(
    async (payload: ChatTaskSubmitPayload): Promise<{ ok: true } | { ok: false; error: string }> => {
      const request: ChatStartRunRequest = {
        input: payload.input,
        mode: 'chat',
        threadId: selectedThreadId,
        enabledCapabilities: {
          mcpServers: currentSelectedMcpServers,
          skills: currentSelectedSkills
        },
        workflowHint: null,
        taskSource: null,
        workspacePath: null
      };
      if (payload.explicitSkillIds !== undefined) {
        request.explicitSkillIds = payload.explicitSkillIds;
      }
      const result = await chatFeature.startRun(request);
      setPendingWorkflowHint(null);
      setPendingTaskSource(null);
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }
      if (result.data.threadId === null) {
        return { ok: false, error: '聊天运行没有返回可打开的会话。' };
      }
      setSelectedThreadId(result.data.threadId);
      setHistoryContextMenu(null);
      return { ok: true };
    },
    [
      chatFeature,
      currentSelectedMcpServers,
      currentSelectedSkills,
      selectedThreadId,
      setHistoryContextMenu,
      setPendingTaskSource,
      setPendingWorkflowHint,
      setSelectedThreadId
    ]
  );

  const startTaskRun = useCallback(
    async (payload: ChatTaskSubmitPayload, options?: TaskRunStartOptions): Promise<{ ok: true; runId: string; threadId: string } | { ok: false; error: string }> => {
      const workflowHint = payload.workflowHint === undefined ? pendingWorkflowHint : payload.workflowHint;
      const taskSource = payload.taskSource === undefined ? pendingTaskSource : payload.taskSource;
      const threadId = options === undefined ? selectedThreadId : options.threadId;
      const requestWorkflowHint = workflowHint === undefined ? null : workflowHint;
      const requestTaskSource = taskSource === undefined ? null : taskSource;
      const requestWorkspacePath = payload.workspacePath === undefined ? null : payload.workspacePath;
      const request: ChatStartRunRequest = {
        input: payload.input,
        mode: 'task',
        threadId,
        enabledCapabilities: {
          mcpServers: currentSelectedMcpServers,
          skills: currentSelectedSkills
        },
        workflowHint: requestWorkflowHint,
        taskSource: requestTaskSource,
        workspacePath: requestWorkspacePath
      };
      if (payload.explicitSkillIds !== undefined) {
        request.explicitSkillIds = payload.explicitSkillIds;
      }
      const result = await chatFeature.startRun(request);
      setPendingWorkflowHint(null);
      setPendingTaskSource(null);
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }
      if (result.data.threadId === null) {
        return { ok: false, error: '任务运行没有返回可打开的会话。' };
      }
      setHistoryContextMenu(null);
      return { ok: true, runId: result.data.runId, threadId: result.data.threadId };
    },
    [
      chatFeature,
      currentSelectedMcpServers,
      currentSelectedSkills,
      pendingTaskSource,
      pendingWorkflowHint,
      selectedThreadId,
      setHistoryContextMenu,
      setPendingTaskSource,
      setPendingWorkflowHint
    ]
  );

  const createTaskFromWorkbench = useCallback(
    async (payload: TaskPromptSubmission): Promise<{ ok: true } | { ok: false; error: string }> => {
      const existingActiveTasksResult = await client.api.tasks.getActiveTasks();
      if (!existingActiveTasksResult.ok) {
        return { ok: false, error: existingActiveTasksResult.error.message };
      }
      const existingTaskIds = new Set(
        existingActiveTasksResult.data
          .map((task) => task.taskId)
          .filter((taskId): taskId is string => taskId !== null)
      );
      const result = await startTaskRun({
        input: payload.input,
        workflowHint: payload.workflowHint,
        taskSource: payload.taskSource,
        workspacePath: payload.workspacePath
      });
      if (!result.ok) {
        return result;
      }
      const createdTaskSurface = await loadTaskSurfaceForCreatedRun(client, {
        runId: result.runId,
        threadId: result.threadId
      }, existingTaskIds);
      if (!createdTaskSurface.ok) {
        return { ok: false, error: createdTaskSurface.error };
      }
      setState((current) => (current === null ? current : { ...current, ...createdTaskSurface.data }));
      openTaskDetail(createdTaskSurface.taskId, taskBoardUiState);
      return { ok: true };
    },
    [client, openTaskDetail, setState, startTaskRun, taskBoardUiState]
  );

  const submitTaskDetailInput = useCallback(
    async ({ input, taskId, threadId }: TaskDetailInputRequest): Promise<{ ok: true } | { ok: false; error: string }> => {
      setSelectedTaskSurfaceTaskId(taskId);
      const result = await startTaskRun({
        input,
        workflowHint: 'background_task_change',
        taskSource: 'workbench'
      }, { threadId });
      if (!result.ok) {
        return result;
      }
      const taskSurfaceData = await loadTaskSurfaceData(taskId, client);
      setState((current) => (current === null ? current : { ...current, ...taskSurfaceData }));
      return { ok: true };
    },
    [client, setSelectedTaskSurfaceTaskId, setState, startTaskRun]
  );

  const resumeTaskApprovalFromDetail = useCallback(
    async (request: TaskDetailApprovalRequest): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await chatFeature.resumeRun(request);
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }
      await refreshTaskState();
      return { ok: true };
    },
    [chatFeature, refreshTaskState]
  );

  return {
    createTaskFromWorkbench,
    resumeTaskApprovalFromDetail,
    startChatRun,
    submitTaskDetailInput
  };
}
