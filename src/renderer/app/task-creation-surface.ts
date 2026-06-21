import type { ChatRunEvent } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import type { TaskSurfaceData } from './types';
import { loadTaskSurfaceData } from './data-loading';

const taskCreationCompletedSurfacePollLimit = 8;
const taskCreationSurfacePollDelayMs = 250;

type TaskCreationRun = {
  runId: string;
  threadId: string;
};

type TaskCreationTerminalEvent = Extract<ChatRunEvent, { type: 'run_completed' | 'run_failed' | 'run_interrupted' }>;

export async function loadTaskSurfaceForCreatedRun(
  client: RocClient,
  creationRun: TaskCreationRun,
  existingTaskIds: ReadonlySet<string>
): Promise<{ ok: true; taskId: string; data: TaskSurfaceData } | { ok: false; error: string }> {
  const terminalEventRef: { current: TaskCreationTerminalEvent | null } = { current: null };
  let completedSurfacePollCount = 0;
  const unsubscribe = client.api.chat.onRunEvent((event) => {
    if (event.runId !== creationRun.runId || !isTaskCreationTerminalEvent(event)) {
      return;
    }
    terminalEventRef.current = event;
  });
  try {
    while (true) {
      const surface = await loadTaskSurfaceData(undefined, client);
      const createdTask = findCreatedTaskSurfaceItem(surface.activeTasks, creationRun.threadId, existingTaskIds);
      if (createdTask !== null) {
        return {
          ok: true,
          taskId: createdTask.taskId,
          data: await loadTaskSurfaceData(createdTask.taskId, client)
        };
      }
      const terminalEvent = terminalEventRef.current;
      if (terminalEvent !== null) {
        if (terminalEvent.type !== 'run_completed') {
          return { ok: false, error: formatTaskCreationTerminalError(terminalEvent) };
        }
        if (completedSurfacePollCount >= taskCreationCompletedSurfacePollLimit) {
          return { ok: false, error: formatTaskCreationTerminalError(terminalEvent) };
        }
        completedSurfacePollCount += 1;
      }
      await waitForTaskCreationSurfacePoll();
    }
  } finally {
    unsubscribe();
  }
}

function findCreatedTaskSurfaceItem(
  activeTasks: TaskSurfaceData['activeTasks'],
  threadId: string,
  existingTaskIds: ReadonlySet<string>
): TaskSurfaceData['activeTasks'][number] | null {
  const matchingThreadTask = activeTasks.find((item) => item.threadId === threadId);
  if (matchingThreadTask !== undefined) {
    return matchingThreadTask;
  }

  const newTasks = activeTasks.filter((item) => !existingTaskIds.has(item.taskId));
  if (newTasks.length === 1) {
    return newTasks[0];
  }

  return null;
}

function isTaskCreationTerminalEvent(event: ChatRunEvent): event is TaskCreationTerminalEvent {
  return event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_interrupted';
}

function formatTaskCreationTerminalError(event: TaskCreationTerminalEvent): string {
  if (event.type === 'run_failed') {
    return event.message;
  }
  if (event.type === 'run_interrupted') {
    return '任务创建需要人工确认，请在任务详情中处理。';
  }
  return '任务创建流程已结束，但没有创建后台任务。';
}

async function waitForTaskCreationSurfacePoll(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, taskCreationSurfacePollDelayMs);
  });
}
