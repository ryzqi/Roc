import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TASK_PROPOSE_EXAMPLE,
  FORBIDDEN_TRIGGER_KEYS,
  MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE,
  PROPOSE_OPTIONAL_KEYS,
  PROPOSE_REQUIRED_KEYS,
  PROPOSE_TOOL_DESCRIPTION
} from '../../src/shared/background-task-tool-contract';
import { proposeInputSchema } from '../../src/main/services/deep-agent/background-task-tools';
import { validProposeInput } from '../_factories/background-task';

describe('background task shared tool contract', () => {
  it('minimal canonical example only exposes model-authored keys', () => {
    expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE).sort()).toEqual(['goal', 'trigger']);
    expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger).sort()).toEqual([
      'cronExpression',
      'nextRunAt',
      'type'
    ]);
  });

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

  it('tool description uses canonical fields without forbidden aliases', () => {
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('goal');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.type');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('cronExpression');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('nextRunAt');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('模型只填写 goal 和 trigger；workspacePath 由 runtime 注入。');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.description 可省略；runtime 会补齐展示说明。');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('不要填写 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('缺少明确时间时不要改用 manual；应请求澄清。');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('只有用户明确要求手动执行、按需执行或不设定时间时，才使用 manual。');
    expect(PROPOSE_TOOL_DESCRIPTION).not.toContain('只填写 goal、trigger、workspacePath');
    expect(PROPOSE_TOOL_DESCRIPTION).not.toContain('无法确定触发方式时使用 manual');
    expect(PROPOSE_TOOL_DESCRIPTION).not.toReferenceForbiddenField();
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
