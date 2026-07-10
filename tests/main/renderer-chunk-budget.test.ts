import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer chunk budget', () => {
  it('has a source-level gate for the 1.5 MB eager graph and forbidden modules', () => {
    expect(existsSync('scripts/check-renderer-chunks.mjs')).toBe(true);
    const source = readFileSync('scripts/check-renderer-chunks.mjs', 'utf8');

    expect(source).toContain('1_500_000');
    expect(source).toContain('dynamicImports');
    expect(source).toContain('modulepreload');
    expect(source).toMatch(/markdown\|streamdown\|highlight\|settings/u);
  });
});
