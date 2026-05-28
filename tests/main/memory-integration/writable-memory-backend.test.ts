import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WritableMemoryFilesystemBackend } from '../../../src/main/services/deep-agent/writable-memory-backend';
import { CapacityService } from '../../../src/main/services/memory/capacity';
import { SecurityScanService } from '../../../src/main/services/memory/security-scan';

const allOn = {
  promptInjection: true,
  credential: true,
  sshBackdoor: true,
  invisibleUnicode: true
};
const limits = { user: 1375, agents: 800, memory: 2200 };

let root: string;
let backend: WritableMemoryFilesystemBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-writable-mem-'));
  const fs = new FilesystemBackend({ rootDir: root, virtualMode: true });
  backend = new WritableMemoryFilesystemBackend(
    fs,
    'abcdef0123456789',
    new SecurityScanService(allOn),
    new CapacityService(limits)
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('WritableMemoryFilesystemBackend', () => {
  it('writes /memory/global/MEMORY.md and persists on disk', async () => {
    const res = await backend.write('/memory/global/MEMORY.md', '# project facts\n- uses pnpm');

    expect(res.error).toBeUndefined();
    expect(readFileSync(join(root, 'global', 'MEMORY.md'), 'utf8')).toContain('uses pnpm');
  });

  it('accepts routed paths after CompositeBackend strips the /memory prefix', async () => {
    const res = await backend.write('/global/AGENTS.md', '# global rules');

    expect(res.error).toBeUndefined();
    expect(readFileSync(join(root, 'global', 'AGENTS.md'), 'utf8')).toBe('# global rules');
  });

  it('expands current alias to workspace hash', async () => {
    const res = await backend.write('/memory/workspaces/current/AGENTS.md', '# rules\n- be precise');

    expect(res.error).toBeUndefined();
    expect(existsSync(join(root, 'workspaces', 'abcdef0123456789', 'AGENTS.md'))).toBe(true);
  });

  it('rejects path outside whitelist', async () => {
    const res = await backend.write('/memory/global/notes.md', 'x');

    expect(res.error).toContain('whitelist');
  });

  it('rejects USER.md under workspaces', async () => {
    const res = await backend.write('/memory/workspaces/current/USER.md', 'x');

    expect(res.error).toContain('USER');
  });

  it('blocks credential pattern', async () => {
    const res = await backend.write('/memory/global/MEMORY.md', 'AKIAIOSFODNN7EXAMPLE');

    expect(res.error).toContain('security scan');
  });

  it('blocks capacity overflow', async () => {
    const big = 'x'.repeat(2300);
    const res = await backend.write('/memory/global/MEMORY.md', big);

    expect(res.error).toContain('capacity exceeded');
  });

  it('edit applies oldString to newString and re-scans final content', async () => {
    await backend.write('/memory/global/MEMORY.md', '# Notes\n- old fact');
    const res = await backend.edit('/memory/global/MEMORY.md', '- old fact', '- new fact');

    expect(res.error).toBeUndefined();
    expect(readFileSync(join(root, 'global', 'MEMORY.md'), 'utf8')).toContain('new fact');
  });

  it('rejects edit if final content fails security', async () => {
    await backend.write('/memory/global/MEMORY.md', '# notes');
    const res = await backend.edit('/memory/global/MEMORY.md', '# notes', '# notes\nAKIAIOSFODNN7EXAMPLE');

    expect(res.error).toContain('security scan');
  });

  it('passes reads through to the underlying filesystem backend', async () => {
    await backend.write('/memory/global/MEMORY.md', 'hello');
    const res = await backend.read('/memory/global/MEMORY.md');

    expect(res.error).toBeUndefined();
    if (typeof res.content !== 'string') {
      throw new Error('Expected text content from memory backend read.');
    }
    expect(res.content).toContain('hello');
  });

  it('rejects when no workspace selected for workspace path', async () => {
    const fs = new FilesystemBackend({ rootDir: root, virtualMode: true });
    const noWorkspace = new WritableMemoryFilesystemBackend(
      fs,
      null,
      new SecurityScanService(allOn),
      new CapacityService(limits)
    );
    const res = await noWorkspace.write('/memory/workspaces/current/MEMORY.md', 'x');

    expect(res.error).toContain('workspace');
  });

  it('returns official ExecuteResponse shape for unsupported commands', async () => {
    const res = await backend.execute('echo nope');

    expect(res).toEqual({
      output: 'Operation not supported on /memory/.',
      exitCode: 1,
      truncated: false
    });
  });
});
