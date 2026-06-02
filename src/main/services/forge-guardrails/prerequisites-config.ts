import type { PrereqRule } from './state-schema';

export type PrerequisitesConfig = {
  prerequisites: Record<string, PrereqRule[]>;
};

export const ROC_PREREQUISITES: PrerequisitesConfig = {
  prerequisites: {
    edit_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
    delete_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path', currentArg: 'relativePath' }],
    write_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
    propose_background_task: [{ kind: 'nameOnly', tool: 'resolve_background_task_time' }],
    schedule_background_task: [{ kind: 'nameOnly', tool: 'propose_background_task' }],
    update_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
    cancel_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }]
  }
};

export type WorkflowSpec = {
  name: string;
  requiredSteps: string[];
  terminalTools: string[];
};

export const ROC_WORKFLOWS = {
  propose_background_task: {
    name: 'propose_background_task',
    requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
    terminalTools: ['confirm_with_user']
  },
  background_task_change: {
    name: 'background_task_change',
    requiredSteps: [],
    terminalTools: []
  }
} as const satisfies Record<string, WorkflowSpec>;

export type RocWorkflowName = keyof typeof ROC_WORKFLOWS;
