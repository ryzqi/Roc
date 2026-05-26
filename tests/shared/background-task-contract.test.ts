import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TASK_PROPOSE_EXAMPLE,
  FORBIDDEN_TRIGGER_KEYS,
  PROPOSE_OPTIONAL_KEYS,
  PROPOSE_REQUIRED_KEYS,
  PROPOSE_TOOL_DESCRIPTION,
  PROPOSE_TOOL_NAME,
  buildTaskProposalPrompt
} from '../../src/shared/background-task-tool-contract';
import { proposeInputSchema } from '../../src/main/services/deep-agent/background-task-tools';
import { validProposeInput } from '../_factories/background-task';

describe('background task shared tool contract', () => {
  it('prompt example is accepted by the runtime schema', () => {
    expect(BACKGROUND_TASK_PROPOSE_EXAMPLE).toBeAcceptedByProposeSchema();
  });

  it('schema property name set equals the contract', () => {
    const shapeKeys = Object.keys(proposeInputSchema.shape).sort();
    expect(shapeKeys).toEqual([...PROPOSE_REQUIRED_KEYS, ...PROPOSE_OPTIONAL_KEYS, 'enabledCapabilities'].sort());
  });

  it('every forbidden trigger key is rejected by schema', () => {
    for (const key of FORBIDDEN_TRIGGER_KEYS) {
      const bad = validProposeInput();
      (bad.trigger as Record<string, unknown>)[key] = 'x';
      expect(bad).toBeRejectedByProposeSchemaAtPath('trigger');
    }
  });

  it('canonical example workspacePath is a Windows absolute path', () => {
    expect(BACKGROUND_TASK_PROPOSE_EXAMPLE.workspacePath).toMatch(/^[A-Z]:\\/u);
  });

  it('prompt embeds the concrete workspace path', () => {
    const prompt = buildTaskProposalPrompt({
      description: '每天早上 9 点检查失败测试',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(prompt).toContain('F:\\Code\\Roc');
  });

  it('prompt mentions the tool name and required schema fields', () => {
    const prompt = buildTaskProposalPrompt({
      description: '每天早上 9 点检查失败测试',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(prompt).toContain(PROPOSE_TOOL_NAME);
    expect(prompt).toContain('trigger.type');
    expect(prompt).toContain('cronExpression');
    expect(prompt).toContain('nextRunAt');
    expect(prompt).toContain('workspacePath');
  });

  it('prompt does not reference forbidden or runtime-only fields', () => {
    const prompt = buildTaskProposalPrompt({
      description: '每天早上 9 点检查失败测试',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(prompt).not.toReferenceForbiddenField();
    expect(prompt).not.toContain('notificationPolicy');
    expect(prompt).not.toContain('failurePolicy');
    expect(prompt).not.toContain('enabledCapabilities');
  });

  it('tool description uses canonical fields without forbidden aliases', () => {
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('goal');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.type');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('cronExpression');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('nextRunAt');
    expect(PROPOSE_TOOL_DESCRIPTION).not.toReferenceForbiddenField();
    expect(PROPOSE_TOOL_DESCRIPTION).not.toContain('enabledCapabilities');
  });

  it('golden: example JSON key sets are stable', () => {
    expect(Object.keys(BACKGROUND_TASK_PROPOSE_EXAMPLE).sort()).toMatchInlineSnapshot(`
      [
        "allowedActions",
        "forbiddenActions",
        "goal",
        "notificationPolicy",
        "trigger",
        "workspacePath",
      ]
    `);
    expect(Object.keys(BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger).sort()).toMatchInlineSnapshot(`
      [
        "cronExpression",
        "description",
        "nextRunAt",
        "type",
      ]
    `);
  });
});
