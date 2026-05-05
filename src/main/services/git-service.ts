import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GitCommitResult, GitDiffStatResult, GitPushResult, GitStatusChange, GitStatusResult } from '../../shared/types';
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

  discardFileChanges(relativePath: string): GitStatusResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPath = this.normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    const currentStatus = this.getStatus();
    const change = currentStatus.changes.find((item) => item.relativePath === normalizedPath);
    if (change === undefined) {
      throw new RocDomainError({
        code: 'git_file_change_missing',
        message: '当前文件没有可回滚的 Git 变更。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在未提交变更的文件。'
      });
    }
    if (change.index !== ' ' && change.index !== '?') {
      this.runGit(workspace.path, ['restore', '--staged', '--worktree', '--', normalizedPath]);
      return this.getStatus();
    }
    if (change.worktree !== ' ' || change.index === '?') {
      this.runGit(workspace.path, ['restore', '--worktree', '--', normalizedPath]);
      return this.getStatus();
    }
    throw new RocDomainError({
      code: 'git_file_change_missing',
      message: '当前文件没有可回滚的 Git 变更。',
      category: 'not_found',
      retryable: false,
      userAction: '请选择一个存在未提交变更的文件。'
    });
  }

  commit(message: string): GitCommitResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedMessage = message.trim();
    if (normalizedMessage.length === 0) {
      throw new RocDomainError({
        code: 'git_commit_message_empty',
        message: '提交说明不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入本次提交的说明后再提交。'
      });
    }
    const before = this.getStatus();
    if (before.changedFiles === 0) {
      throw new RocDomainError({
        code: 'git_commit_no_changes',
        message: '当前没有可提交的变更。',
        category: 'conflict',
        retryable: false,
        userAction: '请先修改或暂存文件后再提交。'
      });
    }
    this.runGit(workspace.path, ['commit', '-m', normalizedMessage]);
    const commitSha = this.runGit(workspace.path, ['rev-parse', 'HEAD']).trim();
    return {
      workspacePath: workspace.path,
      commitMessage: normalizedMessage,
      commitSha,
      status: this.getStatus()
    };
  }

  push(): GitPushResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const branch = this.runGit(workspace.path, ['branch', '--show-current']).trim();
    const remoteName = this.readGitConfigValue(workspace.path, `branch.${branch}.remote`);
    if (remoteName.length === 0) {
      throw new RocDomainError({
        code: 'git_push_remote_missing',
        message: '当前分支没有配置远端。',
        category: 'not_found',
        retryable: false,
        userAction: '请先为当前分支配置远端后再 push。'
      });
    }
    const output = this.runGit(workspace.path, ['push']);
    return {
      workspacePath: workspace.path,
      remoteName,
      branch,
      status: this.getStatus(),
      output
    };
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
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      throw this.toGitCommandError(args, error);
    }
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

  private readGitConfigValue(cwd: string, key: string): string {
    try {
      return execFileSync('git', ['config', key], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    } catch {
      return '';
    }
  }

  private toGitCommandError(args: string[], error: unknown): RocDomainError {
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr.trim()
        : '';
    const stdout =
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout.trim()
        : '';
    const detail = stderr || stdout;
    const commandText = `git ${args.join(' ')}`;
    return new RocDomainError({
      code: 'git_command_failed',
      message: detail.length > 0 ? detail : `${commandText} 执行失败。`,
      category: 'external',
      retryable: false,
      userAction: '请检查 Git 仓库状态、远端配置或认证信息后重试。'
    });
  }
}
