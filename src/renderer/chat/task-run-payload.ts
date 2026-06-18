import type { WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
};
