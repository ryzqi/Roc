import { useEffect, useMemo, useState } from 'react';
import type { LoadedState } from '../../loaded-state';
import { buildBackgroundTaskPreviewRequest, createTaskFormDraft, type TaskFormDraft } from './task-form-model';

export function TaskCreateDialog({
  open,
  onClose,
  onCreated,
  state
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
  state: LoadedState;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<TaskFormDraft>(emptyDraft(state));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const suggestedWorkspace = useMemo(
    () => state.workspace?.path ?? state.appStatus.workspace.selectedPath ?? '',
    [state.appStatus.workspace.selectedPath, state.workspace?.path]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(emptyDraft(state));
    setError(null);
  }, [open, state]);

  if (!open) {
    return null;
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const request = buildBackgroundTaskPreviewRequest({
        ...draft,
        workspacePath: draft.workspacePath.trim().length === 0 ? suggestedWorkspace : draft.workspacePath
      });
      const previewResult = await window.roc.tasks.createBackgroundTaskPreview(request);
      if (!previewResult.ok) {
        setError(previewResult.error.message);
        return;
      }
      const preview = previewResult.data;
      const needsConfirmation = preview.riskLevel === 'high' || (preview.allowedActions.length === 0 && preview.forbiddenActions.length === 0);
      if (needsConfirmation) {
        const confirmed = window.confirm('这个任务风险较高或未声明动作边界。确认继续创建？');
        if (!confirmed) {
          return;
        }
      }
      const createResult = await window.roc.tasks.createBackgroundTask(preview);
      if (!createResult.ok) {
        setError(createResult.error.message);
        return;
      }
      await onCreated();
      onClose();
      setDraft(emptyDraft(state));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="task-create-dialog" data-testid="task-create-dialog" role="dialog" aria-modal="true" aria-label="新建任务">
      <div className="section-head">
        <h2 className="section-title">新建任务</h2>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="task-form-grid">
        <label className="task-form-field">
          <span>目标</span>
          <textarea
            data-testid="task-create-goal"
            rows={3}
            value={draft.goal}
            onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))}
          />
        </label>
        <label className="task-form-field">
          <span>触发类型</span>
          <select
            data-testid="task-create-trigger-type"
            value={draft.triggerType}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                triggerType: event.target.value as TaskFormDraft['triggerType']
              }))
            }
          >
            <option value="manual">手动</option>
            <option value="once">一次</option>
            <option value="cron">定时</option>
          </select>
        </label>
        <label className="task-form-field">
          <span>触发描述</span>
          <input
            data-testid="task-create-trigger-description"
            type="text"
            value={draft.triggerDescription}
            onChange={(event) => setDraft((current) => ({ ...current, triggerDescription: event.target.value }))}
          />
        </label>
        {draft.triggerType === 'manual' ? null : (
          <label className="task-form-field">
            <span>下次运行时间</span>
            <input
              data-testid="task-create-next-run-at"
              type="datetime-local"
              value={draft.nextRunAt}
              onChange={(event) => setDraft((current) => ({ ...current, nextRunAt: event.target.value }))}
            />
          </label>
        )}
        {draft.triggerType !== 'cron' ? null : (
          <label className="task-form-field">
            <span>Cron 表达式</span>
            <input
              data-testid="task-create-cron-expression"
              type="text"
              value={draft.cronExpression}
              onChange={(event) => setDraft((current) => ({ ...current, cronExpression: event.target.value }))}
            />
          </label>
        )}
        <label className="task-form-field">
          <span>工作区路径</span>
          <input
            data-testid="task-create-workspace-path"
            type="text"
            value={draft.workspacePath}
            onChange={(event) => setDraft((current) => ({ ...current, workspacePath: event.target.value }))}
          />
        </label>
        <label className="task-form-field">
          <span>允许动作</span>
          <textarea
            data-testid="task-create-allowed-actions"
            rows={4}
            value={draft.allowedActionsText}
            onChange={(event) => setDraft((current) => ({ ...current, allowedActionsText: event.target.value }))}
          />
        </label>
        <label className="task-form-field">
          <span>禁止动作</span>
          <textarea
            data-testid="task-create-forbidden-actions"
            rows={4}
            value={draft.forbiddenActionsText}
            onChange={(event) => setDraft((current) => ({ ...current, forbiddenActionsText: event.target.value }))}
          />
        </label>
      </div>
      {error === null ? null : <span className="pill warn" data-testid="task-create-error">{error}</span>}
      <div className="action-strip">
        <button type="button" onClick={() => void submit()} disabled={submitting}>
          {submitting ? '创建中' : '创建任务'}
        </button>
        <button
          type="button"
          onClick={() =>
            setDraft(emptyDraft(state))
          }
        >
          重置
        </button>
      </div>
    </div>
  );
}

function emptyDraft(state: LoadedState): TaskFormDraft {
  return createTaskFormDraft({
    workspacePath: state.workspace?.path ?? state.appStatus.workspace.selectedPath ?? '',
    trigger: {
      type: 'manual',
      description: '手动触发'
    }
  });
}
