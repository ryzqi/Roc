import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundTask, BackgroundTaskPreview, ScheduledTaskRun, SchedulerStatus } from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { errorMessage } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import {
  createBackgroundTask,
  dispatchTaskAction,
  getSchedulerStatus,
  listBackgroundTasks,
  listScheduledRuns,
  previewBackgroundTask,
  updateBackgroundTask,
  type TaskListAction
} from '../tasks/task-store';
import {
  draftFromTask,
  emptyTaskDraft,
  toPreviewRequest,
  toUpdatePatch,
  validateTaskDraft,
  type TaskDraft,
  type TaskDraftIssue
} from './background-task-model';

/**
 * Background-task management data (P9/T9.4).
 *
 * ## Why this is not `useTasksStore`
 *
 * P6's board reads `task.active.list` (an `ActiveTaskItem` summary) and one task's detail; the
 * management surface needs **every** background task — including failed, cancelled and archived
 * ones, which is where the actions (resume/cancel/delete) actually live — so it reads
 * `task.background.list`. Both surfaces share the wrappers, the action dispatcher and the
 * `tasks.onUpdated` push channel, which is the part that must not be copied (P4/P5/P7 each lost a
 * panel to a one-shot snapshot read).
 *
 * ## The create flow is preview-first
 *
 * `tasks.createBackgroundTaskPreview` returns the facts the user is being asked to accept —
 * `scheduled`, `cronExpression`, `nextRunAt`, `riskLevel`, `requiresConfirmation` — and the same
 * request object is then sent to `createBackgroundTask`. Nothing in between is recomputed here,
 * so what was previewed is what gets created.
 */

export type BackgroundTasksStore = {
  status: AsyncStatus;
  error: string | null;
  tasks: BackgroundTask[];
  scheduler: SchedulerStatus | null;
  reload: () => void;
  selectedId: string | null;
  select: (taskId: string | null) => void;
  selected: BackgroundTask | null;
  runs: ScheduledTaskRun[];
  runsStatus: AsyncStatus;
  runsError: string | null;
  reloadRuns: () => void;
  mode: 'create' | 'edit' | null;
  draft: TaskDraft | null;
  issues: TaskDraftIssue[];
  startCreate: () => void;
  startEdit: (task: BackgroundTask) => void;
  cancelEdit: () => void;
  setDraft: (next: TaskDraft) => void;
  preview: BackgroundTaskPreview | null;
  previewPending: boolean;
  previewError: string | null;
  runPreview: () => Promise<boolean>;
  create: { pending: boolean; error: string | null; run: () => Promise<boolean> };
  update: { pending: boolean; error: string | null; run: () => Promise<boolean> };
  action: { pending: boolean; error: string | null; run: (action: TaskListAction, taskId: string) => Promise<boolean> };
};

export function useBackgroundTasks(client: RocClient, workspacePath: string | null): BackgroundTasksStore {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [runsStatus, setRunsStatus] = useState<AsyncStatus>('idle');
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsNonce, setRunsNonce] = useState(0);

  const [mode, setMode] = useState<'create' | 'edit' | null>(null);
  const [draft, setDraftState] = useState<TaskDraft | null>(null);
  const [preview, setPreview] = useState<BackgroundTaskPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);
  const reloadRuns = useCallback(() => {
    setRunsNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, schedulerStatus] = await Promise.all([listBackgroundTasks(client), getSchedulerStatus(client)]);
        if (cancelled) {
          return;
        }
        if (!list.ok) {
          setStatus('error');
          setError(list.error.message);
          return;
        }
        setTasks(list.data);
        // The scheduler read is allowed to fail on its own: the list is still useful without it.
        setScheduler(schedulerStatus.ok ? schedulerStatus.data : null);
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

  /** Push refresh: a run started elsewhere (or by the scheduler) must appear without a reload. */
  useEffect(
    () =>
      client.api.tasks.onUpdated(() => {
        if (!mountedRef.current) {
          return;
        }
        setNonce((current) => current + 1);
        setRunsNonce((current) => current + 1);
      }),
    [client]
  );

  useEffect(() => {
    if (selectedId === null) {
      setRuns([]);
      setRunsStatus('idle');
      setRunsError(null);
      return;
    }
    let cancelled = false;
    setRunsStatus('loading');
    void (async () => {
      try {
        const result = await listScheduledRuns(client, { taskId: selectedId, limit: 20 });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setRunsStatus('error');
          setRunsError(result.error.message);
          return;
        }
        setRuns(result.data);
        setRunsStatus('ready');
        setRunsError(null);
      } catch (caught) {
        if (!cancelled) {
          setRunsStatus('error');
          setRunsError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedId, runsNonce]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId]
  );

  const issues = useMemo(() => (draft === null ? [] : validateTaskDraft(draft, workspacePath)), [draft, workspacePath]);

  const setDraft = useCallback((next: TaskDraft) => {
    setDraftState(next);
    setPreview(null);
    setPreviewError(null);
    setMutationError(null);
  }, []);

  const startCreate = useCallback(() => {
    setMode('create');
    setSelectedId(null);
    setDraftState(emptyTaskDraft());
    setPreview(null);
    setPreviewError(null);
    setMutationError(null);
  }, []);

  const startEdit = useCallback((task: BackgroundTask) => {
    setMode('edit');
    setSelectedId(task.id);
    setDraftState(draftFromTask(task));
    setPreview(null);
    setPreviewError(null);
    setMutationError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setMode(null);
    setDraftState(null);
    setPreview(null);
    setPreviewError(null);
    setMutationError(null);
  }, []);

  const runPreview = useCallback(async (): Promise<boolean> => {
    if (draft === null || workspacePath === null || issues.length > 0) {
      return false;
    }
    setPreviewPending(true);
    setPreviewError(null);
    try {
      const result = await previewBackgroundTask(client, toPreviewRequest(draft, workspacePath));
      if (!result.ok) {
        setPreviewError(result.error.message);
        return false;
      }
      setPreview(result.data);
      return true;
    } catch (caught) {
      setPreviewError(errorMessage(caught));
      return false;
    } finally {
      setPreviewPending(false);
    }
  }, [client, draft, issues.length, workspacePath]);

  const create = useCallback(async (): Promise<boolean> => {
    if (draft === null || workspacePath === null || issues.length > 0) {
      return false;
    }
    setPending(true);
    setMutationError(null);
    try {
      const result = await createBackgroundTask(client, toPreviewRequest(draft, workspacePath));
      if (!result.ok) {
        setMutationError(result.error.message);
        return false;
      }
      setMode(null);
      setDraftState(null);
      setPreview(null);
      setSelectedId(result.data.id);
      reload();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, draft, issues.length, reload, workspacePath]);

  const update = useCallback(async (): Promise<boolean> => {
    if (draft === null || workspacePath === null || selectedId === null || issues.length > 0) {
      return false;
    }
    if (draft.reason.trim().length === 0) {
      setMutationError('修改后台任务必须填写原因。');
      return false;
    }
    setPending(true);
    setMutationError(null);
    try {
      const result = await updateBackgroundTask(client, {
        taskId: selectedId,
        patch: toUpdatePatch(draft, workspacePath),
        reason: draft.reason.trim()
      });
      if (!result.ok) {
        setMutationError(result.error.message);
        return false;
      }
      setMode(null);
      setDraftState(null);
      reload();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, draft, issues.length, reload, selectedId, workspacePath]);

  const runAction = useCallback(
    async (action: TaskListAction, taskId: string): Promise<boolean> => {
      setActionPending(true);
      setActionError(null);
      try {
        const result = await dispatchTaskAction(client, action, taskId);
        if (!result.ok) {
          setActionError(result.error.message);
          return false;
        }
        if (action === 'delete' && selectedId === taskId) {
          setSelectedId(null);
        }
        reload();
        reloadRuns();
        return true;
      } catch (caught) {
        setActionError(errorMessage(caught));
        return false;
      } finally {
        setActionPending(false);
      }
    },
    [client, reload, reloadRuns, selectedId]
  );

  return useMemo(
    () => ({
      status,
      error,
      tasks,
      scheduler,
      reload,
      selectedId,
      select: setSelectedId,
      selected,
      runs,
      runsStatus,
      runsError,
      reloadRuns,
      mode,
      draft,
      issues,
      startCreate,
      startEdit,
      cancelEdit,
      setDraft,
      preview,
      previewPending,
      previewError,
      runPreview,
      create: { pending, error: mutationError, run: create },
      update: { pending, error: mutationError, run: update },
      action: { pending: actionPending, error: actionError, run: runAction }
    }),
    [
      status,
      error,
      tasks,
      scheduler,
      reload,
      selectedId,
      selected,
      runs,
      runsStatus,
      runsError,
      reloadRuns,
      mode,
      draft,
      issues,
      startCreate,
      startEdit,
      cancelEdit,
      setDraft,
      preview,
      previewPending,
      previewError,
      runPreview,
      pending,
      mutationError,
      create,
      update,
      actionPending,
      actionError,
      runAction
    ]
  );
}
