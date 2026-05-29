import { describe, expect, it } from 'vitest';
import {
  contextWarning,
  prerequisiteNudge,
  retryNudge,
  stepNudge,
  unknownToolNudge
} from '../../../../src/main/services/forge-guardrails/nudge-templates';

describe('forge nudge templates', () => {
  it('returns stable retry nudge text', () => {
    expect(retryNudge('hello')).toMatchInlineSnapshot(`
      "你上一条回复不是合法的工具调用。
      在当前回合中必须用工具调用回应，不要输出自由文本。
      请重新生成一条合法的工具调用。"
    `);
  });

  it('lists unknown tool alternatives', () => {
    expect(unknownToolNudge('bad_tool', ['read_file', 'edit_file'])).toMatchInlineSnapshot(`
      "工具 bad_tool 不存在。
      当前可用工具：read_file、edit_file。
      请从上述工具中选择一个调用。"
    `);
  });

  it('escalates step nudges by tier', () => {
    const tier1 = stepNudge('confirm_with_user', ['schedule_background_task'], 1);
    const tier2 = stepNudge('confirm_with_user', ['schedule_background_task'], 2);
    const tier3 = stepNudge('confirm_with_user', ['schedule_background_task'], 3);

    expect(tier1).not.toBe(tier2);
    expect(tier2).not.toBe(tier3);
    expect(tier3).toContain('停止');
    expect(tier3).toContain('schedule_background_task');
  });

  it('mentions missing prerequisite tools', () => {
    expect(prerequisiteNudge('edit_file', ['read_file'])).toContain('read_file');
  });

  it('warns only above context usage thresholds', () => {
    expect(contextWarning(800, 1000)).toContain('80%');
    expect(contextWarning(700, 1000)).toContain('70%');
    expect(contextWarning(600, 1000)).toBeNull();
    expect(contextWarning(1, 0)).toBeNull();
  });
});
