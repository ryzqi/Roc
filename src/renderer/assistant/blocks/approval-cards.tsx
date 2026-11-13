import {useCallback, useEffect, useRef, useState} from 'react';
import {researchArtifactLinksSchema} from '../../../shared/schemas/research-artifact-inspector';
import {researchGateReviewRequestSchema, type ResearchGateReviewContext} from '../../../shared/schemas/research-gate-review';
import type {OpenResearchArtifact, ReadResearchGateContext} from '../../artifacts/artifact-interactions';
import {useAsyncResource} from '../../app/use-async-resource';
import { ShieldCheck } from 'lucide-react';
import type { ChatPendingApproval, ChatResumeDecision } from '../../../shared/types';
import { researchSearchPlanSchema } from '../../../shared/schemas/research-search-plan';

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

// Approval choices carry equal emphasis; the labels describe the decision.
function approvalButtonClass(_kind: 'approve' | 'neutral' | 'reject' | 'edit'): string {
  return 'min-h-[var(--control-height)] rounded-control border-[0.5px] border-line px-3 text-ink hover:border-line-strong hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
}

function ApprovalShell({
  testId,
  eyebrow,
  title,
  pending = false,
  children
}: {
  testId: string;
  eyebrow: string;
  title: React.ReactNode;
  pending?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="my-2 rounded-card border-[0.5px] border-[var(--st-warn-line)] bg-surface px-3 py-2"
      data-testid={testId}
      aria-busy={pending || undefined}
    >
      <header className="mb-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[var(--st-warn)] text-[length:var(--font-micro-size)]">
          <ShieldCheck size={12} aria-hidden="true" />
          {eyebrow}
        </span>
        <strong className="text-ink text-[length:var(--font-h3-size)]">{title}</strong>
      </header>
      {children}
      {pending ? <p role="status" className="mt-1.5 text-muted text-[length:var(--font-meta-size)]" data-testid="assistant-approval-pending">正在提交审批决定…</p> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Generic approval                                                    */
/* ------------------------------------------------------------------ */

export function ChatApprovalCard({
  approval,
  onApprovalDecision,
  approvalPending = false
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  approvalPending?: boolean;
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
      eyebrow={`等待审批，${approval.actionRequests.length} 项工具请求`}
      title="助手请求执行工具"
      pending={approvalPending && onApprovalDecision !== undefined}
    >
      <ul className="flex flex-col gap-1.5">
        {approval.actionRequests.map((request, index) => {
          const reviewConfig = approval.reviewConfigs.find((config) => config.actionName === request.name);
          return (
            <li key={`${request.name}-${index}`} className="rounded-control bg-bg-soft px-2 py-1.5">
              <span className="font-mono text-ink text-[length:var(--font-meta-size)]" data-testid="assistant-approval-tool-name">
                {request.name}
              </span>
              <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[length:var(--font-code-size)]">
                {JSON.stringify(request.args, null, 2)}
              </pre>
              {reviewConfig === undefined ? null : (
                <span className="text-subtle text-[length:var(--font-micro-size)]" data-testid="assistant-approval-decisions">
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
          disabled={onApprovalDecision === undefined}
          aria-disabled={approvalPending || onApprovalDecision === undefined}
          className={approvalButtonClass('approve')}
          onClick={() =>
            !approvalPending && onApprovalDecision?.(
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
          disabled={onApprovalDecision === undefined}
          aria-disabled={approvalPending || onApprovalDecision === undefined}
          className={approvalButtonClass('reject')}
          onClick={() =>
            !approvalPending && onApprovalDecision?.(
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
            disabled={onApprovalDecision === undefined}
            aria-disabled={approvalPending || onApprovalDecision === undefined}
            className={approvalButtonClass('edit')}
            onClick={() => { if (!approvalPending) onApprovalDecision?.(approval.interruptId, [{ type: 'edit', editedAction: editableAction }]); }}
          >
            按原文执行
          </button>
        ) : null}
      </div>
      {onApprovalDecision === undefined ? (
        <p role="note" className="mt-1.5 text-subtle text-[length:var(--font-micro-size)]">当前审批仅供查看。</p>
      ) : null}
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
  onOpenArtifact,
  onReadGateContext,
  onApprovalDecision,
  approvalPending = false
}: {
  approval: ChatPendingApproval;
  onOpenArtifact: OpenResearchArtifact;
  onReadGateContext: ReadResearchGateContext;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  approvalPending?: boolean;
}): React.JSX.Element {
  const action = approval.actionRequests[0];
  const args = action === undefined ? null : action.args;
  const stage = readString(args, 'stage');
  const summary = readString(args, 'summary');
  const rejectNote = readString(args, 'rejectNote');
  const decisionLabel = readString(args, 'decisionLabel');
  const reviewError = readString(args, 'reviewError');
  const isReview = stage === 'review';
  const isDiscovery = stage === 'discovery';
  const gateRequest = researchGateReviewRequestSchema.safeParse({projectId: readString(args, 'projectId'), expectedStage: stage, artifactId: null});
  const approvalKey = JSON.stringify([approval.interruptId, readString(args, 'projectId'), stage]);
  const [reviewed, setReviewed] = useState<{key: string; context: ResearchGateReviewContext} | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(approvalPending);
  pendingRef.current = approvalPending;
  const refreshed = useAsyncResource(gateRequest.success && refreshNonce > 0 ? `${approvalKey}:${refreshNonce}` : null,
    () => onReadGateContext(researchGateReviewRequestSchema.parse({projectId: readString(args, 'projectId'), expectedStage: stage, artifactId: null})),
    {label: '读取阶段审核上下文'});
  const acceptContext = useCallback((context: ResearchGateReviewContext): void => {
    if (pendingRef.current) return;
    setReviewed({key: approvalKey, context});
    setRefreshNonce(0);
    // Restore the gate control after the drawer and its original opener finish unmounting.
    requestAnimationFrame(() => refreshButton.current?.focus({preventScroll: true}));
  }, [approvalKey]);
  useEffect(() => {
    if (refreshed.status === 'ready' && refreshed.data !== null) acceptContext(refreshed.data);
  }, [refreshed.status, refreshed.data, acceptContext]);
  const context = reviewed?.key === approvalKey ? reviewed.context : null;
  const plan = isDiscovery ? researchSearchPlanSchema.safeParse(context === null ? args?.searchPlan : context.searchPlan) : null;
  const planHash = context === null ? readString(args, 'searchPlanHash') : context.searchPlanHash ?? '';
  const links = researchArtifactLinksSchema.safeParse(context === null ? args?.artifactLinks : context.artifactLinks);
  const canDecide = onApprovalDecision !== undefined && links.success && gateRequest.success &&
    links.data.every(link => link.projectId === gateRequest.data.projectId) && refreshNonce === 0;
  const canApprovePlan = canDecide && (!isDiscovery || plan?.success === true && /^[a-f0-9]{64}$/u.test(planHash));
  const approveLabel = decisionLabel === '' ? defaultApproveLabel(isReview) : decisionLabel;
  const rejectLabel = rejectNote === '' ? defaultRejectLabel(isReview) : rejectNote;
  const decide = (type: GateDecisionType): void => {
    if (approvalPending || !links.success || !canDecide) return;
    const reviewedArtifactVersions = links.data.map(link => ({artifactId: link.artifactId, version: link.expectedVersion}));
    if (type === 'approve') {
      if (!canApprovePlan) return;
      onApprovalDecision?.(approval.interruptId, [{type, reviewedArtifactVersions, ...(isDiscovery ? {reviewedSearchPlanHash: planHash} : {})}]);
    } else onApprovalDecision?.(approval.interruptId, [{type, reviewedArtifactVersions}]);
  };
  const decisions =
    approval.reviewConfigs.find((config) => config.actionName === RESEARCH_GATE_TOOL_NAME)?.allowedDecisions ?? [
      'approve',
      'reject'
    ];

  return (
    <ApprovalShell
      testId="assistant-gate-card"
      eyebrow="人工闸门"
      pending={approvalPending && onApprovalDecision !== undefined}
      title={
        <span data-testid="assistant-gate-stage">
          {stage === '' ? '当前阶段' : stageLabel(stage)}
          {stage === '' ? '' : ' 阶段产物'}
        </span>
      }
    >
      <p className="text-muted text-[length:var(--font-meta-size)]" data-testid="assistant-gate-summary">
        {summary === '' ? '确认通过本阶段产物并进入下一阶段。' : summary}
      </p>
      {onApprovalDecision === undefined ? <p role="status" className="mt-2 text-muted" data-testid="assistant-gate-inactive">
        此审批已不在当前待恢复运行中。可查看工件，或在助手中重新请求本阶段审核。
      </p> : null}
      {reviewError === '' ? null : <p role="alert" className="mt-2 text-[var(--st-bad)]" data-testid="assistant-gate-review-error">
        上次决定未执行：{reviewError} 请核对下面的完整阶段上下文，再重新确认。
      </p>}
      {links.success ? <ul className="mt-1.5 flex flex-col gap-1" data-testid="assistant-gate-artifacts">
        {links.data.map(link => <li key={link.artifactId}>
          <button type="button" className="break-words text-left text-ink underline decoration-line underline-offset-2 hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            aria-disabled={approvalPending} data-testid="assistant-gate-artifact" onClick={() => { if (!approvalPending) onOpenArtifact({projectId: link.projectId, artifactId: link.artifactId, expectedVersion: link.expectedVersion}, acceptContext); }}>
            {link.title}
          </button>
        </li>)}
      </ul> : <p role="alert" className="mt-2 text-[var(--st-bad)]">真实工件标识缺失或无效，闸门决定已禁用。请重新读取本阶段审核上下文。</p>}
      {isDiscovery ? plan?.success && /^[a-f0-9]{64}$/u.test(planHash) ? (
        <div className="mt-2 max-h-[320px] overflow-auto break-words text-ink text-[length:var(--font-meta-size)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          tabIndex={0} aria-label="待确认检索计划" data-testid="assistant-gate-search-plan">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted">原始研究指令</dt><dd>{plan.data.researchQuestion}</dd>
            <dt className="text-muted">计划版本</dt><dd>{plan.data.version}</dd>
            <dt className="text-muted">建议研究问题</dt><dd>{plan.data.refinedQuestion}</dd>
            <dt className="text-muted">领域</dt><dd>{plan.data.domain}</dd>
            <dt className="text-muted">关键词</dt><dd>{plan.data.keywords.join('、')}</dd>
            <dt className="text-muted">同义词</dt><dd>{plan.data.synonyms.length === 0 ? '无' : plan.data.synonyms.map(entry => `${entry.term}：${entry.alternatives.join('、')}`).join('；')}</dd>
            <dt className="text-muted">筛选排除项</dt><dd>{plan.data.excludedTerms.length === 0 ? '无' : plan.data.excludedTerms.join('、')}</dd>
          </dl>
          <ul className="mt-2 flex flex-col gap-2" aria-label="检索视角">
            {plan.data.perspectives.map(view => <li key={view.id}>
              <p className="font-medium">{view.label}</p>
              <p>{view.rationale}</p>
              <p className="text-muted">预期证据：{view.expectedEvidence}；查询：{view.queryIds.join('、')}</p>
            </li>)}
          </ul>
          <ol className="mt-2 flex flex-col gap-2">
            {plan.data.queries.map((query, index) => (
              <li key={query.id} className="border-t-[0.5px] border-line pt-2">
                <p className="font-medium">查询 {index + 1}（{query.id}）：{query.query}</p>
                <p className="text-muted">{query.sources.join('、')}，{query.yearFrom ?? '不限'} 至 {query.yearTo ?? '不限'}，每来源最多 {query.maxPages} 页，每页 {query.limit} 条，最终最多 {query.limit} 篇</p>
              </li>
            ))}
          </ol>
        </div>
      ) : <p role="alert" className="mt-2 text-[var(--st-bad)]">检索计划缺失或无效，请退回重做。</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" ref={refreshButton} data-testid="assistant-gate-refresh"
          disabled={!gateRequest.success || refreshed.status === 'loading'}
          aria-disabled={approvalPending || !gateRequest.success || refreshed.status === 'loading'}
          className={`${approvalButtonClass('neutral')} disabled:cursor-not-allowed disabled:opacity-50`}
          onClick={() => { if (!approvalPending) setRefreshNonce(value => value + 1); }}>重新读取本阶段审核上下文</button>
        {refreshNonce > 0 && refreshed.status === 'loading' ? <span role="status" className="text-muted">正在读取全部阶段工件…</span> : null}
        {context === null ? null : <span className="text-muted text-[length:var(--font-meta-size)]" data-testid="assistant-gate-reviewed-at">
          已重读 {context.artifactLinks.length} 个工件，需重新确认，{context.readAt}
        </span>}
      </div>
      {refreshNonce > 0 && refreshed.error !== null ? <p role="alert" className="mt-2 text-[var(--st-bad)]">{refreshed.error}</p> : null}
      {!gateRequest.success ? <p className="mt-1 text-muted">项目或阶段标识无效，请在助手中重新请求人工闸门。</p> : null}
      <div className="mt-2 flex items-center gap-2">
        {decisions.includes('approve') ? (
          <button
            type="button"
            data-testid="assistant-gate-approve"
            disabled={!canApprovePlan}
            aria-disabled={approvalPending || !canApprovePlan}
            className={`${approvalButtonClass('approve')} disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={() => decide('approve')}
          >
            {approveLabel}
          </button>
        ) : null}
        {decisions.includes('revise') ? (
          <button
            type="button"
            data-testid="assistant-gate-revise"
            disabled={!canDecide}
            aria-disabled={approvalPending || !canDecide}
            className={`${approvalButtonClass('neutral')} disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={() => decide('revise')}
          >
            要求修订
          </button>
        ) : null}
        {decisions.includes('reject') ? (
          <button
            type="button"
            data-testid="assistant-gate-reject"
            disabled={!canDecide}
            aria-disabled={approvalPending || !canDecide}
            className={`${approvalButtonClass('reject')} disabled:cursor-not-allowed disabled:opacity-50`}
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
  onApprovalDecision,
  approvalPending = false
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  approvalPending?: boolean;
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
      pending={approvalPending && onApprovalDecision !== undefined}
    >
      <p className="text-ink text-[length:var(--font-read-size)]">{goal}</p>
      {schedule === '' ? null : (
        <p className="mt-0.5 font-mono text-muted text-[length:var(--font-meta-size)]">计划：{schedule}</p>
      )}
      <pre className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-control bg-code-surface px-2 py-1 font-mono text-[var(--code-text)] text-[length:var(--font-code-size)]">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="assistant-task-approval-approve"
          disabled={onApprovalDecision === undefined}
          aria-disabled={approvalPending || onApprovalDecision === undefined}
          className={approvalButtonClass('approve')}
          onClick={() => { if (!approvalPending) onApprovalDecision?.(approval.interruptId, [{ type: 'approve' }]); }}
        >
          {isCancel ? '确认取消任务' : '确认创建任务'}
        </button>
        <button
          type="button"
          data-testid="assistant-task-approval-reject"
          disabled={onApprovalDecision === undefined}
          aria-disabled={approvalPending || onApprovalDecision === undefined}
          className={approvalButtonClass('reject')}
          onClick={() => { if (!approvalPending) onApprovalDecision?.(approval.interruptId, [{ type: 'reject' }]); }}
        >
          拒绝
        </button>
      </div>
      {onApprovalDecision === undefined ? (
        <p role="note" className="mt-1.5 text-subtle text-[length:var(--font-micro-size)]">当前审批仅供查看。</p>
      ) : null}
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

/** 闸门参数来自 interrupt payload，属于未类型化输入：只按名字取需要的字段。 */
function readString(value: Record<string, unknown> | null, key: string): string {
  const field = value === null ? undefined : value[key];
  return typeof field === 'string' ? field : '';
}
