import { useState } from 'react';
import { CalendarClock, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { FormNote, FormSection, KeyValueRow, formInputClass, formSecondaryButtonClass, formTextAreaClass } from '../../shared/form-ui';
import { formatBeijingDateTime } from '../../shared/format';
import { getTaskActionAvailability, taskStatusLabels } from '../../tasks/task-model';
import {
  scheduledRunLine,
  schedulerStatusWord,
  taskIssueFor,
  taskSummaryLine,
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Same rule as the MCP section: only "nothing to show yet" is a loading state; a refresh keeps the
  // list on screen (and keeps the buttons attached).
  if (tasks.status !== 'ready' && tasks.tasks.length === 0) {
    return tasks.status === 'error' ? (
      <FormNote tone="warn" testId="mgmt-tasks-error">
        读取后台任务失败：{tasks.error}
      </FormNote>
    ) : (
      <FormNote testId="mgmt-tasks-loading">正在读取后台任务…</FormNote>
    );
  }

  const draft = tasks.draft;
  const deleteGoal = tasks.tasks.find((task) => task.id === deleteTarget)?.goal ?? null;

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="mgmt-tasks">
      <FormSection
        title="后台任务"
        testId="mgmt-tasks-list-section"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted text-[var(--font-meta-size)]" data-testid="mgmt-tasks-summary">
            {tasks.tasks.length} 个任务 · 调度器 {schedulerStatusWord(tasks.scheduler)} · 已注册{' '}
            {tasks.scheduler?.registeredTaskCount ?? '—'}
          </span>
          <button
            type="button"
            data-testid="mgmt-tasks-reload"
            disabled={tasks.status === 'loading'}
            onClick={() => tasks.reload()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新读取
          </button>
          <button
            type="button"
            data-testid="mgmt-tasks-create"
            onClick={() => tasks.startCreate()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Plus size={11} aria-hidden="true" />
            新建任务
          </button>
        </div>

        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="下次触发"
            value={tasks.scheduler?.nextFireAt === null || tasks.scheduler?.nextFireAt === undefined ? '—' : formatBeijingDateTime(tasks.scheduler.nextFireAt)}
            testId="mgmt-tasks-next-fire"
          />
          <KeyValueRow
            label="最近跳过"
            value={String(tasks.scheduler?.recentSkippedCount ?? 0)}
            testId="mgmt-tasks-skipped"
          />
          <KeyValueRow label="调度错误" value={tasks.scheduler?.lastError ?? '无'} testId="mgmt-tasks-scheduler-error" />
        </dl>

        {tasks.action.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-tasks-action-error">
            {tasks.action.error}
          </FormNote>
        )}

        {tasks.tasks.length === 0 ? null : (
          <ul className="flex flex-col gap-1" data-testid="mgmt-tasks-rows">
            {tasks.tasks.map((task) => {
              const availability = getTaskActionAvailability(task.status);
              const selected = task.id === tasks.selectedId;
              return (
                <li
                  key={task.id}
                  className={
                    selected
                      ? 'flex flex-col gap-1 rounded-card bg-accent-soft px-2 py-1.5'
                      : 'flex flex-col gap-1 rounded-card border border-line px-2 py-1.5'
                  }
                  data-testid={`mgmt-task-${task.id}`}
                >
                  <button
                    type="button"
                    onClick={() => tasks.select(task.id)}
                    data-testid={`mgmt-task-select-${task.id}`}
                    className="flex min-w-0 flex-col gap-0.5 text-left"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-ink text-[var(--font-meta-size)]">{task.goal}</span>
                      <span className="text-muted text-[var(--font-micro-size)]">{taskStatusLabels[task.status]}</span>
                      <span className="text-subtle text-[var(--font-micro-size)]">
                        {triggerTypeLabels[task.triggerType]} · {task.triggerDescription}
                      </span>
                    </span>
                    <span className="text-subtle text-[var(--font-micro-size)]">{taskSummaryLine(task)}</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
                    {availability.runNow ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-run-now-${task.id}`}
                        disabled={tasks.action.pending}
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
                        disabled={tasks.action.pending}
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
                        disabled={tasks.action.pending}
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
                        disabled={tasks.action.pending}
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
                      onClick={() => tasks.startEdit(task)}
                      className={formSecondaryButtonClass}
                    >
                      编辑
                    </button>
                    {availability.delete ? (
                      <button
                        type="button"
                        data-testid={`mgmt-task-delete-${task.id}`}
                        disabled={tasks.action.pending}
                        onClick={() => setDeleteTarget(task.id)}
                        className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                      >
                        <Trash2 size={11} aria-hidden="true" />
                        删除
                      </button>
                    ) : null}
                  </div>
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
            <KeyValueRow label="触发" value={`${triggerTypeLabels[tasks.selected.triggerType]} · ${tasks.selected.triggerDescription}`} testId="mgmt-task-detail-trigger" />
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
                  : `${formatBeijingDateTime(tasks.selected.lastRunAt)} · ${tasks.selected.lastRunStatus ?? '未知'}`
              }
              testId="mgmt-task-detail-last"
            />
            <KeyValueRow label="运行次数" value={String(tasks.selected.runCount)} testId="mgmt-task-detail-runs" />
            <KeyValueRow label="工作目录" value={tasks.selected.workspacePath} testId="mgmt-task-detail-workspace" />
            <KeyValueRow
              label="风险 / 需确认"
              value={`${tasks.selected.riskLevel} · ${tasks.selected.requiresConfirmation ? '需要确认' : '不需要'}`}
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
              {tasks.runsStatus === 'loading' ? '读取调度记录中…' : '还没有调度记录（手动任务不会产生调度行）。'}
            </FormNote>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="mgmt-task-runs">
              {tasks.runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-0.5 text-[var(--font-micro-size)]">
                  <span className="text-muted">{scheduledRunLine(run)}</span>
                  <span className="text-subtle">
                    scheduled {run.scheduledAt}
                    {run.taskRunId === null ? '' : ` · run ${run.taskRunId}`}
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
          <label className="flex flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">目标（会作为这一轮任务的目标）</span>
            <textarea
              value={draft.goal}
              rows={3}
              onChange={(event) => tasks.setDraft(draftField(draft, 'goal', event.target.value))}
              data-testid="mgmt-task-draft-goal"
              className={formTextAreaClass}
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">触发方式</span>
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
              <span className="text-subtle text-[var(--font-micro-size)]">触发描述（显示在列表里）</span>
              <input
                value={draft.triggerDescription}
                onChange={(event) => tasks.setDraft(draftField(draft, 'triggerDescription', event.target.value))}
                data-testid="mgmt-task-draft-description"
                className={formInputClass}
              />
            </label>
            {draft.triggerType === 'manual' ? null : (
              <label className="flex flex-col gap-0.5">
                <span className="text-subtle text-[var(--font-micro-size)]">
                  首次运行时间（本地时间；once 就是唯一一次）
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
                <span className="text-subtle text-[var(--font-micro-size)]">cron（五段，例如 0 9 * * *）</span>
                <input
                  value={draft.cronExpression}
                  onChange={(event) => tasks.setDraft(draftField(draft, 'cronExpression', event.target.value))}
                  data-testid="mgmt-task-draft-cron"
                  className={formInputClass}
                />
              </label>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">允许的动作（每行一个；空表示未限制）</span>
              <textarea
                value={draft.allowedActionsText}
                rows={3}
                onChange={(event) => tasks.setDraft(draftField(draft, 'allowedActionsText', event.target.value))}
                data-testid="mgmt-task-draft-allowed"
                className={formTextAreaClass}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">禁止的动作（每行一个）</span>
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
              <span className="text-subtle text-[var(--font-micro-size)]">修改原因（必填，会记进任务溯源）</span>
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
                disabled={tasks.update.pending || tasks.issues.length > 0}
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
                  disabled={tasks.previewPending || tasks.issues.length > 0}
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
                  disabled={tasks.create.pending || tasks.preview === null}
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
              onClick={() => tasks.cancelEdit()}
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
            <dl className="flex flex-col gap-0.5 rounded-card border border-line px-2 py-1.5" data-testid="mgmt-task-preview-result">
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
        </FormSection>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个后台任务？"
        message={`将删除任务「${deleteGoal ?? deleteTarget ?? ''}」。`}
        detail="删除的是任务记录；已经跑过的运行记录与产物不受影响。"
        confirmLabel="删除"
        tone="destructive"
        testId="mgmt-task-delete-confirm"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target !== null) {
            void tasks.action.run('delete', target);
          }
        }}
      />
    </div>
  );
}
