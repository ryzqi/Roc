import { ROC_WORKFLOWS, type WorkflowSpec } from './prerequisites-config';
import type { WorkflowHint } from '../../../shared/types';

export type { WorkflowHint };

export function resolveWorkflow(hint: WorkflowHint): WorkflowSpec | null {
  if (hint === 'propose_background_task') {
    return ROC_WORKFLOWS.propose_background_task;
  }
  if (hint === 'background_task_change') {
    return ROC_WORKFLOWS.background_task_change;
  }
  return null;
}
