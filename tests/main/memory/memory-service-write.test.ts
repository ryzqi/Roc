import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-memory-write-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('MemoryService.writeFile', () => {
  it('rejects workspace-scoped USER.md as an invalid path', () => {
    const result = services.memoryService.writeFile({
      scope: 'workspace',
      kind: 'user',
      content: 'workspace user memory'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_path');
      expect(result.detail).toContain('USER.md lives only at /memory/global/USER.md');
    }
  });

  it('writes a fresh global USER.md', () => {
    const result = services.memoryService.writeFile({
      scope: 'global',
      kind: 'user',
      content: '# 用户偏好\n- 语言：中文'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const onDisk = readFileSync(result.meta.absolutePath, 'utf8');
      expect(onDisk).toContain('用户偏好');
    }
  });

  it('rejects capacity overflow', () => {
    const big = 'x'.repeat(1500);
    const result = services.memoryService.writeFile({
      scope: 'global',
      kind: 'user',
      content: big
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded');
      expect(result.chars).toBe(1500);
      expect(result.limit).toBe(1375);
    }
  });

  it('schedules consolidation on overflow for an existing file', () => {
    const scheduleForFile = vi.spyOn(services.consolidatorService, 'scheduleForFile').mockImplementation(() => undefined);
    const first = services.memoryService.writeFile({
      scope: 'global',
      kind: 'user',
      content: 'initial small content'
    });
    expect(first.ok).toBe(true);

    const result = services.memoryService.writeFile({
      scope: 'global',
      kind: 'user',
      content: 'x'.repeat(1500)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded');
    }
    expect(scheduleForFile).toHaveBeenCalledWith(expect.stringContaining('USER.md'), 'user');
  });

  it('rejects credential pattern', () => {
    const result = services.memoryService.writeFile({
      scope: 'global',
      kind: 'memory',
      content: 'aws key: AKIAIOSFODNN7EXAMPLE'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('security_scan');
      expect(result.issues?.some((issue) => issue.category === 'credential')).toBe(true);
    }
  });

  it('rejects workspace scope when no workspace selected', () => {
    const result = services.memoryService.writeFile({
      scope: 'workspace',
      kind: 'memory',
      content: 'project memory'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_required');
    }
  });
});

describe('MemoryService.writeFileAsync', () => {
  it('writes a fresh global USER.md without using the synchronous API', async () => {
    const result = await services.memoryService.writeFileAsync({
      scope: 'global',
      kind: 'user',
      content: '# 用户偏好\n- 语言：中文'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const onDisk = readFileSync(result.meta.absolutePath, 'utf8');
      expect(onDisk).toContain('用户偏好');
    }
  });

  it('rejects capacity overflow while preserving consolidation scheduling', async () => {
    const scheduleForFile = vi.spyOn(services.consolidatorService, 'scheduleForFile').mockImplementation(() => undefined);
    const first = await services.memoryService.writeFileAsync({
      scope: 'global',
      kind: 'memory',
      content: 'initial small content'
    });
    expect(first.ok).toBe(true);

    const result = await services.memoryService.writeFileAsync({
      scope: 'global',
      kind: 'memory',
      content: 'x'.repeat(2300)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded');
      expect(result.chars).toBe(2300);
      expect(result.limit).toBe(2200);
    }
    expect(scheduleForFile).toHaveBeenCalledWith(expect.stringContaining('MEMORY.md'), 'memory');
  });
});

describe('MemoryService.readFile', () => {
  it('returns null for non-existent file', () => {
    expect(services.memoryService.readFile({ scope: 'global', kind: 'user' })).toBeNull();
  });

  it('reads back what was written', () => {
    services.memoryService.writeFile({ scope: 'global', kind: 'user', content: 'hello' });
    expect(services.memoryService.readFile({ scope: 'global', kind: 'user' })).toBe('hello');
  });
});

describe('MemoryService.readFileAsync', () => {
  it('returns null for non-existent file', async () => {
    await expect(services.memoryService.readFileAsync({ scope: 'global', kind: 'user' })).resolves.toBeNull();
  });

  it('reads back what was written asynchronously', async () => {
    await services.memoryService.writeFileAsync({ scope: 'global', kind: 'user', content: 'hello' });
    await expect(services.memoryService.readFileAsync({ scope: 'global', kind: 'user' })).resolves.toBe('hello');
  });

  it('writes different memory files concurrently', async () => {
    const writes = [
      { scope: 'global' as const, kind: 'user' as const, content: 'concurrent user' },
      { scope: 'global' as const, kind: 'agents' as const, content: 'concurrent agents' },
      { scope: 'global' as const, kind: 'memory' as const, content: 'concurrent memory' }
    ];

    const results = await Promise.all(writes.map((write) => services.memoryService.writeFileAsync(write)));

    expect(results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true })
    ]);
    await expect(services.memoryService.readFileAsync({ scope: 'global', kind: 'user' })).resolves.toBe('concurrent user');
    await expect(services.memoryService.readFileAsync({ scope: 'global', kind: 'agents' })).resolves.toBe(
      'concurrent agents'
    );
    await expect(services.memoryService.readFileAsync({ scope: 'global', kind: 'memory' })).resolves.toBe(
      'concurrent memory'
    );
  });
});

describe('MemoryService.status (Phase 2 shape)', () => {
  it('lists 5 file slots with metadata', () => {
    const status = services.memoryService.status();
    expect(status.files).toHaveLength(5);
    expect(status.files.map((file) => `${file.scope}/${file.kind}`)).toEqual([
      'global/user',
      'global/agents',
      'global/memory',
      'workspace/agents',
      'workspace/memory'
    ]);
  });
});
