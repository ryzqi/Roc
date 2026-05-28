import { describe, expect, it } from 'vitest';
import { buildWorkspaceHash } from '../../../src/main/services/paths';
import { resolveMemoryPath } from '../../../src/main/services/memory/path-resolver';

describe('buildWorkspaceHash', () => {
  it('returns null when no workspace is selected', () => {
    expect(buildWorkspaceHash(null)).toBeNull();
  });

  it('normalizes equivalent workspace paths before hashing', () => {
    expect(buildWorkspaceHash('F:\\Code\\Roc\\.')).toBe(buildWorkspaceHash('f:\\code\\roc'));
  });
});

describe('resolveMemoryPath', () => {
  it('resolves global USER.md', () => {
    expect(resolveMemoryPath('/memory/global/USER.md', 'wks_abc123')).toEqual({
      ok: true,
      resolved: '/global/USER.md',
      kind: 'user'
    });
  });

  it('resolves global AGENTS / MEMORY', () => {
    const agents = resolveMemoryPath('/memory/global/AGENTS.md', 'wks_abc123');
    expect(agents.ok && agents.kind).toBe('agents');
    const memory = resolveMemoryPath('/memory/global/MEMORY.md', 'wks_abc123');
    expect(memory.ok && memory.kind).toBe('memory');
  });

  it('expands /memory/workspaces/current/ to hash subdir', () => {
    const result = resolveMemoryPath('/memory/workspaces/current/MEMORY.md', 'abcdef0123456789');
    expect(result).toEqual({
      ok: true,
      resolved: '/workspaces/abcdef0123456789/MEMORY.md',
      kind: 'memory'
    });
  });

  it('rejects USER.md under workspaces', () => {
    const result = resolveMemoryPath('/memory/workspaces/current/USER.md', 'wks_abc123');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/USER/);
    }
  });

  it('rejects current when no workspace selected', () => {
    const result = resolveMemoryPath('/memory/workspaces/current/MEMORY.md', null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace/i);
    }
  });

  it('rejects internal backup directory', () => {
    const result = resolveMemoryPath('/memory/.consolidator-backup/MEMORY.md.2026-01-01.md', 'wks_abc123');
    expect(result.ok).toBe(false);
  });

  it('rejects unknown filenames', () => {
    const result = resolveMemoryPath('/memory/global/notes.md', 'wks_abc123');
    expect(result.ok).toBe(false);
  });

  it('allows explicit hash subdir', () => {
    const result = resolveMemoryPath('/memory/workspaces/1234567890abcdef/MEMORY.md', 'abcdef0123456789');
    expect(result).toEqual({
      ok: true,
      resolved: '/workspaces/1234567890abcdef/MEMORY.md',
      kind: 'memory'
    });
  });

  it('rejects path outside /memory/', () => {
    const result = resolveMemoryPath('/workspace/file.md', 'wks_abc123');
    expect(result.ok).toBe(false);
  });
});
