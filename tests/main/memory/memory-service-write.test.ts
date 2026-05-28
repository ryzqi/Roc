import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-memory-write-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MemoryService.writeFile', () => {
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

describe('MemoryService.readFile', () => {
  it('returns null for non-existent file', () => {
    expect(services.memoryService.readFile({ scope: 'global', kind: 'user' })).toBeNull();
  });

  it('reads back what was written', () => {
    services.memoryService.writeFile({ scope: 'global', kind: 'user', content: 'hello' });
    expect(services.memoryService.readFile({ scope: 'global', kind: 'user' })).toBe('hello');
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
