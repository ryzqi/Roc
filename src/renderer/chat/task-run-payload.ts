import type { ChatImageAttachment, WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  attachments?: ChatImageAttachment[];
  explicitSkillIds?: string[];
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
};
