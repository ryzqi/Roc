import { describe, expect, it } from 'vitest';
import { getHarnessProfile } from 'deepagents';
import { ensureRocHarnessProfilesRegistered } from '../../src/main/services/deep-agent/harness-profiles';

describe('Roc harness profiles registration', () => {
  it('excludes the built-in SummarizationMiddleware under both provider keys', () => {
    ensureRocHarnessProfilesRegistered();

    const openai = getHarnessProfile('openai');
    const anthropic = getHarnessProfile('anthropic');

    expect(openai).toBeDefined();
    expect(anthropic).toBeDefined();
    expect(openai?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
    expect(anthropic?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
  });

  it('is idempotent: repeated calls neither throw nor drop the exclusion', () => {
    ensureRocHarnessProfilesRegistered();
    ensureRocHarnessProfilesRegistered();
    ensureRocHarnessProfilesRegistered();

    const openai = getHarnessProfile('openai');
    expect(Array.from(openai?.excludedMiddleware ?? [])).toContain('SummarizationMiddleware');
  });
});
