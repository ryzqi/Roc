import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/services/config/defaults';

describe('settings.memory defaults (Phase 2)', () => {
  it('uses Hermes-aligned char limits and Phase 2 default switches', () => {
    expect(defaultSettings.memory).toMatchObject({
      frozenSnapshotEnabled: true,
      userProfileEnabled: true,
      agentsRulesEnabled: true,
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      consolidatorEnabled: true,
      consolidatorDebounceMinutes: 10,
      consolidatorTargetRatio: 0.85,
      consolidatorDailyQuota: 50,
      preCompactionFlushEnabled: true,
      preCompactionTokenThreshold: 0.85,
      preCompactionContextWindowTokens: 200000,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
    });
  });

  it('drops legacy candidate/cold settings', () => {
    expect('candidateReviewMode' in defaultSettings.memory).toBe(false);
    expect('warmRecallEnabled' in defaultSettings.memory).toBe(false);
    expect('crossScopeRecall' in defaultSettings.memory).toBe(false);
    expect('coldAutoForgetDays' in defaultSettings.memory).toBe(false);
  });
});
