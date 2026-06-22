import type { ChatApprovalRequest, ChatStartRunRequest } from '../../../shared/types';

export type DeepAgentExecutionResult =
  | {
      status: 'completed';
      assistantMessage: string;
    }
  | {
      status: 'interrupted';
    };

export type PendingInterrupt = {
  interruptId: string;
  payload: ChatApprovalRequest;
  taskSource: ChatStartRunRequest['taskSource'] | null;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  workspacePath: ChatStartRunRequest['workspacePath'];
};
