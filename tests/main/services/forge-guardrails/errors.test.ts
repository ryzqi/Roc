import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../../../src/main/services/errors';
import { FORGE_EXHAUSTED_CODES, RocToolResolutionError } from '../../../../src/main/services/forge-guardrails/errors';

describe('forge guardrails errors', () => {
  it('creates a tool resolution error without treating it as a RocDomainError', () => {
    const error = new RocToolResolutionError('missing record');

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RocDomainError);
    expect(error.name).toBe('RocToolResolutionError');
    expect(error.message).toBe('missing record');
    expect(error.toolName).toBeNull();
  });

  it('stores the failing tool name when provided', () => {
    const error = new RocToolResolutionError('missing file', { toolName: 'read_file' });

    expect(error.toolName).toBe('read_file');
  });

  it('defines only forge exhausted error codes', () => {
    expect(Object.values(FORGE_EXHAUSTED_CODES).sort()).toEqual([
      'forge_retries_exhausted',
      'forge_tool_errors_exhausted'
    ]);
    for (const code of Object.values(FORGE_EXHAUSTED_CODES)) {
      expect(code).toMatch(/^forge_[a-z_]+_exhausted$/u);
    }
  });
});
