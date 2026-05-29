import { ROC_WORKFLOWS, type WorkflowSpec } from './prerequisites-config';

export type WorkflowHint = 'propose_background_task' | 'background_task_change' | null;

export function resolveWorkflow(hint: WorkflowHint): WorkflowSpec | null {
  if (hint === 'propose_background_task') {
    return ROC_WORKFLOWS.propose_background_task;
  }
  if (hint === 'background_task_change') {
    return ROC_WORKFLOWS.background_task_change;
  }
  return null;
}
