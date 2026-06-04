import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('diagnostics feature boundary', () => {
  it('routes diagnostics loading through RocClient instead of window.roc', () => {
    expect(existsSync('src/renderer/features/diagnostics/index.tsx')).toBe(true);
    expect(readFileSync('src/renderer/features/diagnostics/index.tsx', 'utf8')).toContain('RocClient');
    expect(readFileSync('src/renderer/app/data-loading.ts', 'utf8')).not.toContain('window.roc.diagnostics');
  });
});
