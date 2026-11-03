import { useState } from 'react';
import type { ResearchTaskDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import { useAsyncAction } from '../../app/use-async-resource';
import { formSecondaryButtonClass } from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';

type TaskAction = 'pause' | 'cancel' | 'continue' | 'restoreApproval';

export function TaskControls({ client, data, onChanged }: {
  client: RocClient; data: ResearchTaskDiagnostics; onChanged: () => void;
}): React.JSX.Element {
  const [intent, setIntent] = useState<TaskAction | null>(null);
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
  const unconfirmed = data.task.statusReason === 'research_task_cleanup_failed';
  const canContinue = ['paused', 'interrupted', 'failed', 'cancelled'].includes(status) &&
    data.continuationRunId !== null && !data.canRestoreApproval && !unconfirmed;
  const run = (type: TaskAction): void => {
    setIntent(type);
    void action.run(type).then(() => onChanged());
  };
  return (
    <div className="grid gap-1" data-testid="task-controls" aria-busy={action.pending}>
      <div className="flex flex-wrap gap-2">
        {status === 'active' || status === 'waiting_approval' ? (
          <button type="button" className={formSecondaryButtonClass} disabled={action.pending}
            data-testid="task-pause" onClick={() => run('pause')}>暂停任务</button>
        ) : null}
        {status !== 'completed' && status !== 'cancelled' ? (
          <button type="button" className={formSecondaryButtonClass} disabled={action.pending}
            data-testid="task-cancel" onClick={() => run('cancel')}>取消整个任务</button>
        ) : null}
        {canContinue ? (
          <button type="button" className={formSecondaryButtonClass} disabled={action.pending}
            data-testid="task-continue" onClick={() => run('continue')}>继续任务</button>
        ) : null}
        {data.canRestoreApproval && !unconfirmed ? (
          <button type="button" className={formSecondaryButtonClass} disabled={action.pending}
            data-testid="task-restore-approval" onClick={() => run('restoreApproval')}>恢复审批</button>
        ) : null}
      </div>
      {action.pending ? (
        <p role="status" data-testid="task-action-pending" className="text-subtle">
          {intent === 'cancel' || intent === 'pause' ? '正在停止执行并等待资源清理…' : '正在恢复任务…'}
        </p>
      ) : null}
      {action.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{action.error}</p>}
    </div>
  );
}
