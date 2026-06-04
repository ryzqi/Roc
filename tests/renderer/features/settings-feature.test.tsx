import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('settings feature boundary', () => {
  it('routes settings IPC through RocClient instead of window.roc', () => {
    expect(existsSync('src/renderer/features/settings/index.tsx')).toBe(true);
    expect(readFileSync('src/renderer/features/settings/index.tsx', 'utf8')).toContain('RocClient');
    expect(readFileSync('src/renderer/settings/index.tsx', 'utf8')).not.toContain('window.roc');
  });
});
