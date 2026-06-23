import { describe, expect, it } from 'vitest';

import { buildMemoryPromotionBullet } from '../../../../../src/main/services/deep-agent/context/memory-promotion';

describe('buildMemoryPromotionBullet', () => {
  it('builds a factual MEMORY.md bullet with run traceability', () => {
    expect(
      buildMemoryPromotionBullet({
        runId: 'run_123',
        summary: 'Verified workspace scoped session recall.'
      })
    ).toBe('- run_123: Verified workspace scoped session recall.');
  });

  it('skips empty summaries', () => {
    expect(
      buildMemoryPromotionBullet({
        runId: 'run_123',
        summary: ''
      })
    ).toBeNull();
  });

  it('does not create USER.md or AGENTS.md targets', () => {
    const bullet = buildMemoryPromotionBullet({
      runId: 'run_123',
      summary: 'Updated memory promotion.'
    });

    expect(bullet).not.toContain('USER.md');
    expect(bullet).not.toContain('AGENTS.md');
  });
});
