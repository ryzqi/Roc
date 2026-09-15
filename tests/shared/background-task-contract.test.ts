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

  it('canonical example workspacePath is a macOS absolute path', () => {
    expect(BACKGROUND_TASK_PROPOSE_EXAMPLE.workspacePath).toMatch(/^\/Users\//u);
  });

  it('tool description uses canonical fields without forbidden aliases', () => {
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('goal');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.type');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('cronExpression');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('nextRunAt');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('只填写 goal 和 trigger；workspacePath 与策略字段由 runtime 注入。');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.type 为 manual、once 或 cron；description 可省略。');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('时间不明确时请求澄清，不要改用 manual；manual 仅用于用户明确要求手动执行。');
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
