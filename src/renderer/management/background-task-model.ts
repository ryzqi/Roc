import type { BackgroundTask, BackgroundTaskPreviewRequest, BackgroundTaskTrigger, ScheduledTaskRun } from '../../shared/types';
import { taskStatusLabels } from '../tasks/task-model';

/**
 * Background-task projections (P9/T9.4).
 *
 * Type-only imports plus `taskStatusLabels` from P6's task model — the management tab and the
 * board render the same statuses, so the label table is shared rather than copied.
 *
 * Two rules the phase text is right about and that the code has to keep:
 *
 *  - **The schedule is never computed here.** `nextRunAt`, `cronExpression`,
 *    `triggerDescription` and `scheduled` all come from the backend (the preview computes the
 *    next fire time with the same parser the scheduler uses), so the panel only *renders* them.
 *    The only client-side cron check is the segment count, which mirrors the backend's own
 *    user-facing message ("请使用五段标准 cron 表达式").
 *  - **`update` needs a `reason`.** `updateBackgroundTaskRequestSchema` requires a non-empty
 *    string and the backend records it as the change's provenance, so the edit form asks for
 *    it instead of inventing a generic value.
 */

export const triggerTypeLabels: Readonly<Record<BackgroundTaskTrigger['type'], string>> = {
  manual: '手动',
  once: '一次',
  cron: '周期（cron）'
};

export const scheduledRunStatusLabels: Readonly<Record<ScheduledTaskRun['status'], string>> = {
  pending: '待触发',
  claimed: '已领取',
  dispatched: '已派发',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  unknown: '未知',
  fired: '已触发'
};

export type TaskDraft = {
  goal: string;
  triggerType: BackgroundTaskTrigger['type'];
  triggerDescription: string;
  /**
   * `datetime-local` value for the **first** fire time.
   *
   * Both `once` and `cron` require `nextRunAt` in the schema (F24): for `once` it is the only
   * fire time, and for `cron` it seeds the schedule — the scheduler recomputes every later
   * occurrence from the expression, so this field is the first one, not the whole schedule.
   */
  firstRunAt: string;
  cronExpression: string;
  /** One action per line; the backend field is `allowedActions: string[]`. */
  allowedActionsText: string;
  forbiddenActionsText: string;
  /** Required by `updateBackgroundTask`; empty while creating. */
  reason: string;
};

export function emptyTaskDraft(): TaskDraft {
  return {
    goal: '',
    triggerType: 'manual',
    triggerDescription: '手动触发',
    firstRunAt: '',
    cronExpression: '0 9 * * *',
    allowedActionsText: '',
    forbiddenActionsText: '',
    reason: ''
  };
}

export function draftFromTask(task: BackgroundTask): TaskDraft {
  return {
    goal: task.goal,
    triggerType: task.triggerType,
    triggerDescription: task.triggerDescription,
    firstRunAt: task.nextRunAt === null ? '' : toLocalDateTimeInput(task.nextRunAt),
    cronExpression: task.cronExpression ?? '0 9 * * *',
    allowedActionsText: task.allowedActions.join('\n'),
    forbiddenActionsText: task.forbiddenActions.join('\n'),
    reason: ''
  };
}

/** `2026-10-20T01:00:00.000Z` → `2026-10-20T09:00` in the user's timezone (for `datetime-local`). */
export function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type TaskDraftIssue = { field: keyof TaskDraft; message: string };

const CRON_FIELD_COUNT = 5;

/**
 * Client-side checks that mirror the backend's own refusals, so a typo is a field error instead
 * of a failed create. Deliberately shallow: the backend's cron parser validates ranges and the
 * preview computes the next run.
 */
export function validateTaskDraft(draft: TaskDraft, workspacePath: string | null): TaskDraftIssue[] {
  const issues: TaskDraftIssue[] = [];
  if (draft.goal.trim().length === 0) {
    issues.push({ field: 'goal', message: '目标不能为空。' });
  }
  if (draft.triggerDescription.trim().length === 0) {
    issues.push({ field: 'triggerDescription', message: '触发描述不能为空（它会显示在任务列表里）。' });
  }
  if (workspacePath === null || workspacePath.trim().length === 0) {
    issues.push({ field: 'goal', message: '后台任务必须有工作目录（先在项目里绑定工作目录）。' });
  }
  if (draft.triggerType !== 'manual') {
    // `once` and `cron` both carry `nextRunAt` in the schema.
    if (draft.firstRunAt.trim().length === 0) {
      issues.push({
        field: 'firstRunAt',
        message: draft.triggerType === 'once' ? '一次触发需要时间。' : '周期触发需要首次运行时间。'
      });
    } else {
      const at = new Date(draft.firstRunAt);
      if (Number.isNaN(at.getTime())) {
        issues.push({ field: 'firstRunAt', message: '时间无法解析。' });
      } else if (at.getTime() <= Date.now()) {
        issues.push({ field: 'firstRunAt', message: '时间必须晚于现在，否则不会触发。' });
      }
    }
  }
  if (draft.triggerType === 'cron') {
    const segments = draft.cronExpression.trim().split(/\s+/u).filter((segment) => segment.length > 0);
    if (segments.length !== CRON_FIELD_COUNT) {
      issues.push({
        field: 'cronExpression',
        message: `请使用五段标准 cron 表达式，例如 0 9 * * *（当前 ${segments.length} 段）。`
      });
    }
  }
  if (draft.allowedActionsText.trim().length > 0 && draft.forbiddenActionsText.trim().length > 0) {
    const overlap = linesToList(draft.allowedActionsText).filter((action) =>
      linesToList(draft.forbiddenActionsText).includes(action)
    );
    if (overlap.length > 0) {
      issues.push({ field: 'forbiddenActionsText', message: `同一条动作同时出现在允许与禁止里：${overlap.join('、')}` });
    }
  }
  return issues;
}

export function taskIssueFor(issues: readonly TaskDraftIssue[], field: TaskDraftIssue['field']): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

export function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The trigger half of the request, built from the draft's type.
 *
 * `datetime-local` has no offset; `new Date(...)` reads it as local time and `toISOString()`
 * produces the offset-carrying value the schema requires.
 */
export function triggerFromDraft(draft: TaskDraft): BackgroundTaskTrigger {
  const description = draft.triggerDescription.trim();
  if (draft.triggerType === 'once') {
    return { type: 'once', description, nextRunAt: new Date(draft.firstRunAt).toISOString() };
  }
  if (draft.triggerType === 'cron') {
    return {
      type: 'cron',
      description,
      cronExpression: draft.cronExpression.trim(),
      nextRunAt: new Date(draft.firstRunAt).toISOString()
    };
  }
  return { type: 'manual', description };
}

/**
 * Draft → preview/create request.
 *
 * `failurePolicy` and `notificationPolicy` are literals in the schema (there is no choice to
 * make), so they are set here rather than exposed as controls that would have one option.
 */
export function toPreviewRequest(draft: TaskDraft, workspacePath: string): BackgroundTaskPreviewRequest {
  return {
    goal: draft.goal.trim(),
    trigger: triggerFromDraft(draft),
    workspacePath,
    allowedActions: linesToList(draft.allowedActionsText),
    forbiddenActions: linesToList(draft.forbiddenActionsText),
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations'
  };
}

/** The `patch` half of `updateBackgroundTask` (the same shape, minus nothing). */
export function toUpdatePatch(draft: TaskDraft, workspacePath: string): Partial<BackgroundTaskPreviewRequest> {
  return toPreviewRequest(draft, workspacePath);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** `tasks.getSchedulerStatus().running` as a word, for the summary lines. */
export function schedulerStatusWord(scheduler: { running: boolean } | null): string {
  if (scheduler === null) {
    return '状态未知';
  }
  return scheduler.running ? '运行中' : '已停止';
}

export function taskSummaryLine(task: BackgroundTask): string {
  const status = taskStatusLabels[task.status];
  const next = task.nextRunAt === null ? '无下次运行' : `下次 ${task.nextRunAt}`;
  return `${status} · ${task.triggerDescription} · ${next} · 已运行 ${task.runCount} 次`;
}

/** The status text for a scheduled run row (real history, never a frontend-generated list). */
export function scheduledRunLine(run: ScheduledTaskRun): string {
  const when = run.triggeredAt ?? run.scheduledAt;
  const skipped = run.skipReason === null ? '' : ` · ${run.skipReason}`;
  return `${scheduledRunStatusLabels[run.status]} · ${when}${skipped}`;
}
