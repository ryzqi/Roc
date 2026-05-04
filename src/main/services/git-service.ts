import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GitDiffStatResult, GitStatusChange, GitStatusResult } from '../../shared/types';
import { RocDomainError } from './errors';
import type { WorkspaceService } from './workspace-service';

export class GitService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  getStatus(): GitStatusResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const branch = this.runGit(workspace.path, ['branch', '--show-current']).trim();
    const porcelain = this.runGit(workspace.path, ['status', '--porcelain'])
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const changes = this.getStatusChanges(workspace.path);

    return {
      workspacePath: workspace.path,
      isRepository: true,
      branch,
      porcelain,
      changes,
      changedFiles: porcelain.length
    };
  }

  getDiffStat(): GitDiffStatResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    return {
      workspacePath: workspace.path,
      stat: this.runGit(workspace.path, ['diff', '--stat'])
    };
  }

  stageFile(relativePath: string): GitStatusResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPath = this.normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    this.runGit(workspace.path, ['add', '--', normalizedPath]);
    return this.getStatus();
  }

  unstageFile(relativePath: string): GitStatusResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPath = this.normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    this.runGit(workspace.path, ['restore', '--staged', '--', normalizedPath]);
    return this.getStatus();
  }

  private ensureGitRepository(workspacePath: string): void {
    if (!existsSync(join(workspacePath, '.git'))) {
      throw new RocDomainError({
        code: 'git_repository_missing',
        message: '当前工作区不是 Git 仓库。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个 Git 仓库工作区，或在外部初始化仓库后重试。'
      });
    }
  }

  private runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    });
  }

  private getStatusChanges(cwd: string): GitStatusChange[] {
    const rawStatus = this.runGit(cwd, ['status', '--porcelain=v1', '-z']);
    const records = rawStatus.split('\0').filter((record) => record.length > 0);
    const changes: GitStatusChange[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const statusIndex = record.charAt(0);
      const statusWorktree = record.charAt(1);
      const relativePath = record.slice(3);
      const originalPath = statusIndex === 'R' || statusIndex === 'C' ? records[index + 1] : undefined;
      changes.push({
        porcelain:
          originalPath === undefined
            ? `${statusIndex}${statusWorktree} ${relativePath}`
            : `${statusIndex}${statusWorktree} ${originalPath} -> ${relativePath}`,
        index: statusIndex,
        worktree: statusWorktree,
        relativePath,
        originalPath
      });
      if (originalPath !== undefined) {
        index += 1;
      }
    }

    return changes;
  }

  private normalizeGitPath(relativePath: string): string {
    const normalizedPath = relativePath.trim().replaceAll('\\', '/');
    if (normalizedPath.length === 0 || normalizedPath === '.') {
      throw new RocDomainError({
        code: 'git_file_path_empty',
        message: 'Git 文件路径不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请选择一个具体文件后再执行 Git 操作。'
      });
    }
    const pathParts = normalizedPath.split('/');
    if (isAbsolute(normalizedPath) || pathParts.includes('..')) {
      throw new RocDomainError({
        code: 'git_file_path_outside_workspace',
        message: 'Git 文件路径必须在当前工作区内。',
        category: 'permission',
        retryable: false,
        userAction: '请选择当前工作区内的文件。'
      });
    }
    return normalizedPath;
  }
}
