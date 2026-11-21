import '../management-layout.css';
import { useMemo, useState } from 'react';
import { CalendarClock, LoaderCircle, Play, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { TaskStatus } from '../../../shared/types';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { FormNote, FormSection, KeyValueRow, formInputClass, formSecondaryButtonClass, formTextAreaClass } from '../../shared/form-ui';
import { formatBeijingDateTime } from '../../shared/format';
import { getTaskActionAvailability, taskStatusLabels } from '../../tasks/task-model';
import {
  scheduledRunLine,
  schedulerStatusWord,
  taskIssueFor,
  triggerTypeLabels,
  type TaskDraft
} from '../background-task-model';
import type { BackgroundTasksStore } from '../use-background-tasks';

/**
 * 后台定时任务 (P9/T9.4).
 *
 * ## Preview first, then create
 *
 * `tasks.createBackgroundTaskPreview` is what returns `scheduled`, `cronExpression`, `nextRunAt`,
 * `riskLevel` and `requiresConfirmation`; the same request object then goes to
 * `createBackgroundTask`, so the created task is exactly the one that was shown. Nothing about
 * the schedule is computed here — the backend's parser owns that (F24).
 *
 * ## Every action is gated by the backend's own status sets
 *
 * `getTaskActionAvailability` (P6, lifted from the legacy renderer and validated against the real
 * service) decides which buttons exist for a task's status; `pause`, for example, is only accepted
 * for `running | pending_confirmation`, so offering it elsewhere would be a button that always
 * fails.
 *
 * ## The history is the backend's
 *
 * `tasks.listScheduledRuns` is the only history; the legacy frontend's generated
 * `executionHistory` array is gone. The scheduler block reports `tasks.getSchedulerStatus` as-is
 * (running, registered count, next fire, skipped count, last error).
 */

function draftField(draft: TaskDraft, key: keyof TaskDraft, value: string): TaskDraft {
  return { ...draft, [key]: value };
}

export function BackgroundTasksSection({ store: tasks }: { store: BackgroundTasksStore }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [deleteAttempted, setDeleteAttempted] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [pendingEditorAction, setPendingEditorAction] = useState<(() => void) | null>(null);
  const changeEditor = (action: () => void): void => {
    if (tasks.isBusy()) return;
    if (tasks.dirty) setPendingEditorAction(() => action);
    else action();
  };
  const visibleTasks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return tasks.tasks.filter(task => (statusFilter === 'all' || task.status === statusFilter) &&
      `${task.goal} ${task.triggerDescription}`.toLocaleLowerCase().includes(search));
  }, [tasks.tasks, query, statusFilter]);
  const filtered = query.trim() !== '' || statusFilter !== 'all';
  const clearFilters = (): void => { setQuery(''); setStatusFilter('all'); };

  // Same rule as the MCP section: only "nothing to show yet" is a loading state; a refresh keeps the
  // list on screen (and keeps the buttons attached).
  if (tasks.status !== 'ready' && tasks.tasks.length === 0) {
    return tasks.status === 'error' ? (
      <FormNote tone="warn" testId="mgmt-tasks-error">
        读取后台任务失败：{tasks.error}
        <button type="button" onClick={tasks.reload} className={formSecondaryButtonClass}>重试</button>
      </FormNote>
    ) : (
      <FormNote testId="mgmt-tasks-loading">正在读取后台任务…</FormNote>
    );
  }

  const draft = tasks.draft;
  const deleteGoal = tasks.tasks.find((task) => task.id === deleteTarget)?.goal ?? null;

  return (
    <div className="management-background-tasks" data-testid="mgmt-tasks">
      <FormSection
        title="后台任务"
        testId="mgmt-tasks-list-section"
      >
        <div className="management-background-toolbar">
          <span className="management-background-count" data-testid="mgmt-tasks-summary" role="status">
            {filtered ? `${visibleTasks.length} / ${tasks.tasks.length}` : tasks.tasks.length} 个任务
          </span>
          <button
            type="button"
            data-testid="mgmt-tasks-reload"
            disabled={tasks.status === 'loading'}
            onClick={() => tasks.reload()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </button>
          <button
            type="button"
            data-testid="mgmt-tasks-create"
            disabled={tasks.busy}
            onClick={() => changeEditor(tasks.startCreate)}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Plus size={14} aria-hidden="true" />
            新建任务
          </button>
        </div>

        {tasks.tasks.length === 0 && !filtered ? null : <div className="management-background-filters">
          <label className="management-search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">搜索后台任务</span>
            <input type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder="搜索任务目标或触发描述" className={formInputClass} data-testid="mgmt-tasks-search" />
          </label>
          <label>
            <span className="sr-only">任务状态</span>
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as TaskStatus | 'all')}
              className={formInputClass} data-testid="mgmt-tasks-status-filter">
              <option value="all">全部状态</option>
              {Object.entries(taskStatusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </select>
          </label>
        </div>}

        {tasks.error === null ? null : <FormNote tone="warn" testId="mgmt-tasks-refresh-error">刷新失败：{tasks.error}</FormNote>}

        <details className="management-disclosure" data-testid="mgmt-tasks-scheduler-details">
          <summary>调度器 {schedulerStatusWord(tasks.scheduler)}{tasks.scheduler?.lastError ? <span className="ms-2">需处理</span> : null}</summary>
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow label="已注册" value={`${tasks.scheduler?.registeredTaskCount ?? '—'} 个任务`} testId="mgmt-tasks-registered" />
          <KeyValueRow
            label="下次触发"
            value={tasks.scheduler?.nextFireAt === null || tasks.scheduler?.nextFireAt === undefined ? '—' : formatBeijingDateTime(tasks.scheduler.nextFireAt)}
            testId="mgmt-tasks-next-fire"
          />
          <KeyValueRow
            label="最近跳过"
            value={`${tasks.scheduler?.recentSkippedCount ?? 0} 次`}
            testId="mgmt-tasks-skipped"
          />
          <KeyValueRow label="调度错误" value={tasks.scheduler?.lastError ?? '无'} testId="mgmt-tasks-scheduler-error" />
        </dl>
        </details>

        {tasks.action.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-tasks-action-error">
            {tasks.action.error}
          </FormNote>
        )}

        {visibleTasks.length === 0 ? <div className="management-list-empty" data-testid="mgmt-tasks-empty">
          <p>{tasks.tasks.length === 0 ? '暂无后台任务' : '没有符合条件的任务'}</p>
          {filtered ? <button type="button" className={formSecondaryButtonClass} onClick={clearFilters}
            data-testid="mgmt-tasks-clear-filters">清除筛选</button> : null}
        </div> : (
          <ul className="management-background-list" data-testid="mgmt-tasks-rows">
            {visibleTasks.map((task) => {
              const availability = getTaskActionAvailability(task.status);
              const selected = task.id === tasks.selectedId;
              return (
                <li
                  key={task.id}
                  className="management-background-row"
                  data-selected={selected}
                  data-testid={`mgmt-task-${task.id}`}
                >
                  <button
                    type="button"
                    disabled={tasks.busy}
                    aria-pressed={selected}
                    onClick={() => tasks.select(task.id)}
                    data-testid={`mgmt-task-select-${task.id}`}
                    className="management-background-select"
                  >
                    <span className="management-background-title">
                      <span>{task.goal}</span>
                      <span className="management-background-status">{taskStatusLabels[task.status]}</span>
                    </span>
                    <span className="management-background-meta">
                      <span>{task.triggerDescription || triggerTypeLabels[task.triggerType]}</span>
                      <span>已运行 {task.runCount.toLocaleString()} 次</span>
                      {task.nextRunAt === null ? null : <span>下次 {formatBeijingDateTime(task.nextRunAt)}</span>}
                    </span>
                  </button>
                  {selected ? <div className="management-background-actions" aria-label="所选任务操作" aria-busy={tasks.action.pending}>
                    {availability.runNow ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-run-now-${task.id}`}
                        disabled={tasks.busy}
                        onClick={() => {
                          void tasks.action.run('runNow', task.id);
                        }}
                        className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                      >
                        <Play size={11} aria-hidden="true" />
                        立即运行
                      </button>
                    ) : null}
                    {availability.pause ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-pause-${task.id}`}
                        disabled={tasks.busy}
                        onClick={() => {
                          void tasks.action.run('pause', task.id);
                        }}
                        className={formSecondaryButtonClass}
                      >
                        暂停
                      </button>
                    ) : null}
                    {availability.resume ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-resume-${task.id}`}
                        disabled={tasks.busy}
                        onClick={() => {
                          void tasks.action.run('resume', task.id);
                        }}
                        className={formSecondaryButtonClass}
                      >
                        恢复
                      </button>
                    ) : null}
                    {availability.cancel ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-cancel-${task.id}`}
                        disabled={tasks.busy}
                        onClick={() => {
                          void tasks.action.run('cancel', task.id);
                        }}
                        className={formSecondaryButtonClass}
                      >
                        取消
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`mgmt-task-edit-${task.id}`}
                      disabled={tasks.busy}
                      onClick={() => changeEditor(() => tasks.startEdit(task))}
                      className={formSecondaryButtonClass}
                    >
                      编辑
                    </button>
                    {availability.delete ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-delete-${task.id}`}
                        disabled={tasks.busy}
                        onClick={() => setDeleteTarget(task.id)}
                        className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                      >
                        <Trash2 size={11} aria-hidden="true" />
                        删除
                      </button>
                    ) : null}
                    {tasks.action.pending ? <span role="status" className="management-background-pending">
                      <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />处理中…
                    </span> : null}
                  </div> : null}
                </li>
              );
            })}
          </ul>
        )}
      </FormSection>

      {tasks.selected === null ? null : (
        <FormSection
          title={`详情：${tasks.selected.goal}`}
          testId="mgmt-task-detail"
        >
          <dl className="flex flex-col gap-0.5">
            <KeyValueRow label="状态" value={taskStatusLabels[tasks.selected.status]} testId="mgmt-task-detail-status" />
            <KeyValueRow label="触发" value={`${triggerTypeLabels[tasks.selected.triggerType]}，${tasks.selected.triggerDescription}`} testId="mgmt-task-detail-trigger" />
            <KeyValueRow
              label="cron"
              value={tasks.selected.cronExpression ?? '—'}
              testId="mgmt-task-detail-cron"
            />
            <KeyValueRow
              label="下次运行"
              value={tasks.selected.nextRunAt === null ? '—' : formatBeijingDateTime(tasks.selected.nextRunAt)}
              testId="mgmt-task-detail-next"
            />
            <KeyValueRow
              label="上次运行"
              value={
                tasks.selected.lastRunAt === null
                  ? '—'
                  : `${formatBeijingDateTime(tasks.selected.lastRunAt)}，${tasks.selected.lastRunStatus ?? '未知'}`
              }
              testId="mgmt-task-detail-last"
            />
            <KeyValueRow label="运行次数" value={String(tasks.selected.runCount)} testId="mgmt-task-detail-runs" />
            <KeyValueRow label="工作目录" value={tasks.selected.workspacePath} testId="mgmt-task-detail-workspace" />
            <KeyValueRow
              label="风险 / 需确认"
              value={`${tasks.selected.riskLevel}，${tasks.selected.requiresConfirmation ? '需要确认' : '不需要'}`}
              testId="mgmt-task-detail-risk"
            />
            <KeyValueRow
              label="允许动作"
              value={tasks.selected.allowedActions.join(', ') || '（未限制）'}
              testId="mgmt-task-detail-allowed"
            />
            <KeyValueRow
              label="禁止动作"
              value={tasks.selected.forbiddenActions.join(', ') || '（未声明）'}
              testId="mgmt-task-detail-forbidden"
            />
          </dl>

          {tasks.runsError === null ? null : (
            <FormNote tone="warn" testId="mgmt-task-runs-error">
              {tasks.runsError}
            </FormNote>
          )}
          {tasks.runs.length === 0 ? (
            <FormNote testId="mgmt-task-runs-empty">
              {tasks.runsStatus === 'loading' ? '读取调度记录中…' : '暂无调度记录，手动运行不计入。'}
            </FormNote>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="mgmt-task-runs">
              {tasks.runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-0.5 text-[length:var(--font-micro-size)]">
                  <span className="text-muted">{scheduledRunLine(run)}</span>
                  <span className="text-subtle">
                    scheduled {run.scheduledAt}
                    {run.taskRunId === null ? '' : `，run ${run.taskRunId}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </FormSection>
      )}

      {draft === null ? null : (
        <FormSection
          title={tasks.mode === 'edit' ? '编辑任务' : '新建任务'}
          testId="mgmt-task-editor"
        >
          <fieldset disabled={tasks.busy} className="flex min-w-0 flex-col gap-3 disabled:opacity-50">
          <label className="flex flex-col gap-0.5">
            <span className="text-subtle text-[length:var(--font-micro-size)]">任务目标</span>
            <textarea
              value={draft.goal}
              rows={3}
              onChange={(event) => tasks.setDraft(draftField(draft, 'goal', event.target.value))}
              data-testid="mgmt-task-draft-goal"
              className={formTextAreaClass}
            />
          </label>
          <div className="form-grid">
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[length:var(--font-micro-size)]">触发方式</span>
              <select
                value={draft.triggerType}
                onChange={(event) =>
                  tasks.setDraft({ ...draft, triggerType: event.target.value as TaskDraft['triggerType'] })
                }
                data-testid="mgmt-task-draft-trigger"
                className={formInputClass}
              >
                <option value="manual">手动</option>
                <option value="once">一次</option>
                <option value="cron">周期（cron）</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[length:var(--font-micro-size)]">触发描述</span>
              <input
                value={draft.triggerDescription}
                onChange={(event) => tasks.setDraft(draftField(draft, 'triggerDescription', event.target.value))}
                data-testid="mgmt-task-draft-description"
                className={formInputClass}
              />
            </label>
            {draft.triggerType === 'manual' ? null : (
              <label className="flex flex-col gap-0.5">
                <span className="text-subtle text-[length:var(--font-micro-size)]">
                  首次运行时间（本地时间）
                </span>
                <input
                  type="datetime-local"
                  value={draft.firstRunAt}
                  onChange={(event) => tasks.setDraft(draftField(draft, 'firstRunAt', event.target.value))}
                  data-testid="mgmt-task-draft-first-run"
                  className={formInputClass}
                />
              </label>
            )}
            {draft.triggerType === 'cron' ? (
              <label className="flex flex-col gap-0.5">
                <span className="text-subtle text-[length:var(--font-micro-size)]">cron（五段，例如 0 9 * * *）</span>
                <input
                  value={draft.cronExpression}
                  onChange={(event) => tasks.setDraft(draftField(draft, 'cronExpression', event.target.value))}
                  data-testid="mgmt-task-draft-cron"
                  className={formInputClass}
                />
              </label>
            ) : null}
          </div>
          <div className="form-grid">
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[length:var(--font-micro-size)]">允许的动作（每行一个；空表示未限制）</span>
              <textarea
                value={draft.allowedActionsText}
                rows={3}
                onChange={(event) => tasks.setDraft(draftField(draft, 'allowedActionsText', event.target.value))}
                data-testid="mgmt-task-draft-allowed"
                className={formTextAreaClass}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[length:var(--font-micro-size)]">禁止的动作（每行一个）</span>
              <textarea
                value={draft.forbiddenActionsText}
                rows={3}
                onChange={(event) => tasks.setDraft(draftField(draft, 'forbiddenActionsText', event.target.value))}
                data-testid="mgmt-task-draft-forbidden"
                className={formTextAreaClass}
              />
            </label>
          </div>
          {tasks.mode === 'edit' ? (
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[length:var(--font-micro-size)]">修改原因（必填）</span>
              <input
                value={draft.reason}
                onChange={(event) => tasks.setDraft(draftField(draft, 'reason', event.target.value))}
                data-testid="mgmt-task-draft-reason"
                className={formInputClass}
              />
            </label>
          ) : null}

          {(['goal', 'triggerDescription', 'firstRunAt', 'cronExpression', 'forbiddenActionsText'] as const).map((field) => {
            const issue = taskIssueFor(tasks.issues, field);
            return issue === null ? null : (
              <FormNote key={field} tone="warn" testId={`mgmt-task-issue-${field}`}>
                {issue}
              </FormNote>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            {tasks.mode === 'edit' ? (
              <button
                type="button"
                data-testid="mgmt-task-update"
                disabled={tasks.busy || tasks.issues.length > 0}
                onClick={() => {
                  void tasks.update.run();
                }}
                className={formSecondaryButtonClass}
              >
                {tasks.update.pending ? '保存中…' : '保存修改'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="mgmt-task-preview"
                  disabled={tasks.busy || tasks.issues.length > 0}
                  onClick={() => {
                    void tasks.runPreview();
                  }}
                  className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                >
                  <CalendarClock size={11} aria-hidden="true" />
                  {tasks.previewPending ? '预览中…' : '预览'}
                </button>
                <button
                  type="button"
                  data-testid="mgmt-task-create-run"
                  disabled={tasks.busy || tasks.preview === null}
                  onClick={() => {
                    void tasks.create.run();
                  }}
                  className={formSecondaryButtonClass}
                >
                  {tasks.create.pending ? '创建中…' : '创建任务'}
                </button>
              </>
            )}
            <button
              type="button"
              data-testid="mgmt-task-editor-cancel"
              disabled={tasks.busy}
              onClick={() => changeEditor(tasks.cancelEdit)}
              className={formSecondaryButtonClass}
            >
              取消
            </button>
          </div>
          {tasks.previewError === null ? null : (
            <FormNote tone="warn" testId="mgmt-task-preview-error">
              {tasks.previewError}
            </FormNote>
          )}
          {tasks.preview === null ? null : (
            <dl className="flex flex-col gap-0.5 rounded-card border-[0.5px] border-line px-2 py-1.5" data-testid="mgmt-task-preview-result">
              <KeyValueRow label="会调度" value={tasks.preview.scheduled ? '是' : '否（手动）'} testId="mgmt-task-preview-scheduled" />
              <KeyValueRow label="cron" value={tasks.preview.cronExpression ?? '—'} testId="mgmt-task-preview-cron" />
              <KeyValueRow
                label="下一次"
                value={tasks.preview.nextRunAt === null ? '—' : formatBeijingDateTime(tasks.preview.nextRunAt)}
                testId="mgmt-task-preview-next"
              />
              <KeyValueRow label="风险" value={tasks.preview.riskLevel} testId="mgmt-task-preview-risk" />
              <KeyValueRow
                label="需确认"
                value={tasks.preview.requiresConfirmation ? '是' : '否'}
                testId="mgmt-task-preview-confirm"
              />
            </dl>
          )}
          {tasks.create.error === null ? null : (
            <FormNote tone="warn" testId="mgmt-task-create-error">
              {tasks.create.error}
            </FormNote>
          )}
          {tasks.update.error === null ? null : (
            <FormNote tone="warn" testId="mgmt-task-update-error">
              {tasks.update.error}
            </FormNote>
          )}
          </fieldset>
        </FormSection>
      )}

      <ConfirmDialog
        open={pendingEditorAction !== null}
        title="放弃未保存的后台任务？"
        message="任务改动尚未保存，放弃后需要重新填写。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        tone="destructive"
        confirmDisabled={tasks.busy}
        testId="mgmt-task-discard"
        onCancel={() => setPendingEditorAction(null)}
        onConfirm={() => {
          if (tasks.busy) return;
          const action = pendingEditorAction;
          setPendingEditorAction(null);
          tasks.cancelEdit();
          action?.();
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个后台任务？"
        message={`将删除任务「${deleteGoal ?? deleteTarget ?? ''}」。`}
        detail="删除的是任务记录；已经跑过的运行记录与产物不受影响。"
        confirmLabel="删除任务"
        tone="destructive"
        testId="mgmt-task-delete-confirm"
        confirmDisabled={tasks.busy}
        pending={deleteAttempted && tasks.action.pending}
        error={deleteAttempted ? tasks.action.error : null}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteAttempted(false);
        }}
        onConfirm={() => {
          if (tasks.isBusy() || deleteTarget === null) return;
          setDeleteAttempted(true);
          void tasks.action.run('delete', deleteTarget).then((deleted) => {
            if (deleted) {
              setDeleteTarget(null);
              setDeleteAttempted(false);
            }
          });
        }}
      />
    </div>
  );
}
