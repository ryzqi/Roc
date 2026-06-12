import { describe, expect, it } from 'vitest';
import {
  contextWarning
} from '../../../../src/main/services/forge-guardrails/nudge-templates';

describe('forge nudge templates', () => {
  it('warns only above context usage thresholds', () => {
    expect(contextWarning(800, 1000)).toContain('80%');
    expect(contextWarning(700, 1000)).toContain('70%');
    expect(contextWarning(600, 1000)).toBeNull();
    expect(contextWarning(1, 0)).toBeNull();
  });
});
