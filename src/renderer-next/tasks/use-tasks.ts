import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveTaskItem,
  BackgroundTaskPreviewRequest,
  SchedulerStatus,
  TaskDetail,
  TaskSnapshot
} from '../../shared/types';
import { errorMessage } from '../app/loaded-state';
import type { AsyncStatus } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import {
  cancelBackgroundTask,
  deleteBackgroundTask,
  getActiveTasks,
  getSchedulerStatus,
  getSnapshot,
  getTaskDetail,
  pauseBackgroundTask,
  resumeBackgroundTask,
  runBackgroundNow,
  updateBackgroundTask
} from './task-store';

/**
 * Task-board data (P6/T6.6).
 *
 * **The refresh path is the point of this hook.** P4's session list and P5's ⌘K project group
 * each shipped with a one-shot snapshot read, and each showed a permanently empty panel once
 * the data arrived after mount. The task board has exactly the same shape — a task created by
 * a chat run while the board is open must appear by itself — so it subscribes to
 * `tasks.onUpdated` (the only push channel in this domain) and re-reads the snapshot, the
 * active list and the selected detail on every event.
 *
 * Reads are split the way the contract splits them: `task.snapshot.get` gives counts + threads
 * + recent events, `task.active.list` gives the background tasks the board renders, and
 * `task.detail.get` gives one task's full record. The detail is refreshed with the snapshot so
 * an approval completed in another surface cannot leave a stale card here.
 */

export type TaskListAction = 'pause' | 'resume' | 'cancel' | 'runNow' | 'delete';

export type TasksStore = {
  status: AsyncStatus;
  error: string | null;
  snapshot: TaskSnapshot | null;
  activeTasks: ActiveTaskItem[];
  scheduler: SchedulerStatus | null;
  detail: TaskDetail | null;
  detailStatus: AsyncStatus;
  detailError: string | null;
  selectedTaskId: string | null;
  selectTask: (taskId: string | null) => void;
  busy: boolean;
  actionError: string | null;
  dismissActionError: () => void;
  refresh: () => void;
  runListAction: (action: TaskListAction, taskId: string) => Promise<boolean>;
  runUpdate: (input: { taskId: string; patch: Partial<BackgroundTaskPreviewRequest>; reason: string }) => Promise<boolean>;
};

/**
 * One board action → one capability.
 *
 * A `switch` rather than a chain of ternaries: the five capabilities take a **bare id string**
 * (F18) but return different payloads, so the branch is about which call to make, not about a
 * shared shape — and a table is what makes a sixth action a one-line addition.
 */
async function dispatchTaskAction(
  client: RocClient,
  action: TaskListAction,
  taskId: string
): Promise<{ ok: true } | { ok: false; error: { message: string } }> {
  switch (action) {
    case 'pause':
      return pauseBackgroundTask(client, taskId);
    case 'resume':
      return resumeBackgroundTask(client, taskId);
    case 'cancel':
      return cancelBackgroundTask(client, taskId);
    case 'runNow':
      return runBackgroundNow(client, taskId);
    case 'delete':
      return deleteBackgroundTask(client, taskId);
    default:
      // Exhaustive over `TaskListAction`; the default keeps a future sixth action from
      // silently doing nothing.
      throw new Error(`unknown_task_action:${String(action)}`);
  }
}

export function useTasksStore(client: RocClient): TasksStore {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [activeTasks, setActiveTasks] = useState<ActiveTaskItem[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<AsyncStatus>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [snapshotResult, activeResult, schedulerResult] = await Promise.all([
          getSnapshot(client),
          getActiveTasks(client),
          getSchedulerStatus(client)
        ]);
        if (cancelled) {
          return;
        }
        if (!snapshotResult.ok) {
          setStatus('error');
          setError(snapshotResult.error.message);
          return;
        }
        setSnapshot(snapshotResult.data);
        setActiveTasks(activeResult.ok ? activeResult.data : []);
        setScheduler(schedulerResult.ok ? schedulerResult.data : null);
        setStatus('ready');
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setStatus('error');
          setError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, nonce]);

  /** Push refresh: the only signal the backend sends for this domain (T6.6 实时). */
  useEffect(
    () =>
      client.api.tasks.onUpdated(() => {
        if (!mountedRef.current) {
          return;
        }
        setNonce((current) => current + 1);
        setDetailNonce((current) => current + 1);
      }),
    [client]
  );

  useEffect(() => {
    if (selectedTaskId === null) {
      setDetail(null);
      setDetailStatus('idle');
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailStatus('loading');
    void (async () => {
      try {
        const result = await getTaskDetail(client, selectedTaskId);
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setDetailStatus('error');
          setDetailError(result.error.message);
          return;
        }
        // A task that disappeared (deleted elsewhere) must not keep rendering.
        setDetail(result.data);
        setDetailStatus('ready');
        setDetailError(null);
      } catch (caught) {
        if (!cancelled) {
          setDetailStatus('error');
          setDetailError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedTaskId, detailNonce]);

  const runListAction = useCallback(
    async (action: TaskListAction, taskId: string): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        const result = await dispatchTaskAction(client, action, taskId);
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        if (action === 'delete' && selectedTaskId === taskId) {
          setSelectedTaskId(null);
        }
        setNonce((current) => current + 1);
        setDetailNonce((current) => current + 1);
        return true;
      } catch (caught) {
        setActionError(errorMessage(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, selectedTaskId]
  );

  const runUpdate = useCallback(
    async (input: {
      taskId: string;
      patch: Partial<BackgroundTaskPreviewRequest>;
      reason: string;
    }): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        const result = await updateBackgroundTask(client, input);
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        setNonce((current) => current + 1);
        setDetailNonce((current) => current + 1);
        return true;
      } catch (caught) {
        setActionError(errorMessage(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client]
  );

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  return useMemo(
    () => ({
      status,
      error,
      snapshot,
      activeTasks,
      scheduler,
      detail,
      detailStatus,
      detailError,
      selectedTaskId,
      selectTask: setSelectedTaskId,
      busy,
      actionError,
      dismissActionError,
      refresh,
      runListAction,
      runUpdate
    }),
    [
      status,
      error,
      snapshot,
      activeTasks,
      scheduler,
      detail,
      detailStatus,
      detailError,
      selectedTaskId,
      busy,
      actionError,
      dismissActionError,
      refresh,
      runListAction,
      runUpdate
    ]
  );
}
