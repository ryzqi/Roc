import type { WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
};

export type QueuedTaskPrompt = {
  input: string;
  workflowHint: WorkflowHint;
  workspacePath?: string;
};
