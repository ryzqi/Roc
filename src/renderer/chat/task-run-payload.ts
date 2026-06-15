import type { WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
};

export type QueuedTaskPrompt = {
  input: string;
  workflowHint: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string;
};
