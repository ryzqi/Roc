import { describe, expect, it } from 'vitest';

import {
  listMemorySlots,
  resolveMemorySlotByScopeKind,
  resolveMemorySlotByVirtualPath
} from '../../../src/main/services/memory/store-slots';

describe('memory store slots', () => {
  it('lists the five approved slots when a workspace hash exists', () => {
    expect(listMemorySlots('abcdef0123456789')).toEqual([
      {
        scope: 'global',
        kind: 'user',
        virtualPath: '/memory/global/USER.md',
        routePrefix: '/memory/global/',
        storeKey: '/USER.md',
        namespace: ['roc', 'memory', 'global'],
        limitKey: 'user'
      },
      {
        scope: 'global',
        kind: 'agents',
        virtualPath: '/memory/global/AGENTS.md',
        routePrefix: '/memory/global/',
        storeKey: '/AGENTS.md',
        namespace: ['roc', 'memory', 'global'],
        limitKey: 'agents'
      },
      {
        scope: 'global',
        kind: 'memory',
        virtualPath: '/memory/global/MEMORY.md',
        routePrefix: '/memory/global/',
        storeKey: '/MEMORY.md',
        namespace: ['roc', 'memory', 'global'],
        limitKey: 'memory'
      },
      {
        scope: 'workspace',
        kind: 'agents',
        virtualPath: '/memory/workspaces/current/AGENTS.md',
        routePrefix: '/memory/workspaces/current/',
        storeKey: '/AGENTS.md',
        namespace: ['roc', 'memory', 'workspaces', 'abcdef0123456789'],
        limitKey: 'agents'
      },
      {
        scope: 'workspace',
        kind: 'memory',
        virtualPath: '/memory/workspaces/current/MEMORY.md',
        routePrefix: '/memory/workspaces/current/',
        storeKey: '/MEMORY.md',
        namespace: ['roc', 'memory', 'workspaces', 'abcdef0123456789'],
        limitKey: 'memory'
      }
    ]);
  });

  it('resolves all five approved virtual paths', () => {
    const paths = [
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md',
      '/memory/global/MEMORY.md',
      '/memory/workspaces/current/AGENTS.md',
      '/memory/workspaces/current/MEMORY.md'
    ];

    expect(paths.map((path) => resolveMemorySlotByVirtualPath(path, 'wks_hash'))).toEqual(
      expect.arrayContaining(paths.map((path) => expect.objectContaining({ ok: true, slot: expect.objectContaining({ virtualPath: path }) })))
    );
  });

  it('rejects paths outside the five-slot whitelist', () => {
    expect(resolveMemorySlotByVirtualPath('/memory/global/notes.md', 'wks_hash')).toEqual({
      ok: false,
      reason: 'invalid_path',
      detail: expect.stringContaining('/memory/global/USER.md')
    });
  });

  it('rejects USER.md in workspace scope', () => {
    expect(resolveMemorySlotByVirtualPath('/memory/workspaces/current/USER.md', 'wks_hash')).toEqual({
      ok: false,
      reason: 'invalid_path',
      detail: 'USER.md lives only at /memory/global/USER.md.'
    });
  });

  it('rejects explicit workspace hashes', () => {
    expect(resolveMemorySlotByVirtualPath('/memory/workspaces/1234567890abcdef/MEMORY.md', 'wks_hash')).toEqual({
      ok: false,
      reason: 'invalid_path',
      detail: expect.stringContaining('/memory/workspaces/current/MEMORY.md')
    });
  });

  it('rejects workspace slots when no workspace is selected', () => {
    expect(resolveMemorySlotByVirtualPath('/memory/workspaces/current/MEMORY.md', null)).toEqual({
      ok: false,
      reason: 'workspace_required',
      detail: 'No workspace selected; select a workspace before writing workspace-scoped memory.'
    });
    expect(resolveMemorySlotByScopeKind({ scope: 'workspace', kind: 'agents' }, null)).toEqual({
      ok: false,
      reason: 'workspace_required',
      detail: 'No workspace selected; select a workspace before writing workspace-scoped memory.'
    });
  });

  it('resolves by scope and kind', () => {
    expect(resolveMemorySlotByScopeKind({ scope: 'workspace', kind: 'memory' }, 'wks_hash')).toEqual({
      ok: true,
      slot: expect.objectContaining({
        virtualPath: '/memory/workspaces/current/MEMORY.md',
        storeKey: '/MEMORY.md',
        namespace: ['roc', 'memory', 'workspaces', 'wks_hash']
      })
    });
  });
});
