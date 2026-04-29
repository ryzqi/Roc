import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitDiffStatResult, GitStatusResult } from '../../shared/types';
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

    return {
      workspacePath: workspace.path,
      isRepository: true,
      branch,
      porcelain,
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
}
