import type { OpenResearchArtifact, ReadResearchGateContext } from '../artifacts/artifact-interactions';
import type { ChatPendingApproval, ChatResumeDecision } from '../../shared/types';
import { ChatApprovalCard, ResearchGateApprovalCard, TaskApprovalCard, isResearchGateApproval, isTaskApproval } from './blocks/approval-cards';

type Props = {pendingItems: ChatPendingApproval[]; pending: boolean; onDecide: (id: string, decisions: ChatResumeDecision[]) => void; onOpenArtifact: OpenResearchArtifact; onReadGateContext: ReadResearchGateContext};
function summary(approval: ChatPendingApproval): string {
  const action = approval.actionRequests[0];
  if (isResearchGateApproval(approval)) return '研究阶段需要你的决定';
  if (isTaskApproval(approval)) return action?.name === 'cancel_background_task' ? '请求停止后台任务' : '请求修改后台任务';
  const args = action?.args ?? {};
  const path = typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : typeof args.targetPath === 'string' ? args.targetPath : null;
  const risk = typeof args.riskLevel === 'string' ? `，风险${args.riskLevel}` : '';
  return `${approval.actionRequests.length} 项工具请求等待授权${path === null ? risk : `，目标 ${path}${risk}`}`;
}
export function HitlApprovalDock({pendingItems, pending, onDecide, onOpenArtifact, onReadGateContext}: Props): React.JSX.Element | null {
  if (pendingItems.length === 0) return null;
  return <aside id="assistant-hitl-dock" className="hitl-approval-dock shrink-0 border-t-[0.5px] border-line-default bg-surface-raised px-3 py-2" data-testid="assistant-hitl-dock" tabIndex={-1} aria-label="待处理审批">
    <div className="hitl-approval-dock__items" data-testid="assistant-hitl-items">
      {pendingItems.map(approval => <div key={approval.interruptId} data-approval-id={approval.interruptId}>
        <p className="px-1 text-ink-muted text-[length:var(--font-micro-size)]"><span className="me-2 inline-block size-1.5 rounded-full bg-[var(--status-warning)]" aria-hidden="true" />{summary(approval)}</p>
        {isResearchGateApproval(approval) ? <ResearchGateApprovalCard approval={approval} onApprovalDecision={onDecide} approvalPending={pending}
          onOpenArtifact={onOpenArtifact} onReadGateContext={onReadGateContext} /> : isTaskApproval(approval)
          ? <TaskApprovalCard approval={approval} onApprovalDecision={onDecide} approvalPending={pending} />
          : <ChatApprovalCard approval={approval} onApprovalDecision={onDecide} approvalPending={pending} />}
      </div>)}
    </div>
  </aside>;
}
