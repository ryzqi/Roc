import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TASK_PROPOSE_EXAMPLE,
  FORBIDDEN_MODEL_TOP_LEVEL_KEYS,
  FORBIDDEN_TRIGGER_KEYS,
  MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE,
  PROPOSE_OPTIONAL_KEYS,
  PROPOSE_REQUIRED_KEYS,
  PROPOSE_TOOL_DESCRIPTION,
  PROPOSE_TOOL_NAME,
  buildTaskProposalPrompt
} from '../../src/shared/background-task-tool-contract';
import { proposeInputSchema } from '../../src/main/services/deep-agent/background-task-tools';
import { validProposeInput } from '../_factories/background-task';

describe('background task shared tool contract', () => {
  function readJsonShapeLines(prompt: string): string[] {
    return prompt.split('\n').filter((line) => line.trim().startsWith('{ "goal"'));
  }

  it('minimal canonical example only exposes model-authored keys', () => {
    expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE).sort()).toEqual(['goal', 'trigger', 'workspacePath']);
    expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger).sort()).toEqual([
      'cronExpression',
      'description',
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

  it('prompt requires a direct tool call without approval prose', () => {
    const prompt = buildTaskProposalPrompt({
      description: '每天早上 9 点检查失败测试',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(prompt).toContain('只提交一次 tool call');
    expect(prompt).toContain('不要输出普通文本');
    expect(prompt).toContain('不要请求批准');
    expect(prompt).toContain('创建任务不是预览任务');
  });

  it('prompt does not reference forbidden or runtime-only fields', () => {
    const prompt = buildTaskProposalPrompt({
      description: '每天早上 9 点检查失败测试',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(prompt).not.toReferenceForbiddenField();
    expect(prompt).toContain('不要添加 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy');
    for (const line of readJsonShapeLines(prompt)) {
      for (const field of FORBIDDEN_MODEL_TOP_LEVEL_KEYS) {
        expect(line).not.toContain(`"${field}"`);
        expect(line).not.toContain(`${field}:`);
      }
    }
  });

  it('tool description uses canonical fields without forbidden aliases', () => {
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('goal');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.type');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('cronExpression');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('nextRunAt');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('只填写 goal、trigger、workspacePath');
    expect(PROPOSE_TOOL_DESCRIPTION).toContain('不要填写 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy');
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
