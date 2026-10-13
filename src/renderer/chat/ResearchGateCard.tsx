import type { ChatPendingApproval, ChatResumeDecision } from '../../shared/types';

const researchGateToolName = 'research_approve_gate';

/** 闸门卡只会发出这三种决定；不要把 hitl 的 'edit' 混进来。 */
type GateDecisionType = 'approve' | 'revise' | 'reject';

function defaultApproveLabel(isReview: boolean): string {
  return isReview ? '接受正文' : '确认通过';
}

function defaultRejectLabel(isReview: boolean): string {
  return isReview ? '退回重审' : '退回修改';
}

/**
 * 科研人工闸门的确认卡。闸门决定推进阶段，所以这里显示的是「哪个项目的哪个阶段、哪些产物」，
 * 而不是通用的工具名和原始 JSON。决定仍走 approval resume，与服务端闸门同一条路径。
 */
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
  const decide = (type: GateDecisionType) => {
    onApprovalDecision?.(approval.interruptId, [{ type }]);
  };
  const decisions = approval.reviewConfigs.find((config) => config.actionName === researchGateToolName)?.allowedDecisions
    ?? ['approve', 'reject'];
  const artifactTitles = action === undefined ? [] : uniqueNonEmpty([
    ...readStringArray(args, 'artifactTitles'),
    ...(readString(args, 'artifactTitle') === '' ? [] : [readString(args, 'artifactTitle')])
  ]);

  return (
    <section className="chat-gate-card" data-stage={stage} data-testid="research-gate-card">
      <header className="chat-gate-head">
        <span className="chat-gate-eyebrow">人工闸门</span>
        <strong className="chat-gate-stage" data-testid="research-gate-stage">
          {stageLabel(stage)}
          {stage === '' ? '' : '阶段产物'}
        </strong>
      </header>
      <p className="chat-gate-summary" data-testid="research-gate-summary">
        {summary === '' ? '确认通过本阶段产物并进入下一阶段。' : summary}
      </p>
      {artifactTitles.length === 0 ? null : (
        <ul className="chat-gate-artifacts" data-testid="research-gate-artifacts">
          {artifactTitles.map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ul>
      )}
      <div className="chat-gate-buttons">
        {decisions.includes('approve') ? (
          <button
            className="approval-btn approval-btn--approve"
            data-testid="research-gate-approve"
            type="button"
            onClick={() => decide('approve')}
          >
            {approveLabel}
          </button>
        ) : null}
        {decisions.includes('revise') ? (
          <button
            className="approval-btn approval-btn--neutral"
            data-testid="research-gate-revise"
            type="button"
            onClick={() => decide('revise')}
          >
            要求修订
          </button>
        ) : null}
        {decisions.includes('reject') ? (
          <button
            className="approval-btn approval-btn--reject"
            data-testid="research-gate-reject"
            type="button"
            onClick={() => decide('reject')}
          >
            {rejectLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function isResearchGateApproval(approval: ChatPendingApproval): boolean {
  return approval.kind === 'approval'
    && approval.actionRequests.length === 1
    && approval.actionRequests[0]?.name === researchGateToolName;
}

/** 阶段名与 research-workflow.ts 的 researchStageLabels 保持一致；这里只需要显示名。 */
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
