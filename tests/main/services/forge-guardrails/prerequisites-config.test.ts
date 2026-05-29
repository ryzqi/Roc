import { describe, expect, it } from 'vitest';
import {
  ROC_PREREQUISITES,
  ROC_WORKFLOWS
} from '../../../../src/main/services/forge-guardrails/prerequisites-config';

describe('forge prerequisites config', () => {
  it('defines the propose and background task workflows', () => {
    expect(ROC_WORKFLOWS.propose_background_task).toEqual({
      name: 'propose_background_task',
      requiredSteps: ['propose_background_task', 'schedule_background_task'],
      terminalTools: ['confirm_with_user']
    });
    expect(ROC_WORKFLOWS.background_task_change).toEqual({
      name: 'background_task_change',
      requiredSteps: [],
      terminalTools: []
    });
  });

  it('declares all file and background task prerequisite rules', () => {
    expect(ROC_PREREQUISITES.prerequisites).toEqual({
      edit_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path' }],
      delete_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path', currentArg: 'relativePath' }],
      write_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'path' }],
      schedule_background_task: [{ kind: 'nameOnly', tool: 'propose_background_task' }],
      update_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
      cancel_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }]
    });
    expect(Object.values(ROC_PREREQUISITES.prerequisites).flat()).toHaveLength(6);
  });
});
