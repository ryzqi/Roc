import { describe, expect, it } from 'vitest';

import {
  buildMemoryPromotionBullet,
  memoryFileContainsPromotionSummary,
  normalizeMemoryPromotionSummary
} from '../../../../../src/main/services/deep-agent/context/memory-promotion';

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

  it('normalizes summary text for duplicate detection', () => {
    expect(normalizeMemoryPromotionSummary('  Native memory   now uses Store records.  ')).toBe(
      'native memory now uses store records.'
    );
  });

  it('detects duplicate summaries across different run ids', () => {
    const existing = ['## 2026-06-18', '', '- run_1: Native memory now uses Store records.'].join('\n');

    expect(memoryFileContainsPromotionSummary(existing, 'native memory now uses store records.')).toBe(true);
    expect(memoryFileContainsPromotionSummary(existing, 'Different result.')).toBe(false);
  });
});
