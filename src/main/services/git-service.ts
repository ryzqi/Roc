import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  GitBranchListResult,
  GitBranchMutationResult,
  GitBranchSummary,
  GitCommitResult,
  GitDiffStatResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusChange,
  GitStatusResult
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { WorkspaceService } from './workspace-service';

export class GitService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  async getStatusAsync(): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const [branchOutput, porcelainOutput, changes] = await Promise.all([
      this.runGitAsync(workspace.path, ['branch', '--show-current']),
      this.runGitAsync(workspace.path, ['status', '--porcelain']),
      this.getStatusChangesAsync(workspace.path)
    ]);
    const porcelain = porcelainOutput
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    return {
      workspacePath: workspace.path,
      isRepository: true,
      branch: branchOutput.trim(),
      porcelain,
      changes,
      changedFiles: porcelain.length
    };
  }

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

  async getDiffStatAsync(): Promise<GitDiffStatResult> {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    return {
      workspacePath: workspace.path,
      stat: await this.runGitAsync(workspace.path, ['diff', '--stat'])
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

  async getFileDiffAsync(relativePath: string): Promise<GitFileDiffResult> {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPath = this.normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    const change = (await this.getStatusChangesAsync(workspace.path)).find((item) => item.relativePath === normalizedPath);
    if (change === undefined) {
      throw new RocDomainError({
        code: 'git_file_change_missing',
        message: '当前文件没有可预览的 Git 变更。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在未提交变更的文件。'
      });
    }
    const patch =
      change.index === '?'
        ? await this.runGitAllowingDiffExitCodeAsync(workspace.path, ['diff', '--no-index', '--unified=1', '--', '/dev/null', normalizedPath])
        : change.index !== ' ' && change.worktree === ' '
          ? await this.runGitAsync(workspace.path, ['diff', '--cached', '--find-renames', '--unified=1', '--', normalizedPath])
          : await this.runGitAsync(workspace.path, ['diff', '--find-renames', '--unified=1', '--', normalizedPath]);

    return {
      workspacePath: workspace.path,
      relativePath: normalizedPath,
      patch
    };
  }

  getFileDiff(relativePath: string): GitFileDiffResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPath = this.normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    const change = this.getStatusChanges(workspace.path).find((item) => item.relativePath === normalizedPath);
    if (change === undefined) {
      throw new RocDomainError({
        code: 'git_file_change_missing',
        message: '当前文件没有可预览的 Git 变更。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在未提交变更的文件。'
      });
    }
    const patch =
      change.index === '?'
        ? this.runGitAllowingDiffExitCode(workspace.path, ['diff', '--no-index', '--unified=1', '--', '/dev/null', normalizedPath])
        : change.index !== ' ' && change.worktree === ' '
          ? this.runGit(workspace.path, ['diff', '--cached', '--find-renames', '--unified=1', '--', normalizedPath])
          : this.runGit(workspace.path, ['diff', '--find-renames', '--unified=1', '--', normalizedPath]);

    return {
      workspacePath: workspace.path,
      relativePath: normalizedPath,
      patch
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

  stageFiles(relativePaths: string[]): GitStatusResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedPaths = this.normalizeGitPaths(relativePaths);
    for (const normalizedPath of normalizedPaths) {
      this.workspaceService.resolveInsideWorkspace(normalizedPath);
    }
    this.runGit(workspace.path, ['add', '--', ...normalizedPaths]);
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

  listBranches(): GitBranchListResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    return this.readBranchList(workspace.path);
  }

  async listBranchesAsync(): Promise<GitBranchListResult> {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    return await this.readBranchListAsync(workspace.path);
  }

  createBranch(name: string, checkoutAfterCreate: boolean): GitBranchMutationResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedBranchName = this.normalizeBranchName(name);
    this.runGit(workspace.path, ['branch', '--list', normalizedBranchName]);
    this.runGit(workspace.path, ['branch', normalizedBranchName]);
    if (checkoutAfterCreate) {
      this.runGit(workspace.path, ['checkout', normalizedBranchName]);
    }
    return {
      workspacePath: workspace.path,
      branchInfo: this.readBranchList(workspace.path),
      status: this.getStatus()
    };
  }

  checkoutBranch(name: string): GitBranchMutationResult {
    const workspace = this.workspaceService.requireWorkspace();
    this.ensureGitRepository(workspace.path);
    const normalizedBranchName = this.normalizeBranchName(name);
    const branchInfo = this.readBranchList(workspace.path);
    if (!branchInfo.branches.some((branch) => branch.name === normalizedBranchName)) {
      throw new RocDomainError({
        code: 'git_branch_missing',
        message: `本地分支不存在：${normalizedBranchName}`,
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个已存在的本地分支，或先新建分支。'
      });
    }
    this.runGit(workspace.path, ['checkout', normalizedBranchName]);
    return {
      workspacePath: workspace.path,
      branchInfo: this.readBranchList(workspace.path),
      status: this.getStatus()
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

  private async runGitAsync(cwd: string, args: string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(this.toGitCommandError(args, { ...error, stdout, stderr }));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });
  }

  private runGitAllowingDiffExitCode(cwd: string, args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      if (this.isGitDiffExitCodeOne(error)) {
        return error.stdout;
      }
      throw this.toGitCommandError(args, error);
    }
  }

  private async runGitAllowingDiffExitCodeAsync(cwd: string, args: string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout.toString());
            return;
          }
          const failed = { ...error, stdout: stdout.toString(), stderr: stderr.toString(), status: error.code };
          if (this.isGitDiffExitCodeOne(failed)) {
            resolve(failed.stdout);
            return;
          }
          reject(this.toGitCommandError(args, failed));
        }
      );
    });
  }

  private isGitDiffExitCodeOne(error: unknown): error is { status: number; stdout: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 1 &&
      'stdout' in error &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
    );
  }

  private getStatusChanges(cwd: string): GitStatusChange[] {
    const rawStatus = this.runGit(cwd, ['status', '--porcelain=v1', '-z']);
    return this.parseStatusChanges(rawStatus);
  }

  private async getStatusChangesAsync(cwd: string): Promise<GitStatusChange[]> {
    const rawStatus = await this.runGitAsync(cwd, ['status', '--porcelain=v1', '-z']);
    return this.parseStatusChanges(rawStatus);
  }

  private parseStatusChanges(rawStatus: string): GitStatusChange[] {
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

  private readBranchList(cwd: string): GitBranchListResult {
    const currentBranch = this.runGit(cwd, ['branch', '--show-current']).trim();
    const branchLines = this.runGit(cwd, ['branch', '--format=%(refname:short)'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const branches: GitBranchSummary[] = branchLines.map((name) => ({
      name,
      current: name === currentBranch
    }));
    return {
      workspacePath: cwd,
      currentBranch,
      branches
    };
  }

  private async readBranchListAsync(cwd: string): Promise<GitBranchListResult> {
    const [currentBranchOutput, branchOutput] = await Promise.all([
      this.runGitAsync(cwd, ['branch', '--show-current']),
      this.runGitAsync(cwd, ['branch', '--format=%(refname:short)'])
    ]);
    const currentBranch = currentBranchOutput.trim();
    const branchLines = branchOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const branches: GitBranchSummary[] = branchLines.map((name) => ({
      name,
      current: name === currentBranch
    }));
    return {
      workspacePath: cwd,
      currentBranch,
      branches
    };
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

  private normalizeGitPaths(relativePaths: string[]): string[] {
    if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
      throw new RocDomainError({
        code: 'git_file_paths_empty',
        message: '批量暂存至少需要一个文件路径。',
        category: 'validation',
        retryable: true,
        userAction: '请先选择至少一个变更文件后再执行批量暂存。'
      });
    }
    return relativePaths.map((relativePath) => this.normalizeGitPath(relativePath));
  }

  private normalizeBranchName(name: string): string {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new RocDomainError({
        code: 'git_branch_name_empty',
        message: '分支名不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入有效的本地分支名后再继续。'
      });
    }
    if (normalizedName.includes('..') || normalizedName.includes('\\') || normalizedName.startsWith('/') || normalizedName.endsWith('/')) {
      throw new RocDomainError({
        code: 'git_branch_name_invalid',
        message: '分支名不合法。',
        category: 'validation',
        retryable: true,
        userAction: '请使用 Git 允许的本地分支名。'
      });
    }
    return normalizedName;
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
