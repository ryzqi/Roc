import { useEffect, useRef, useState } from 'react';
import {Loader2} from 'lucide-react';
import type { ResearchTaskDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import { useAsyncAction } from '../../app/use-async-resource';
import { formSecondaryButtonClass } from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';
import {recordUxEvent} from '../../app/ux-metrics';
import { ConfirmDialog } from '../../shell/ConfirmDialog';

type TaskAction = 'pause' | 'cancel' | 'continue' | 'restoreApproval';

export function TaskControls({ client, data, onChanged, surface = 'tasks' }: {
  client: RocClient; data: ResearchTaskDiagnostics; onChanged: () => void; surface?: 'assistant' | 'tasks';
}): React.JSX.Element {
  const [intent, setIntent] = useState<TaskAction | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const taskKey = JSON.stringify([data.task.projectId, data.task.id]);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { setCancelTarget(null); }, [taskKey, data.task.status]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const action = useAsyncAction(async (type: TaskAction) => {
    const request = { projectId: data.task.projectId, taskId: data.task.id };
    switch (type) {
      case 'pause': return client.api.research.pauseTask(request);
      case 'cancel': return client.api.research.cancelTask(request);
      case 'restoreApproval': return client.api.research.restoreTaskApproval(request);
      case 'continue': {
        if (data.continuationRunId === null) throw new Error('research_task_continuation_missing');
        const result = await client.api.research.continueTask({
          ...request, runId: data.continuationRunId, requestId: crypto.randomUUID()
        });
        return result.ok ? { ok: true as const, data: null } : result;
      }
    }
  }, { label: '修改科研任务' });
  const status = data.task.status;
  const cleanupPending = data.task.statusReason === 'research_task_cleanup_pending';
  const cleanupFailed = data.task.statusReason === 'research_task_cleanup_failed';
  const unconfirmed = cleanupPending || cleanupFailed;
  const pending = action.pending || cleanupPending;
  const error = action.error ?? (cleanupFailed ? data.task.statusReason : null);
  const canContinue = ['paused', 'interrupted', 'failed', 'cancelled'].includes(status) &&
    data.continuationRunId !== null && !data.canRestoreApproval && !unconfirmed;
  const run = (type: TaskAction): void => {
    if (running.current) return;
    running.current = true;
    recordUxEvent('action_initiated', surface);
    setIntent(type);
    void action.run(type).then(() => {
      // Cleanup failures can still change the authoritative task state.
      if (mounted.current) onChanged();
    }).finally(() => { running.current = false; });
  };
  return (
    <div className="grid gap-1" data-testid="task-controls" aria-busy={pending}>
      <div className="flex flex-wrap gap-2">
        {status === 'active' || status === 'waiting_approval' ? (
          <button type="button" className={formSecondaryButtonClass} disabled={pending}
            data-testid="task-pause" onClick={() => run('pause')}>{action.pending && intent === 'pause' ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}暂停任务</button>
        ) : null}
        {status !== 'completed' && status !== 'cancelled' ? (
          <button type="button" className={formSecondaryButtonClass} disabled={pending}
            data-testid="task-cancel" onClick={() => { if (!running.current) setCancelTarget(taskKey); }}>{action.pending && intent === 'cancel' ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}取消整个任务</button>
        ) : null}
        {canContinue ? (
          <button type="button" className={formSecondaryButtonClass} disabled={pending}
            data-testid="task-continue" onClick={() => run('continue')}>{action.pending && intent === 'continue' ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}继续任务</button>
        ) : null}
        {data.canRestoreApproval && !unconfirmed ? (
          <button type="button" className={formSecondaryButtonClass} disabled={pending}
            data-testid="task-restore-approval" onClick={() => run('restoreApproval')}>{action.pending && intent === 'restoreApproval' ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}恢复审批</button>
        ) : null}
      </div>
      {pending ? (
        <p role="status" data-testid="task-action-pending" className="text-subtle">
          {cleanupPending || intent === 'cancel' || intent === 'pause' ? '正在停止执行并等待资源清理…' : '正在恢复任务…'}
        </p>
      ) : null}
      {error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{error}</p>}
      <ConfirmDialog
        open={cancelTarget === taskKey && status !== 'completed' && status !== 'cancelled'}
        title="取消整个任务"
        message={`确定取消「${data.task.goal}」？`}
        detail="将停止后续执行并等待资源清理，不撤销已完成的操作。"
        confirmLabel="取消整个任务"
        cancelLabel="保留任务"
        confirmDisabled={pending}
        tone="destructive"
        onConfirm={() => { setCancelTarget(null); run('cancel'); }}
        onCancel={() => setCancelTarget(null)}
        testId="task-cancel-dialog"
      />
    </div>
  );
}
