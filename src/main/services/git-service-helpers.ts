import { isAbsolute } from 'node:path';

import type { GitStatusChange } from '../../shared/types';
import { RocDomainError } from './errors';

export function parseGitStatusChanges(rawStatus: string): GitStatusChange[] {
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

export function normalizeGitPath(relativePath: string): string {
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

export function normalizeGitPaths(relativePaths: string[]): string[] {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw new RocDomainError({
      code: 'git_file_paths_empty',
      message: '批量暂存至少需要一个文件路径。',
      category: 'validation',
      retryable: true,
      userAction: '请先选择至少一个变更文件后再执行批量暂存。'
    });
  }
  return relativePaths.map((relativePath) => normalizeGitPath(relativePath));
}

export function normalizeBranchName(name: string): string {
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

export function isGitDiffExitCodeOne(error: unknown): error is { status: number; stdout: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 1 &&
    'stdout' in error &&
    typeof (error as { stdout?: unknown }).stdout === 'string'
  );
}

export function toGitCommandError(args: string[], error: unknown): RocDomainError {
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
