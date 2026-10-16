import { ShieldCheck } from 'lucide-react';
import type { ChatPendingApproval, ChatResumeDecision } from '../../../shared/types';

/**
 * Approval (HITL) cards (T4.4).
 *
 * Three shapes share one visual language, because they are three answers to "what am I
 * approving?":
 *
 *   - `ResearchGateApprovalCard` — a **research gate**: the decision advances a workflow
 *     stage, so it shows stage, summary and artifacts instead of a tool name and raw
 *     JSON. Ported from `chat/ResearchGateCard.tsx` (P6 reuses it for the stage bar).
 *   - `TaskApprovalCard` — a background-task change. P4 renders the **minimal closure**
 *     (what the task is, and approve/reject); P6 owns the rich diff/preview of scope and
 *     impact. The predicates are shared so P6 only has to grow this file.
 *   - `ChatApprovalCard` — the generic case: one or more tool calls with their arguments.
 *
 * All three resume through the same path (`chat.resumeRun` with decisions), and none of
 * them is dismissible: the run stays suspended until the user decides, which is why the
 * overlay rules in `useOverlayBehavior` explicitly let Escape skip an approval card and
 * why the card never renders a close affordance.
 */

const RESEARCH_GATE_TOOL_NAME = 'research_approve_gate';
export const TASK_APPROVAL_TOOL_NAMES = ['update_background_task', 'cancel_background_task'] as const;

export function isResearchGateApproval(approval: ChatPendingApproval): boolean {
  return (
    approval.kind === 'approval' &&
    approval.actionRequests.length === 1 &&
    approval.actionRequests[0]?.name === RESEARCH_GATE_TOOL_NAME
  );
}

export function isTaskApproval(approval: ChatPendingApproval): boolean {
  if (approval.kind !== 'approval' || approval.actionRequests.length !== 1) {
    return false;
  }
  const name = approval.actionRequests[0]?.name ?? '';
  return (TASK_APPROVAL_TOOL_NAMES as readonly string[]).includes(name);
}

function approvalButtonClass(kind: 'approve' | 'neutral' | 'reject' | 'edit'): string {
  if (kind === 'approve') {
    return 'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)]';
  }
  if (kind === 'reject') {
    return 'h-[var(--control-height)] rounded-control border border-[var(--st-bad-line)] px-3 text-[var(--st-bad)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]';
  }
  return 'h-[var(--control-height)] rounded-control border border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]';
}

function ApprovalShell({
  testId,
  eyebrow,
  title,
  children
}: {
  testId: string;
  eyebrow: string;
  title: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="my-2 rounded-card border border-[var(--st-warn-line)] bg-surface px-3 py-2"
      data-testid={testId}
    >
      <header className="mb-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[var(--st-warn)] text-[var(--font-micro-size)]">
          <ShieldCheck size={12} aria-hidden="true" />
          {eyebrow}
        </span>
        <strong className="text-ink text-[var(--font-h3-size)]">{title}</strong>
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Generic approval                                                    */
/* ------------------------------------------------------------------ */

export function ChatApprovalCard({
  approval,
  onApprovalDecision
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
}): React.JSX.Element {
  const request = approval.actionRequests.length === 1 ? approval.actionRequests[0] : undefined;
  const canEdit = approval.reviewConfigs.some((config) => config.allowedDecisions.includes('edit'));
  /**
   * `editedAction` is validated against `hitlActionSchema`, which is a **strict** object of
   * exactly `{ name, args }`. The interrupt's `actionRequests[0]` can carry extra fields such
   * as `description` (legacy did, and passing it through made "按原文执行" fail backend
   * validation). Rebuild the object instead of forwarding it.
   */
  const editableAction = request === undefined ? undefined : { name: request.name, args: request.args };

  return (
    <ApprovalShell
      testId="assistant-approval-card"
      eyebrow={`等待审批 · ${approval.actionRequests.length}`}
      title="助手请求执行工具"
    >
      <ul className="flex flex-col gap-1.5">
        {approval.actionRequests.map((request, index) => {
          const reviewConfig = approval.reviewConfigs.find((config) => config.actionName === request.name);
          return (
            <li key={`${request.name}-${index}`} className="rounded-control bg-bg-soft px-2 py-1.5">
              <span className="font-mono text-ink text-[var(--font-meta-size)]" data-testid="assistant-approval-tool-name">
                {request.name}
              </span>
              <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
                {JSON.stringify(request.args, null, 2)}
              </pre>
              {reviewConfig === undefined ? null : (
                <span className="text-subtle text-[var(--font-micro-size)]" data-testid="assistant-approval-decisions">
                  {reviewConfig.allowedDecisions.join(' / ')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="assistant-approval-approve"
          className={approvalButtonClass('approve')}
          onClick={() =>
            onApprovalDecision?.(
              approval.interruptId,
              approval.actionRequests.map(() => ({ type: 'approve' }))
            )
          }
        >
          批准
        </button>
        <button
          type="button"
          data-testid="assistant-approval-reject"
          className={approvalButtonClass('reject')}
          onClick={() =>
            onApprovalDecision?.(
              approval.interruptId,
              approval.actionRequests.map(() => ({ type: 'reject' }))
            )
          }
        >
          拒绝
        </button>
        {editableAction !== undefined && canEdit ? (
          <button
            type="button"
            data-testid="assistant-approval-edit"
            className={approvalButtonClass('edit')}
            onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'edit', editedAction: editableAction }])}
          >
            按原文执行
          </button>
        ) : null}
      </div>
      <p className="mt-1.5 text-subtle text-[var(--font-micro-size)]">
        决策会立即恢复挂起的运行；卡片不能直接关闭。
      </p>
    </ApprovalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Research gate                                                       */
/* ------------------------------------------------------------------ */

/** 闸门只会发出这三种决定；不要把 hitl 的 'edit' 混进来。 */
type GateDecisionType = 'approve' | 'revise' | 'reject';

function defaultApproveLabel(isReview: boolean): string {
  return isReview ? '接受正文' : '确认通过';
}

function defaultRejectLabel(isReview: boolean): string {
  return isReview ? '退回重审' : '退回修改';
}

export function ResearchGateApprovalCard({
  approval,
  onApprovalDecision
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
}): React.JSX.Element {
  const action = approval.actionRequests[0];
  const args = action === undefined ? null : action.args;
  const stage = readString(args, 'stage');
  const summary = readString(args, 'summary');
  const rejectNote = readString(args, 'rejectNote');
  const decisionLabel = readString(args, 'decisionLabel');
  const isReview = stage === 'review';
  const approveLabel = decisionLabel === '' ? defaultApproveLabel(isReview) : decisionLabel;
  const rejectLabel = rejectNote === '' ? defaultRejectLabel(isReview) : rejectNote;
  const decide = (type: GateDecisionType): void => {
    onApprovalDecision?.(approval.interruptId, [{ type }]);
  };
  const decisions =
    approval.reviewConfigs.find((config) => config.actionName === RESEARCH_GATE_TOOL_NAME)?.allowedDecisions ?? [
      'approve',
      'reject'
    ];
  const artifactTitles =
    action === undefined
      ? []
      : uniqueNonEmpty([
          ...readStringArray(args, 'artifactTitles'),
          ...(readString(args, 'artifactTitle') === '' ? [] : [readString(args, 'artifactTitle')])
        ]);

  return (
    <ApprovalShell
      testId="assistant-gate-card"
      eyebrow="人工闸门"
      title={
        <span data-testid="assistant-gate-stage">
          {stage === '' ? '当前阶段' : stageLabel(stage)}
          {stage === '' ? '' : ' 阶段产物'}
        </span>
      }
    >
      <p className="text-muted text-[var(--font-meta-size)]" data-testid="assistant-gate-summary">
        {summary === '' ? '确认通过本阶段产物并进入下一阶段。' : summary}
      </p>
      {artifactTitles.length === 0 ? null : (
        <ul className="mt-1.5 flex flex-col gap-0.5" data-testid="assistant-gate-artifacts">
          {artifactTitles.map((title) => (
            <li key={title} className="text-ink text-[var(--font-meta-size)]">
              · {title}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        {decisions.includes('approve') ? (
          <button
            type="button"
            data-testid="assistant-gate-approve"
            className={approvalButtonClass('approve')}
            onClick={() => decide('approve')}
          >
            {approveLabel}
          </button>
        ) : null}
        {decisions.includes('revise') ? (
          <button
            type="button"
            data-testid="assistant-gate-revise"
            className={approvalButtonClass('neutral')}
            onClick={() => decide('revise')}
          >
            要求修订
          </button>
        ) : null}
        {decisions.includes('reject') ? (
          <button
            type="button"
            data-testid="assistant-gate-reject"
            className={approvalButtonClass('reject')}
            onClick={() => decide('reject')}
          >
            {rejectLabel}
          </button>
        ) : null}
      </div>
    </ApprovalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Background task approval (minimal closure; P6 grows this)            */
/* ------------------------------------------------------------------ */

export function TaskApprovalCard({
  approval,
  onApprovalDecision
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
}): React.JSX.Element {
  const request = approval.actionRequests[0];
  const name = request?.name ?? '';
  const args = request?.args ?? null;
  const isCancel = name === 'cancel_background_task';
  const goal =
    readString(args, 'goal') === ''
      ? readString(args, 'taskId') === ''
        ? '（未提供任务描述）'
        : readString(args, 'taskId')
      : readString(args, 'goal');
  const schedule = readString(args, 'cronExpression');

  return (
    <ApprovalShell
      testId="assistant-task-approval-card"
      eyebrow="任务审批"
      title={isCancel ? '取消后台任务' : '新建 / 修改后台任务'}
    >
      <p className="text-ink text-[var(--font-read-size)]">{goal}</p>
      {schedule === '' ? null : (
        <p className="mt-0.5 font-mono text-muted text-[var(--font-meta-size)]">计划：{schedule}</p>
      )}
      <pre className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-control bg-code-surface px-2 py-1 font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="assistant-task-approval-approve"
          className={approvalButtonClass('approve')}
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'approve' }])}
        >
          {isCancel ? '确认取消任务' : '确认创建任务'}
        </button>
        <button
          type="button"
          data-testid="assistant-task-approval-reject"
          className={approvalButtonClass('reject')}
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'reject' }])}
        >
          拒绝
        </button>
      </div>
      <p className="mt-1.5 text-subtle text-[var(--font-micro-size)]">
        预览仅显示最小闭环（P6 补范围与影响）；决定会立即恢复运行。
      </p>
    </ApprovalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 阶段名与 research-workflow 的标签保持一致；这里只需要显示名。 */
function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    discovery: '发现',
    retrieval: '检索',
    reading: '阅读',
    ideation: '构思',
    planning: '方案',
    experiment: '实验 / 数据',
    figure: '绘图',
    writing: '写作',
    review: '审稿',
    revision: '修订',
    export: '导出'
  };
  return labels[stage] ?? stage;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** 闸门参数来自 interrupt payload，属于未类型化输入：只按名字取需要的字段。 */
function readString(value: Record<string, unknown> | null, key: string): string {
  const field = value === null ? undefined : value[key];
  return typeof field === 'string' ? field : '';
}

function readStringArray(value: Record<string, unknown> | null, key: string): string[] {
  const field = value === null ? undefined : value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
}
