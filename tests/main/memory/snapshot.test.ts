import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFrozenSnapshot, renderFrozenSnapshot } from '../../../src/main/services/memory/snapshot';
import type { AppSettings } from '../../../src/shared/types';

let memoryDir: string;

const defaultMemorySettings: AppSettings['memory'] = {
  frozenSnapshotEnabled: true,
  userProfileEnabled: true,
  agentsRulesEnabled: true,
  charLimits: { user: 1375, agents: 800, memory: 2200 },
  sessionRetentionDays: 90,
  consolidatorEnabled: true,
  consolidatorDebounceMinutes: 10,
  consolidatorTargetRatio: 0.85,
  consolidatorDailyQuota: 50,
  preCompactionFlushEnabled: true,
  preCompactionTokenThreshold: 0.85,
  preCompactionContextWindowTokens: 200000,
  securityScan: { promptInjection: true, credential: true, sshBackdoor: true, invisibleUnicode: true }
};

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'roc-snapshot-'));
  mkdirSync(join(memoryDir, 'global'), { recursive: true });
  mkdirSync(join(memoryDir, 'workspaces', 'abcdef0123456789'), { recursive: true });
});

afterEach(() => {
  rmSync(memoryDir, { recursive: true, force: true });
});

describe('buildFrozenSnapshot', () => {
  it('returns empty global-sourced parts when files are missing', () => {
    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: 'abcdef0123456789',
      settings: defaultMemorySettings
    });

    expect(snap.user).toEqual(expect.objectContaining({ kind: 'user', source: 'global', charCount: 0, charLimit: 1375 }));
    expect(snap.agents.source).toBe('global');
    expect(snap.memory.source).toBe('global');
    expect(snap.totalChars).toBe(0);
  });

  it('prefers workspace MEMORY.md when it exists', () => {
    writeFileSync(join(memoryDir, 'workspaces', 'abcdef0123456789', 'MEMORY.md'), 'project facts');

    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: 'abcdef0123456789',
      settings: defaultMemorySettings
    });

    expect(snap.memory.source).toBe('workspace');
    expect(snap.memory.content).toBe('project facts');
    expect(snap.agents.source).toBe('global');
  });

  it('uses global sources when no workspace is selected', () => {
    writeFileSync(join(memoryDir, 'global', 'USER.md'), '# u');

    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: null,
      settings: defaultMemorySettings
    });

    expect(snap.user.source).toBe('global');
    expect(snap.agents.source).toBe('global');
    expect(snap.memory.source).toBe('global');
  });

  it('renders disabled per-file sections as empty parts', () => {
    writeFileSync(join(memoryDir, 'global', 'USER.md'), 'hello');

    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: null,
      settings: { ...defaultMemorySettings, userProfileEnabled: false }
    });

    expect(snap.user.content).toBe('');
    expect(snap.user.charCount).toBe(0);
    expect(snap.user.enabled).toBe(false);
  });
});

describe('renderFrozenSnapshot', () => {
  it('emits FROZEN_SNAPSHOT with usage and source attributes', () => {
    writeFileSync(join(memoryDir, 'global', 'USER.md'), '# user');
    writeFileSync(join(memoryDir, 'workspaces', 'abcdef0123456789', 'AGENTS.md'), '# rules');

    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: 'abcdef0123456789',
      settings: defaultMemorySettings
    });
    const rendered = renderFrozenSnapshot(snap);

    expect(rendered).toContain('<FROZEN_SNAPSHOT>');
    expect(rendered).toContain('</FROZEN_SNAPSHOT>');
    expect(rendered).toContain('<USER_PROFILE');
    expect(rendered).toContain('source="global"');
    expect(rendered).toContain('<AGENTS_RULES');
    expect(rendered).toContain('source="workspace"');
    expect(rendered).toContain('# user');
    expect(rendered).toContain('# rules');
  });

  it('renders disabled files as self-closing tags', () => {
    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: null,
      settings: { ...defaultMemorySettings, userProfileEnabled: false }
    });

    expect(renderFrozenSnapshot(snap)).toContain('<USER_PROFILE disabled="true"/>');
  });

  it('returns an empty string when frozen snapshots are globally disabled', () => {
    const snap = buildFrozenSnapshot({
      memoryDir,
      workspaceHash: null,
      settings: { ...defaultMemorySettings, frozenSnapshotEnabled: false }
    });

    expect(renderFrozenSnapshot(snap)).toBe('');
  });
});
