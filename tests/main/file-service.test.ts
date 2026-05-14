import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-file-service-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('FileService.deleteFile', () => {
  it('deletes a workspace file and records a recovery point', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-file-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.md'), 'before delete\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const result = services.fileService.deleteFile('notes.md');
      const recoverySnapshot = readFileSync(result.recoveryPoint.snapshotPath, 'utf8');
      const row = services.databaseService.db
        .prepare('SELECT relative_path, source FROM recovery_points WHERE id = ?')
        .get(result.recoveryPoint.id) as { relative_path: string; source: string } | undefined;

      expect(existsSync(join(workspaceRoot, 'notes.md'))).toBe(false);
      expect(result.relativePath).toBe('notes.md');
      expect(result.recoveryPoint.source).toBe('agent.delete_file');
      expect(recoverySnapshot).toBe('before delete\n');
      expect(row).toEqual({
        relative_path: 'notes.md',
        source: 'agent.delete_file'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects missing targets with delete_file_target_missing', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-file-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      expect(() => services.fileService.deleteFile('missing.md')).toThrowError(
        expect.objectContaining({
          code: 'delete_file_target_missing'
        } satisfies Partial<RocDomainError>)
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-empty directories with delete_file_target_not_empty', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-file-workspace-'));
    try {
      mkdirSync(join(workspaceRoot, 'docs'));
      writeFileSync(join(workspaceRoot, 'docs', 'guide.md'), 'content\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => services.fileService.deleteFile('docs')).toThrowError(
        expect.objectContaining({
          code: 'delete_file_target_not_empty'
        } satisfies Partial<RocDomainError>)
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-file-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      expect(() => services.fileService.deleteFile('../outside.txt')).toThrowError(
        expect.objectContaining({
          code: 'workspace_path_outside'
        } satisfies Partial<RocDomainError>)
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
