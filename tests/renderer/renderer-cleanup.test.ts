import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer cleanup guards', () => {
  it('does not keep the unused async-state helper module', () => {
    expect(existsSync('src/renderer/shared/async-state.ts')).toBe(false);
  });
});
