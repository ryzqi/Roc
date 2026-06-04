import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('skills feature boundary', () => {
  it('routes Skills IPC through RocClient instead of window.roc', () => {
    expect(existsSync('src/renderer/features/skills/index.tsx')).toBe(true);
    expect(readFileSync('src/renderer/features/skills/index.tsx', 'utf8')).toContain('RocClient');
    expect(readFileSync('src/renderer/views/skills/SkillsHostView.tsx', 'utf8')).not.toContain('window.roc');
  });
});
