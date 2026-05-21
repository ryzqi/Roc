import type { ChatPendingApproval, ChatResumeDecision } from '../../../shared/types';

export function TaskApprovalCard({
  approval,
  onApprovalDecision
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
}): React.JSX.Element {
  const action = approval.actionRequests[0];
  const args = action?.args;
  return (
    <div className="chat-approval-card chat-approval-card--task" data-testid="task-approval-card">
      <header className="chat-approval-head">AI 提议：{formatTaskApprovalTitle(action?.name ?? 'background_task')}</header>
      <pre className="chat-approval-args">{JSON.stringify(args, null, 2)}</pre>
      <div className="chat-approval-buttons">
        <button
          type="button"
          className="approval-btn approval-btn--approve"
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'approve' }])}
        >
          批准创建
        </button>
        <button
          type="button"
          className="approval-btn approval-btn--edit"
          onClick={() =>
            onApprovalDecision?.(approval.interruptId, [
              {
                type: 'edit',
                editedAction: action ?? {
                  name: 'propose_background_task',
                  args: {}
                }
              }
            ])
          }
        >
          编辑后批准
        </button>
        <button
          type="button"
          className="approval-btn approval-btn--reject"
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'reject' }])}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

export function isTaskApproval(approval: ChatPendingApproval): boolean {
  return approval.actionRequests.some((request) =>
    request.name === 'propose_background_task' ||
    request.name === 'update_background_task' ||
    request.name === 'cancel_background_task'
  );
}

function formatTaskApprovalTitle(name: string): string {
  if (name === 'update_background_task') {
    return '修改任务';
  }
  if (name === 'cancel_background_task') {
    return '取消任务';
  }
  return '创建定时任务';
}
