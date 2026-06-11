import { describe, expect, it } from 'vitest';
import {
  contextWarning,
  prerequisiteNudge,
  stepNudge
} from '../../../../src/main/services/forge-guardrails/nudge-templates';

describe('forge nudge templates', () => {
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
