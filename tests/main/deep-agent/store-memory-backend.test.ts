import { InMemoryStore } from '@langchain/langgraph';
import { StoreBackend } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';

import { createBackend } from '../../../src/main/services/deep-agent/backend';
import { RocStoreMemoryBackend } from '../../../src/main/services/deep-agent/store-memory-backend';
import { CapacityService } from '../../../src/main/services/memory/capacity';
import { defaultSettings } from '../../../src/main/services/config/defaults';
import { SecurityScanService } from '../../../src/main/services/memory/security-scan';
import { RocPaths } from '../../../src/main/services/paths';

const namespace = ['roc', 'memory', 'global'];

function createMemoryBackend(input: { limits?: { user: number; agents: number; memory: number }; workspace?: boolean } = {}) {
  const store = new InMemoryStore();
  const delegate = new StoreBackend({ store, namespace });
  const allowedKeys = new Set(input.workspace === true ? ['/AGENTS.md', '/MEMORY.md'] : ['/USER.md', '/AGENTS.md', '/MEMORY.md']);
  const kindByKey = new Map([
    ['/USER.md', 'user'],
    ['/AGENTS.md', 'agents'],
    ['/MEMORY.md', 'memory']
  ] as const);
  return {
    backend: new RocStoreMemoryBackend(
      delegate,
      allowedKeys,
      new SecurityScanService(defaultSettings.memory.securityScan),
      new CapacityService(input.limits === undefined ? defaultSettings.memory.charLimits : input.limits),
      kindByKey
    ),
    delegate,
    store
  };
}

describe('RocStoreMemoryBackend', () => {
  it('writes DeepAgents file objects into the expected namespace', async () => {
    const { backend, store } = createMemoryBackend();

    await expect(backend.write('/MEMORY.md', '# notes')).resolves.toMatchObject({ path: '/MEMORY.md' });

    const item = await store.get(namespace, '/MEMORY.md');
    expect(item?.value).toMatchObject({
      content: '# notes',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      modified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
    });
  });

  it('overwrites existing memory files through write', async () => {
    const { backend } = createMemoryBackend();
    await backend.write('/MEMORY.md', 'before');

    await expect(backend.write('/MEMORY.md', 'after')).resolves.not.toHaveProperty('error');
    await expect(backend.read('/MEMORY.md')).resolves.toMatchObject({ content: 'after' });
  });

  it('reads markdown through StoreBackend', async () => {
    const { backend } = createMemoryBackend();

    await backend.write('/MEMORY.md', '# notes');

    await expect(backend.read('/MEMORY.md')).resolves.toMatchObject({ content: '# notes' });
  });

  it('rejects non-whitelisted keys', async () => {
    const { backend, store } = createMemoryBackend();

    await expect(backend.write('/notes.md', 'notes')).resolves.toEqual({
      error: expect.stringContaining('/memory/global/USER.md')
    });
    await expect(store.get(namespace, '/notes.md')).resolves.toBeNull();
  });

  it('rejects USER.md in the workspace route', async () => {
    const { backend } = createMemoryBackend({ workspace: true });

    await expect(backend.write('/USER.md', 'user')).resolves.toEqual({
      error: expect.stringContaining('/memory/workspaces/current/MEMORY.md')
    });
  });

  it('rejects credential patterns before storing', async () => {
    const { backend, store } = createMemoryBackend();

    await expect(backend.write('/MEMORY.md', 'api_key=abcdefghijklmnop')).resolves.toEqual({
      error: expect.stringContaining('security scan')
    });
    await expect(store.get(namespace, '/MEMORY.md')).resolves.toBeNull();
  });

  it('rejects capacity overflow before storing', async () => {
    const { backend, store } = createMemoryBackend({ limits: { user: 5, agents: 5, memory: 5 } });

    await expect(backend.write('/MEMORY.md', '123456')).resolves.toEqual({
      error: expect.stringContaining('capacity exceeded')
    });
    await expect(store.get(namespace, '/MEMORY.md')).resolves.toBeNull();
  });

  it('validates edited final content before delegating', async () => {
    const { backend } = createMemoryBackend();

    await backend.write('/MEMORY.md', 'safe');
    await expect(backend.edit('/MEMORY.md', 'safe', 'api_key=abcdefghijklmnop')).resolves.toEqual({
      error: expect.stringContaining('security scan')
    });
    await expect(backend.read('/MEMORY.md')).resolves.toMatchObject({ content: 'safe' });
  });

  it('filters memory grep matches before applying maxCount', async () => {
    const { backend, delegate } = createMemoryBackend();
    const grep = vi.spyOn(delegate, 'grep').mockResolvedValue({
      matches: [
        { path: '/notes.md', line: 1, text: 'needle' },
        { path: '/AGENTS.md', line: 1, text: 'needle' },
        { path: '/MEMORY.md', line: 1, text: 'needle' }
      ]
    });

    await expect(backend.grep('needle', '/', null, 1)).resolves.toEqual({
      matches: [{ path: '/AGENTS.md', line: 1, text: 'needle' }],
      truncated: true
    });
    expect(grep).toHaveBeenCalledWith('needle', '/', undefined);
  });

  it('preserves glob truncation metadata after filtering memory files', async () => {
    const { backend, delegate } = createMemoryBackend();
    vi.spyOn(delegate, 'glob').mockResolvedValue({
      files: [
        { path: '/notes.md', is_dir: false },
        { path: '/MEMORY.md', is_dir: false }
      ],
      truncated: true
    });

    await expect(backend.glob('**/*', '/')).resolves.toEqual({
      files: [{ path: '/MEMORY.md', is_dir: false }],
      truncated: true
    });
  });

  it('uses separate global and workspace route prefixes', () => {
    const { backend } = createBackend({
      workspaceService: {
        getCurrentWorkspace: () => ({ path: 'F:\\Code\\Roc', label: 'Roc' })
      } as unknown as Parameters<typeof createBackend>[0]['workspaceService'],
      paths: new RocPaths('F:\\Code\\Roc\\.test-data'),
      store: new InMemoryStore(),
      securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
      capacity: new CapacityService(defaultSettings.memory.charLimits),
      selectedSkillIds: []
    });

    expect(backend.routePrefixes).toEqual(
      expect.arrayContaining(['/memory/global/', '/memory/workspaces/current/'])
    );
    expect(backend.routePrefixes).not.toContain('/memory/');
  });

  it('returns real bytes from downloadFiles so the memory middleware can load the prompt sources', async () => {
    const { backend } = createMemoryBackend();
    await backend.write('/USER.md', '# user prefers Python');

    const [user, missing] = await backend.downloadFiles(['/USER.md', '/MEMORY.md']);

    expect(user.error).toBeNull();
    expect(Buffer.from(user.content as Uint8Array).toString('utf8')).toBe('# user prefers Python');
    expect(missing).toEqual({ path: '/MEMORY.md', content: null, error: 'file_not_found' });
  });

  it('reports non-whitelisted download paths as file_not_found instead of permission_denied', async () => {
    const { backend } = createMemoryBackend();

    await expect(backend.downloadFiles(['/notes.md'])).resolves.toEqual([
      { path: '/notes.md', content: null, error: 'file_not_found' }
    ]);
  });

  it('reads and writes topic files under the memory char limit', async () => {
    const { backend, store } = createMemoryBackend();

    await expect(backend.write('/topics/api-notes.md', '# api notes')).resolves.toMatchObject({
      path: '/topics/api-notes.md'
    });
    await expect(backend.read('/topics/api-notes.md')).resolves.toMatchObject({ content: '# api notes' });
    expect(await store.get(namespace, '/topics/api-notes.md')).not.toBeNull();
  });

  it('rejects topic slugs outside the allowed slug pattern', async () => {
    const { backend } = createMemoryBackend();

    await expect(backend.write('/topics/API Notes.md', 'notes')).resolves.toEqual({
      error: expect.stringContaining('/memory/global/USER.md')
    });
    await expect(backend.write('/topics/nested/notes.md', 'notes')).resolves.toEqual({
      error: expect.stringContaining('/memory/global/USER.md')
    });
  });

  it('blocks a new topic file at the per-scope topic limit but still allows overwriting an existing one', async () => {
    const { backend } = createMemoryBackend();
    for (let index = 0; index < 32; index += 1) {
      await expect(backend.write(`/topics/topic-${index}.md`, `# topic ${index}`)).resolves.not.toHaveProperty('error');
    }

    await expect(backend.write('/topics/topic-32.md', '# one too many')).resolves.toEqual({
      error: expect.stringContaining('topic file limit reached (32)')
    });
    await expect(backend.write('/topics/topic-0.md', '# updated topic')).resolves.not.toHaveProperty('error');
    await expect(backend.read('/topics/topic-0.md')).resolves.toMatchObject({ content: '# updated topic' });
  });

  it('applies the memory security scan and char limit to topic files', async () => {
    const { backend } = createMemoryBackend({ limits: { user: 5, agents: 5, memory: 5 } });

    await expect(backend.write('/topics/api-notes.md', '123456')).resolves.toEqual({
      error: expect.stringContaining('capacity exceeded')
    });
    await expect(backend.write('/topics/api-notes.md', 'k=abcdefghijklmnop')).resolves.toEqual({
      error: expect.stringContaining('capacity exceeded')
    });
  });
});
