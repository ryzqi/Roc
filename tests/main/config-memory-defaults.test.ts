import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/services/config/defaults';

describe('settings.memory defaults', () => {
  it('keeps only native DeepAgents memory settings', () => {
    expect(defaultSettings.memory).toEqual({
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
    });
  });

  it('drops legacy candidate/cold and disk-memory pipeline settings', () => {
    expect('candidateReviewMode' in defaultSettings.memory).toBe(false);
    expect('warmRecallEnabled' in defaultSettings.memory).toBe(false);
    expect('crossScopeRecall' in defaultSettings.memory).toBe(false);
    expect('coldAutoForgetDays' in defaultSettings.memory).toBe(false);
  });
});
