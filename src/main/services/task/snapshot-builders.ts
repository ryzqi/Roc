import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskSummary,
  EnabledCapabilities,
  TaskDetail,
  TaskEvent,
  TaskRun,
  TaskSnapshot,
  TaskThread
} from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { requireBackgroundTask } from './background-task-mapping';
import { requireActiveThread } from './thread-queries';
import { triggerFromBackgroundTask } from './background-task-lifecycle';
import { listBackgroundTasks } from './background-task-lifecycle';

const taskDetailRunHistoryLimit = 20;
const taskDetailRecentEventLimit = 20;

export function getBackgroundTaskSummary(input: { database: DatabaseService }): BackgroundTaskSummary {
  const rows = input.database.db
    .prepare(
      `SELECT status, next_run_at
       FROM background_tasks
       WHERE status != 'archived'
       ORDER BY updated_at DESC`
    )
    .all() as Array<{ status: TaskThread['status']; next_run_at: string | null }>;
  const futureRuns = rows
    .map((row) => row.next_run_at)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    total: rows.length,
    running: rows.filter((row) => row.status === 'running').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    pendingConfirmation: rows.filter((row) => row.status === 'pending_confirmation').length,
    nextRunAt: futureRuns.length === 0 ? null : futureRuns[0]
  };
}

export function getActiveTasks(input: { database: DatabaseService }): ActiveTaskItem[] {
  return listBackgroundTasks({ database: input.database })
    .filter((task) => task.status !== 'archived')
    .map((task) => activeItemFromBackgroundTask(task))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getTaskDetail(input: { database: DatabaseService; taskId: string; schedulerRegistered: boolean }): TaskDetail {
  const task = requireBackgroundTask(input.database, input.taskId);
  const thread = requireActiveThread(input.database, task.threadId);
  const runHistory = listRunsForThread(input.database, task.threadId, taskDetailRunHistoryLimit);
  const lastRunId = runHistory[0]?.id ?? null;
  const recentEvents = mergeTaskEvents([
    listRecentEventsForThread(input.database, task.threadId, taskDetailRecentEventLimit),
    lastRunId === null ? [] : listEventsForRun(input.database, task.threadId, lastRunId)
  ]);
  return {
    threadId: task.threadId,
    taskId: task.id,
    thread,
    backgroundTask: task,
    lastRunId,
    runHistory,
    recentEvents,
    schedulerRegistered: input.schedulerRegistered
  };
}

export function getSnapshot(input: { database: DatabaseService }): TaskSnapshot {
  const threads = input.database.db
    .prepare(
      `SELECT id, kind, title, goal, status, created_at, updated_at
       FROM task_threads
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all() as Array<{
    id: string;
    kind: TaskThread['kind'];
    title: string;
    goal: string;
    status: TaskThread['status'];
    created_at: string;
    updated_at: string;
  }>;

  const recentEvents = input.database.db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id IN (SELECT id FROM task_threads WHERE archived_at IS NULL)
       ORDER BY created_at DESC, rowid DESC
       LIMIT 50`
    )
    .all() as Array<{
    rowid: number;
    id: string;
    thread_id: string;
    run_id: string;
    type: TaskEvent['type'];
    payload_json: string;
    created_at: string;
  }>;

  const normalizedThreads: TaskThread[] = threads.map((thread) => ({
    id: thread.id,
    kind: thread.kind,
    title: thread.title,
    goal: thread.goal,
    status: thread.status,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at
  }));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: normalizedThreads.length,
      running: normalizedThreads.filter((thread) => thread.status === 'running').length,
      failed: normalizedThreads.filter((thread) => thread.status === 'failed').length,
      pendingConfirmation: normalizedThreads.filter((thread) => thread.status === 'pending_confirmation').length
    },
    threads: normalizedThreads,
    recentEvents: recentEvents.map((event) => ({
      id: event.id,
      threadId: event.thread_id,
      runId: event.run_id,
      type: event.type,
      payload: JSON.parse(event.payload_json) as unknown,
      createdAt: event.created_at,
      sequence: event.rowid
    }))
  };
}

function activeItemFromBackgroundTask(task: BackgroundTask): ActiveTaskItem {
  return {
    kind: 'background',
    threadId: task.threadId,
    taskId: task.id,
    title: task.goal.slice(0, 60),
    goal: task.goal,
    status: resolveActiveTaskStatus(task),
    trigger: resolveActiveTaskTrigger(task),
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    riskLevel: task.riskLevel,
    workspacePath: task.workspacePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function resolveActiveTaskStatus(task: BackgroundTask): BackgroundTask['status'] {
  if (task.lastRunStatus === null && task.lastRunAt !== null && task.status === 'completed') {
    return 'running';
  }
  return task.status;
}

function resolveActiveTaskTrigger(task: BackgroundTask): ActiveTaskItem['trigger'] {
  if (task.triggerType === 'once' && task.nextRunAt === null) {
    return {
      type: 'once',
      description: task.triggerDescription,
      nextRunAt: task.lastRunAt ?? task.updatedAt
    };
  }
  return triggerFromBackgroundTask(task);
}

function listRunsForThread(database: DatabaseService, threadId: string, limit: number): TaskRun[] {
  const rows = database.db
    .prepare(
      `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
       FROM task_runs
       WHERE thread_id = ?
       ORDER BY run_number DESC
       LIMIT ?`
    )
    .all(threadId, limit) as Array<{
    id: string;
    thread_id: string;
    run_number: number;
    user_input: string;
    status: TaskRun['status'];
    started_at: string;
    ended_at: string | null;
    model_id: string | null;
    enabled_capabilities_json: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    runNumber: row.run_number,
    userInput: row.user_input,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    modelId: row.model_id,
    enabledCapabilities: JSON.parse(row.enabled_capabilities_json) as EnabledCapabilities
  }));
}

function listRecentEventsForThread(database: DatabaseService, threadId: string, limit: number): TaskEvent[] {
  const rows = database.db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(threadId, limit) as Array<{
    rowid: number;
    id: string;
    thread_id: string;
    run_id: string;
    type: TaskEvent['type'];
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    sequence: row.rowid
  }));
}

function listEventsForRun(database: DatabaseService, threadId: string, runId: string): TaskEvent[] {
  const rows = database.db
    .prepare(
      `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
       FROM task_events
       WHERE thread_id = ? AND run_id = ?
       ORDER BY created_at DESC, rowid DESC`
    )
    .all(threadId, runId) as Array<{
    rowid: number;
    id: string;
    thread_id: string;
    run_id: string;
    type: TaskEvent['type'];
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
    sequence: row.rowid
  }));
}

function mergeTaskEvents(eventGroups: readonly TaskEvent[][]): TaskEvent[] {
  const eventsById = new Map<string, TaskEvent>();
  for (const events of eventGroups) {
    for (const event of events) {
      if (!eventsById.has(event.id)) {
        eventsById.set(event.id, event);
      }
    }
  }
  return [...eventsById.values()].sort(compareTaskEventsDescending);
}

function compareTaskEventsDescending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (right.sequence ?? 0) - (left.sequence ?? 0);
}
