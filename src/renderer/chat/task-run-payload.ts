import type { ChatImageAttachment, ChatRunMode, WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  mode?: Extract<ChatRunMode, 'chat' | 'plan'>;
  cleanThread?: boolean;
  attachments?: ChatImageAttachment[];
  explicitSkillIds?: string[];
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
};
