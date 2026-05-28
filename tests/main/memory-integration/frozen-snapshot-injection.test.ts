import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-snapshot-int-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MemoryService.buildSnapshotForCurrentWorkspace', () => {
  it('builds a frozen snapshot from current global and workspace memory files', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-snapshot-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const userWrite = services.memoryService.writeFile({
        scope: 'global',
        kind: 'user',
        content: '# 用户：偏好直接简短风格'
      });
      const workspaceWrite = services.memoryService.writeFile({
        scope: 'workspace',
        kind: 'memory',
        content: 'project facts from current workspace'
      });

      expect(userWrite.ok).toBe(true);
      expect(workspaceWrite.ok).toBe(true);

      const snapshot = services.memoryService.buildSnapshotForCurrentWorkspace();

      expect(snapshot.user.content).toContain('偏好直接简短风格');
      expect(snapshot.user.source).toBe('global');
      expect(snapshot.memory.content).toBe('project facts from current workspace');
      expect(snapshot.memory.source).toBe('workspace');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
