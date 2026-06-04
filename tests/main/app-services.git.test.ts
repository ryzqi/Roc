import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RocDomainError, wrapIpc } from '../../src/main/services/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupAppServicesTest, initializeAppServicesTest, normalizeLineEndings, startFakeProvider, type AppServicesTestContext } from './app-service-fixtures';


describe('Roc foundation services git', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(async () => {
    await cleanupAppServicesTest(context);
  });

  it('selects a real workspace and keeps the app status bound to the same path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      const workspace = context.services.workspaceService.selectWorkspace(workspaceRoot);
      const current = context.services.workspaceService.getCurrentWorkspace();
      const status = context.services.appService.getStatus();

      expect(workspace.path).toBe(workspaceRoot);
      expect(workspace.displayName).toBe(workspaceRoot.split(/[\\/]/).pop());
      expect(workspace.trustState).toBe('trusted');
      expect(current?.path).toBe(workspaceRoot);
      expect(status.workspace).toEqual({
        selectedPath: workspaceRoot,
        label: workspaceRoot
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists, searches, previews, and writes workspace files with recovery points', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      mkdirSync(join(workspaceRoot, 'src'));
      mkdirSync(join(workspaceRoot, 'assets'));
      writeFileSync(join(workspaceRoot, 'src', 'notes.md'), 'alpha\nphase three boundary\n', 'utf8');
      writeFileSync(
        join(workspaceRoot, 'assets', 'pixel.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
          'base64'
        )
      );
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const tree = context.services.fileService.listTree({ relativePath: '' });
      const search = context.services.fileService.search({ query: 'phase three' });
      const preview = context.services.fileService.readPreview({ relativePath: 'src/notes.md' });
      const imagePreview = context.services.fileService.readPreview({ relativePath: 'assets/pixel.png' });
      const writeResult = context.services.fileService.writeTextFile({
        relativePath: 'src/notes.md',
        content: 'updated phase three boundary\n',
        source: 'test'
      });
      const recoverySnapshot = readFileSync(writeResult.recoveryPoint.snapshotPath, 'utf8');
      const updatedContent = readFileSync(join(workspaceRoot, 'src', 'notes.md'), 'utf8');

      expect(tree.entries).toContainEqual(
        expect.objectContaining({
          name: 'src',
          relativePath: 'src',
          type: 'directory'
        })
      );
      expect(search.matches).toEqual([
        expect.objectContaining({
          relativePath: 'src/notes.md',
          line: 2,
          preview: 'phase three boundary'
        })
      ]);
      expect(preview).toMatchObject({
        relativePath: 'src/notes.md',
        kind: 'text',
        truncated: false,
        content: 'alpha\nphase three boundary\n'
      });
      expect(imagePreview.kind).toBe('image');
      expect(imagePreview.mediaType).toBe('image/png');
      expect(imagePreview.content.startsWith('data:image/png;base64,')).toBe(true);
      expect(imagePreview.sizeBytes).toBeGreaterThan(0);
      expect(writeResult.recoveryPoint.relativePath).toBe('src/notes.md');
      expect(recoverySnapshot).toBe('alpha\nphase three boundary\n');
      expect(updatedContent).toBe('updated phase three boundary\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('provides async git status and branch reads for IPC-visible workbench refreshes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-async-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const [status, branches, diffStat] = await Promise.all([
        context.services.gitService.getStatusAsync(),
        context.services.gitService.listBranchesAsync(),
        context.services.gitService.getDiffStatAsync()
      ]);

      expect(status).toMatchObject({
        workspacePath: workspaceRoot,
        isRepository: true,
        changedFiles: 1
      });
      expect(status.porcelain).toContain(' M notes.txt');
      expect(branches.currentBranch).toBe(status.branch);
      expect(branches.branches).toContainEqual(
        expect.objectContaining({
          name: status.branch,
          current: true
        })
      );
      expect(diffStat.stat).toContain('notes.txt');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured workspace and git errors instead of implicit fallbacks', async () => {
    const missingWorkspace = await wrapIpc(() => context.services.workspaceService.selectWorkspace(join(context.root, 'missing')));
    expect(missingWorkspace).toEqual({
      ok: false,
      error: {
        code: 'workspace_path_missing',
        message: '工作区路径不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在的目录作为工作区。'
      }
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);
      const gitStatus = await wrapIpc(() => context.services.gitService.getStatus());

      expect(gitStatus).toEqual({
        ok: false,
        error: {
          code: 'git_repository_missing',
          message: '当前工作区不是 Git 仓库。',
          category: 'not_found',
          retryable: false,
          userAction: '请选择一个 Git 仓库工作区，或在外部初始化仓库后重试。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('stages and unstages a changed workspace file through GitService', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const before = context.services.gitService.getStatus();
      const staged = context.services.gitService.stageFile('notes.txt');
      const unstaged = context.services.gitService.unstageFile('notes.txt');

      expect(before.porcelain).toContain(' M notes.txt');
      expect(staged.porcelain).toContain('M  notes.txt');
      expect(unstaged.porcelain).toContain(' M notes.txt');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('stages multiple changed workspace files through GitService', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-stage-files-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      writeFileSync(join(workspaceRoot, 'todo.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt', 'todo.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed notes\n', 'utf8');
      writeFileSync(join(workspaceRoot, 'todo.txt'), 'changed todo\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const staged = context.services.gitService.stageFiles(['notes.txt', 'todo.txt']);

      expect(staged.porcelain).toContain('M  notes.txt');
      expect(staged.porcelain).toContain('M  todo.txt');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns unified diff text for a selected changed Git file', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-diff-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const diff = context.services.gitService.getFileDiff('notes.txt');

      expect(diff).toMatchObject({
        workspacePath: workspaceRoot,
        relativePath: 'notes.txt'
      });
      expect(normalizeLineEndings(diff.patch)).toContain('diff --git a/notes.txt b/notes.txt');
      expect(normalizeLineEndings(diff.patch)).toContain('-initial');
      expect(normalizeLineEndings(diff.patch)).toContain('+changed');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports changed Git files with unquoted operation paths', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-space-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'space name.txt'), 'initial\n', 'utf8');
      runGit(['add', 'space name.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'space name.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const before = context.services.gitService.getStatus();
      const changes = (before as { changes?: Array<{ relativePath: string }> }).changes;

      expect(before.porcelain).toContain(' M "space name.txt"');
      expect(changes).toEqual([
        expect.objectContaining({
          relativePath: 'space name.txt'
        })
      ]);
      const staged = context.services.gitService.stageFile(changes![0].relativePath);
      expect(staged.porcelain).toContain('M  "space name.txt"');
      const unstaged = context.services.gitService.unstageFile(changes![0].relativePath);
      expect(unstaged.porcelain).toContain(' M "space name.txt"');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports renamed Git files with the new operation path and original path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-rename-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'old name.txt'), 'initial\n', 'utf8');
      runGit(['add', 'old name.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['mv', 'old name.txt', 'new name.txt']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const before = context.services.gitService.getStatus();

      expect(before.porcelain).toContain('R  "old name.txt" -> "new name.txt"');
      expect(before.changes).toEqual([
        expect.objectContaining({
          index: 'R',
          worktree: ' ',
          originalPath: 'old name.txt',
          relativePath: 'new name.txt'
        })
      ]);
      const unstaged = context.services.gitService.unstageFile(before.changes[0].relativePath);
      expect(unstaged.porcelain).toContain('D  "old name.txt"');
      expect(unstaged.porcelain).toContain('?? "new name.txt"');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects Git file operations outside the selected workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-boundary-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => context.services.gitService.stageFile('../outside.txt')).toThrow(RocDomainError);
      expect(() => context.services.gitService.stageFile('nested/../outside.txt')).toThrow('Git 文件路径必须在当前工作区内。');
      expect(() => context.services.gitService.stageFiles([])).toThrow('批量暂存至少需要一个文件路径。');
      expect(() => context.services.gitService.stageFiles(['../outside.txt'])).toThrow('Git 文件路径必须在当前工作区内。');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('commits staged changes and returns clean status', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-commit-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      context.services.gitService.stageFile('notes.txt');
      const committed = context.services.gitService.commit('update notes');

      expect(committed.commitMessage).toBe('update notes');
      expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(committed.status.changedFiles).toBe(0);
      expect(committed.status.porcelain).toEqual([]);
      expect(runGit(['log', '-1', '--pretty=%s']).trim()).toBe('update notes');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails commit with empty message', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-commit-empty-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => context.services.gitService.commit('   ')).toThrow('提交说明不能为空。');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discards worktree-only file changes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-worktree-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const discarded = context.services.gitService.discardFileChanges('notes.txt');

      expect(discarded.porcelain).toEqual([]);
      expect(normalizeLineEndings(readFileSync(join(workspaceRoot, 'notes.txt'), 'utf8'))).toBe('initial\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discards staged and worktree file changes together', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-staged-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed once\n', 'utf8');
      runGit(['add', 'notes.txt']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed twice\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const discarded = context.services.gitService.discardFileChanges('notes.txt');

      expect(discarded.porcelain).toEqual([]);
      expect(normalizeLineEndings(readFileSync(join(workspaceRoot, 'notes.txt'), 'utf8'))).toBe('initial\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects Git discard outside the selected workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-boundary-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => context.services.gitService.discardFileChanges('../outside.txt')).toThrow(RocDomainError);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured git push errors when no remote is configured', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-push-missing-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const pushResult = await wrapIpc(() => context.services.gitService.push());

      expect(pushResult).toEqual({
        ok: false,
        error: {
          code: 'git_push_remote_missing',
          message: '当前分支没有配置远端。',
          category: 'not_found',
          retryable: false,
          userAction: '请先为当前分支配置远端后再 push。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists local branches and marks the current branch', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branches-list-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/git-workbench']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const branchInfo = context.services.gitService.listBranches();

      expect(branchInfo.currentBranch.length).toBeGreaterThan(0);
      expect(branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: branchInfo.currentBranch,
          current: true
        })
      );
      expect(branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: 'feature/git-workbench',
          current: false
        })
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('creates a local branch and optionally checks it out', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-create-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const created = context.services.gitService.createBranch('feature/batch-stage', true);

      expect(created.branchInfo.currentBranch).toBe('feature/batch-stage');
      expect(created.branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: 'feature/batch-stage',
          current: true
        })
      );
      expect(created.status.branch).toBe('feature/batch-stage');
      expect(runGit(['branch', '--show-current']).trim()).toBe('feature/batch-stage');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('checks out an existing local branch', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-checkout-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/switch-target']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const switched = context.services.gitService.checkoutBranch('feature/switch-target');

      expect(switched.branchInfo.currentBranch).toBe('feature/switch-target');
      expect(switched.status.branch).toBe('feature/switch-target');
      expect(runGit(['branch', '--show-current']).trim()).toBe('feature/switch-target');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails to create a branch when the local branch already exists', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-duplicate-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/existing']);
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => context.services.gitService.createBranch('feature/existing', false)).toThrow(RocDomainError);
      expect(() => context.services.gitService.createBranch('feature/existing', false)).toThrow(/already exists|已存在/u);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs only low-risk workspace commands and records agent command events', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'terminal output\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);
      const task = context.services.taskService.createTaskRun({
        userInput: '读取工作区文件',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      context.services.taskService.markRunRunning(task.id);

      const commandResult = context.services.shellExecutionService.executeAgentCommand({
        command: 'dir',
        cwd: workspaceRoot,
        threadId: task.threadId,
        runId: task.id
      });
      const blockedResult = context.services.shellExecutionService.evaluate({
        command: 'Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const snapshot = context.services.taskService.getSnapshot();

      expect(commandResult).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        truncated: false,
        usedRtk: false,
        bypassReason: 'command_not_supported'
      });
      expect(commandResult.output).toContain('notes.txt');
      expect(blockedResult).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'remove-item notes.txt'
      });
      expect(snapshot.recentEvents.some((event) => event.type === 'agent_execute')).toBe(true);
      expect(snapshot.recentEvents.some((event) => event.type === 'agent_update')).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses bundled rtk for allowed agent commands', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);
      writeFileSync(join(workspaceRoot, '.git'), '', 'utf8');
      const task = context.services.taskService.createTaskRun({
        userInput: '检查 git 状态',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      context.services.taskService.markRunRunning(task.id);
      const shellExecutionServiceForTest = context.services.shellExecutionService as unknown as {
        execFile: unknown;
      };
      const originalExecFile = shellExecutionServiceForTest.execFile;
      (context.services.shellExecutionService as unknown as {
        execFile: (
          file: string,
          args: string[],
          cwd: string,
          extraEnv?: Record<string, string>
        ) => { stdout: string; stderr: string; exitCode: number };
      }).execFile = (file, args, execCwd, extraEnv = {}) => {
        if (String(file).endsWith('rtk.exe')) {
          expect(args).toEqual(['git', 'status']);
          expect(execCwd).toBe(workspaceRoot);
          expect(extraEnv.RTK_DB_PATH).toBe(join(context.root, 'rtk', 'history.db'));
          expect(extraEnv.RTK_TEE_DIR).toBe(join(context.root, 'rtk', 'tee'));
          return {
            stdout: 'On branch main',
            stderr: '',
            exitCode: 0
          };
        }
        throw new Error(`unexpected command: ${String(file)}`);
      };

      const result = context.services.shellExecutionService.executeAgentCommand({
        command: 'git status',
        cwd: workspaceRoot,
        threadId: task.threadId,
        runId: task.id
      });

      expect(result.usedRtk).toBe(true);
      expect(result.bypassReason).toBeUndefined();
      expect(result.output).toBe('On branch main');
      shellExecutionServiceForTest.execFile = originalExecFile;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses bundled rtk for commands already rewritten by middleware', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);
      const shellExecutionServiceForTest = context.services.shellExecutionService as unknown as {
        execFile: unknown;
      };
      const originalExecFile = shellExecutionServiceForTest.execFile;
      (context.services.shellExecutionService as unknown as {
        execFile: (
          file: string,
          args: string[],
          cwd: string,
          extraEnv?: Record<string, string>
        ) => { stdout: string; stderr: string; exitCode: number };
      }).execFile = (file, args, execCwd) => {
        if (String(file).endsWith('rtk.exe')) {
          expect(args).toEqual(['git', 'status']);
          expect(execCwd).toBe(workspaceRoot);
          return {
            stdout: 'On branch main',
            stderr: '',
            exitCode: 0
          };
        }
        throw new Error(`unexpected command: ${String(file)}`);
      };

      const result = context.services.shellExecutionService.executeAgentCommand({
        command: 'rtk git status',
        cwd: workspaceRoot
      });

      expect(result.usedRtk).toBe(true);
      expect(result.bypassReason).toBeUndefined();
      expect(result.output).toBe('On branch main');
      shellExecutionServiceForTest.execFile = originalExecFile;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks unsupported high-risk agent commands instead of falling back to raw shell execution', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'do not delete\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() =>
        context.services.shellExecutionService.executeAgentCommand({
          command: 'Remove-Item notes.txt',
          cwd: workspaceRoot
        })
      ).toThrow(RocDomainError);
      expect(readFileSync(join(workspaceRoot, 'notes.txt'), 'utf8')).toBe('do not delete\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns UTF-8 shell output for Chinese workspace filenames', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, '记忆系统.md'), '# 记忆系统\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const result = context.services.shellExecutionService.execute({
        command: 'dir',
        cwd: workspaceRoot,
        source: 'terminal'
      });

      expect(result).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        usedRtk: false,
        bypassReason: 'user_terminal_raw_output'
      });
      expect(result.stdout).toContain('记忆系统.md');
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs shell commands asynchronously for IPC-visible terminal execution', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-shell-async-'));
    try {
      writeFileSync(join(workspaceRoot, '记忆系统.md'), '# 记忆系统\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const result = await context.services.shellExecutionService.executeAsync({
        command: 'dir',
        cwd: workspaceRoot,
        source: 'terminal'
      });

      expect(result).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        usedRtk: false,
        bypassReason: 'user_terminal_raw_output'
      });
      expect(result.stdout).toContain('记忆系统.md');
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs allowed agent commands asynchronously and records agent execution events', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-agent-shell-async-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'terminal output\n', 'utf8');
      context.services.workspaceService.selectWorkspace(workspaceRoot);
      const task = context.services.taskService.createTaskRun({
        userInput: '读取工作区文件',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      context.services.taskService.markRunRunning(task.id);

      const commandResult = await context.services.shellExecutionService.executeAgentCommandAsync({
        command: 'dir',
        cwd: workspaceRoot,
        threadId: task.threadId,
        runId: task.id
      });
      const snapshot = context.services.taskService.getSnapshot();

      expect(commandResult).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        truncated: false,
        usedRtk: false,
        bypassReason: 'command_not_supported'
      });
      expect(commandResult.output).toContain('notes.txt');
      expect(snapshot.recentEvents.some((event) => event.type === 'agent_execute')).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks compound shell commands even when they start with a read-only command', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const pipedRemoval = context.services.shellExecutionService.evaluate({
        command: 'dir | Remove-Item -Recurse',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const chainedRemoval = context.services.shellExecutionService.evaluate({
        command: 'dir; Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(pipedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir | remove-item -recurse'
      });
      expect(chainedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir; remove-item notes.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns a permission error when executing a high-risk shell command through IPC boundary', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const result = await wrapIpc(() =>
        context.services.shellExecutionService.execute({
          command: 'Remove-Item notes.txt',
          cwd: workspaceRoot,
          source: 'agent'
        })
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'command_requires_confirmation',
          message: '命令需要确认，未执行。',
          category: 'permission',
          retryable: false,
          userAction: '请在任务确认卡片中查看命令、作用目录和风险原因后再决定是否执行。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks shell redirection because it can write workspace files', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      context.services.workspaceService.selectWorkspace(workspaceRoot);

      const redirectedListing = context.services.shellExecutionService.evaluate({
        command: 'dir > created-by-redirection.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(redirectedListing).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir > created-by-redirection.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports RTK resources as ready when the bundled binary is present', () => {
    const status = context.services.rtkService.getStatus();

    expect(status).toMatchObject({
      enabledForAgentCommands: true,
      binaryPath: expect.stringContaining(join('resources', 'rtk-binaries')),
      configPath: join(context.root, 'rtk', 'config.toml'),
      teeDir: join(context.root, 'rtk', 'tee'),
      resourceState: 'ready'
    });
    expect(status.bypassReason).toBeUndefined();
  });

  it('keeps unexpected IPC errors sanitized while preserving domain errors', async () => {
    const domainResult = await wrapIpc(() => {
      throw new RocDomainError({
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      });
    });

    const unexpectedResult = await wrapIpc(() => {
      throw new Error('SQLITE_CANTOPEN: C:\\Users\\任彦舟\\.roc\\roc.sqlite');
    });

    expect(domainResult).toEqual({
      ok: false,
      error: {
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      }
    });
    expect(unexpectedResult).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Roc 内部错误，已记录到本地日志。',
        category: 'internal',
        retryable: false,
        userAction: '请查看 Roc 日志后重试。'
      }
    });
  });
});
