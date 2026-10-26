import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import {
  isGitDiffExitCodeOne,
  normalizeBranchName,
  normalizeGitPath,
  normalizeGitPaths,
  parseGitStatusChanges,
  toGitCommandError
} from './git-service-helpers';
import type { WorkspaceService } from './workspace-service';

const defaultCommandTimeoutMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 10 * 1024 * 1024;
const defaultKillGraceMs = 1000;

export type GitOperationOptions = {
  signal?: AbortSignal;
  operationId?: string;
};

export type GitServiceOptions = {
  /** Override the executable for integration tests; production uses Git from PATH. */
  gitExecutable?: string;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
};

type RunOptions = GitOperationOptions & {
  expectedExitCodes?: readonly number[];
};

export class GitService {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly activeOperations = new Map<string, AbortController>();
  private readonly gitExecutable: string;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(private readonly workspaceService: WorkspaceService, options: GitServiceOptions = {}) {
    this.gitExecutable = options.gitExecutable ?? 'git';
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, defaultCommandTimeoutMs, 'git_command_timeout_invalid');
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, defaultMaxOutputBytes, 'git_output_limit_invalid');
    this.killGraceMs = positiveInteger(options.killGraceMs, defaultKillGraceMs, 'git_kill_grace_invalid');
  }

  async getStatus(options: GitOperationOptions = {}): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    return await this.getStatusAt(workspace.path, options.signal);
  }

  async getDiffStat(options: GitOperationOptions = {}): Promise<GitDiffStatResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    return {
      workspacePath: workspace.path,
      stat: await this.runGit(workspace.path, ['diff', '--stat'], { signal: options.signal })
    };
  }

  async getFileDiff(relativePath: string, options: GitOperationOptions = {}): Promise<GitFileDiffResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedPath = normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    const change = (await this.getStatusChanges(workspace.path, options.signal))
      .find((item) => item.relativePath === normalizedPath);
    if (change === undefined) {
      throw missingGitChangeError('预览');
    }
    const patch = change.index === '?'
      ? await this.runGitAllowingDiffExitCode(
        workspace.path,
        ['--literal-pathspecs', 'diff', '--no-index', '--unified=1', '--', '/dev/null', normalizedPath],
        options.signal
      )
      : change.index !== ' ' && change.worktree === ' '
        ? await this.runGit(
          workspace.path,
          ['--literal-pathspecs', 'diff', '--cached', '--find-renames', '--unified=1', '--', normalizedPath],
          { signal: options.signal }
        )
        : await this.runGit(
          workspace.path,
          ['--literal-pathspecs', 'diff', '--find-renames', '--unified=1', '--', normalizedPath],
          { signal: options.signal }
        );

    return { workspacePath: workspace.path, relativePath: normalizedPath, patch };
  }

  async stageFile(relativePath: string, options: GitOperationOptions = {}): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedPath = normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      await this.runGit(workspace.path, ['--literal-pathspecs', 'add', '--', normalizedPath], { signal: options.signal });
      return await this.getStatusAt(workspace.path, options.signal);
    });
  }

  async stageFiles(relativePaths: string[], options: GitOperationOptions = {}): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedPaths = normalizeGitPaths(relativePaths);
    for (const normalizedPath of normalizedPaths) {
      this.workspaceService.resolveInsideWorkspace(normalizedPath);
    }
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      await this.runGit(workspace.path, ['--literal-pathspecs', 'add', '--', ...normalizedPaths], { signal: options.signal });
      return await this.getStatusAt(workspace.path, options.signal);
    });
  }

  async unstageFile(relativePath: string, options: GitOperationOptions = {}): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedPath = normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      await this.runGit(workspace.path, ['--literal-pathspecs', 'restore', '--staged', '--', normalizedPath], { signal: options.signal });
      return await this.getStatusAt(workspace.path, options.signal);
    });
  }

  async discardFileChanges(relativePath: string, options: GitOperationOptions = {}): Promise<GitStatusResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedPath = normalizeGitPath(relativePath);
    this.workspaceService.resolveInsideWorkspace(normalizedPath);
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      const currentStatus = await this.getStatusAt(workspace.path, options.signal);
      const change = currentStatus.changes.find((item) => item.relativePath === normalizedPath);
      if (change === undefined) {
        throw missingGitChangeError('回滚');
      }
      if (change.index !== ' ' && change.index !== '?') {
        await this.runGit(workspace.path, ['--literal-pathspecs', 'restore', '--staged', '--worktree', '--', normalizedPath], { signal: options.signal });
      } else if (change.worktree !== ' ' || change.index === '?') {
        await this.runGit(workspace.path, ['--literal-pathspecs', 'restore', '--worktree', '--', normalizedPath], { signal: options.signal });
      } else {
        throw missingGitChangeError('回滚');
      }
      return await this.getStatusAt(workspace.path, options.signal);
    });
  }

  async commit(message: string, options: GitOperationOptions = {}): Promise<GitCommitResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
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
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      const before = await this.getStatusAt(workspace.path, options.signal);
      if (before.changedFiles === 0) {
        throw new RocDomainError({
          code: 'git_commit_no_changes',
          message: '当前没有可提交的变更。',
          category: 'conflict',
          retryable: false,
          userAction: '请先修改或暂存文件后再提交。'
        });
      }
      await this.runGit(workspace.path, ['commit', '-m', normalizedMessage], { signal: options.signal });
      const commitSha = (await this.runGit(workspace.path, ['rev-parse', 'HEAD'], { signal: options.signal })).trim();
      return {
        workspacePath: workspace.path,
        commitMessage: normalizedMessage,
        commitSha,
        status: await this.getStatusAt(workspace.path, options.signal)
      };
    });
  }

  async push(options: GitOperationOptions = {}): Promise<GitPushResult> {
    const workspace = this.workspaceService.requireWorkspace();
    return await this.withOperationController(options, async (signal) => {
      await this.ensureGitRepository(workspace.path);
      return await this.withRepositoryWriteLock(workspace.path, signal, async () => {
        const branch = (await this.runGit(workspace.path, ['branch', '--show-current'], { signal })).trim();
        const remoteName = (await this.runGit(
          workspace.path,
          ['config', '--get', `branch.${branch}.remote`],
          { signal, expectedExitCodes: [1] }
        )).trim();
        if (remoteName.length === 0) {
          throw new RocDomainError({
            code: 'git_push_remote_missing',
            message: '当前分支没有配置远端。',
            category: 'not_found',
            retryable: false,
            userAction: '请先为当前分支配置远端后再 push。'
          });
        }
        const output = await this.runGit(workspace.path, ['push'], { signal });
        return {
          workspacePath: workspace.path,
          remoteName,
          branch,
          status: await this.getStatusAt(workspace.path, signal),
          output
        };
      });
    });
  }

  cancelOperation(operationId: string): boolean {
    const controller = this.activeOperations.get(operationId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  async listBranches(options: GitOperationOptions = {}): Promise<GitBranchListResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    return await this.readBranchList(workspace.path, options.signal);
  }

  async createBranch(name: string, checkoutAfterCreate: boolean, options: GitOperationOptions = {}): Promise<GitBranchMutationResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedBranchName = normalizeBranchName(name);
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      await this.runGit(workspace.path, ['branch', normalizedBranchName], { signal: options.signal });
      if (checkoutAfterCreate) {
        await this.runGit(workspace.path, ['checkout', normalizedBranchName], { signal: options.signal });
      }
      return {
        workspacePath: workspace.path,
        branchInfo: await this.readBranchList(workspace.path, options.signal),
        status: await this.getStatusAt(workspace.path, options.signal)
      };
    });
  }

  async checkoutBranch(name: string, options: GitOperationOptions = {}): Promise<GitBranchMutationResult> {
    const workspace = this.workspaceService.requireWorkspace();
    await this.ensureGitRepository(workspace.path);
    const normalizedBranchName = normalizeBranchName(name);
    return await this.withRepositoryWriteLock(workspace.path, options.signal, async () => {
      const branchInfo = await this.readBranchList(workspace.path, options.signal);
      if (!branchInfo.branches.some((branch) => branch.name === normalizedBranchName)) {
        throw new RocDomainError({
          code: 'git_branch_missing',
          message: `本地分支不存在：${normalizedBranchName}`,
          category: 'not_found',
          retryable: false,
          userAction: '请选择一个已存在的本地分支，或先新建分支。'
        });
      }
      await this.runGit(workspace.path, ['checkout', normalizedBranchName], { signal: options.signal });
      return {
        workspacePath: workspace.path,
        branchInfo: await this.readBranchList(workspace.path, options.signal),
        status: await this.getStatusAt(workspace.path, options.signal)
      };
    });
  }

  private async ensureGitRepository(workspacePath: string): Promise<void> {
    try {
      // A linked worktree stores `.git` as a file rather than a directory.
      await access(join(workspacePath, '.git'));
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code !== 'ENOENT') throw error;
      throw new RocDomainError({
        code: 'git_repository_missing',
        message: '当前工作区不是 Git 仓库。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个 Git 仓库工作区，或在外部初始化仓库后重试。'
      });
    }
  }

  private async runGit(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
    const { signal, expectedExitCodes = [] } = options;
    if (signal?.aborted) {
      throw toGitCommandError(args, { code: 'ABORT_ERR' });
    }
    return await new Promise<string>((resolveOutput, rejectOutput) => {
      let settled = false;
      let termination: 'timeout' | 'cancelled' | null = null;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let child: ChildProcess;

      const cleanUp = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanUp();
        callback();
      };
      const terminate = (reason: 'timeout' | 'cancelled'): void => {
        if (settled || termination !== null) return;
        termination = reason;
        signalChild(child, 'SIGTERM');
        killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), this.killGraceMs);
        killTimer.unref();
      };
      const onAbort = (): void => terminate('cancelled');

      try {
        const childOptions = {
          cwd,
          encoding: 'utf8',
          maxBuffer: this.maxOutputBytes,
          detached: process.platform !== 'win32'
        } as ExecFileOptionsWithStringEncoding & { detached: boolean };
        child = execFile(
          this.gitExecutable,
          args,
          childOptions,
          (error, stdout, stderr) => {
            const output = stdout.toString();
            if (error === null) {
              settle(() => resolveOutput(output));
              return;
            }
            const commandCode = termination === 'timeout'
              ? 'ETIMEDOUT'
              : termination === 'cancelled'
                ? 'ABORT_ERR'
                : error.code;
            const status = typeof error.code === 'number' ? error.code : undefined;
            const details = {
              ...error,
              code: commandCode,
              status,
              stdout: output,
              stderr: stderr.toString()
            };
            if (status !== undefined && expectedExitCodes.includes(status)) {
              settle(() => resolveOutput(output));
              return;
            }
            settle(() => rejectOutput(toGitCommandError(args, details)));
          }
        );
      } catch (error) {
        settle(() => rejectOutput(toGitCommandError(args, error)));
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timeoutTimer = setTimeout(() => terminate('timeout'), this.commandTimeoutMs);
      timeoutTimer.unref();
    });
  }

  private async runGitAllowingDiffExitCode(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    try {
      return await this.runGit(cwd, args, { signal, expectedExitCodes: [1] });
    } catch (error) {
      if (isGitDiffExitCodeOne(error)) return error.stdout;
      throw error;
    }
  }

  private async getStatusAt(cwd: string, signal?: AbortSignal): Promise<GitStatusResult> {
    const [branchOutput, changes] = await Promise.all([
      this.runGit(cwd, ['branch', '--show-current'], { signal }),
      this.getStatusChanges(cwd, signal)
    ]);
    return {
      workspacePath: cwd,
      isRepository: true,
      branch: branchOutput.trim(),
      // Derive both lists from NUL-delimited porcelain so embedded newlines and
      // rename source paths never get split or counted as separate changes.
      porcelain: changes.map((change) => change.porcelain),
      changes,
      changedFiles: changes.length
    };
  }

  private async getStatusChanges(cwd: string, signal?: AbortSignal): Promise<GitStatusChange[]> {
    const rawStatus = await this.runGit(cwd, ['status', '--porcelain=v1', '-z'], { signal });
    return parseGitStatusChanges(rawStatus);
  }

  private async readBranchList(cwd: string, signal?: AbortSignal): Promise<GitBranchListResult> {
    const [currentBranchOutput, branchOutput] = await Promise.all([
      this.runGit(cwd, ['branch', '--show-current'], { signal }),
      this.runGit(cwd, ['branch', '--format=%(refname:short)'], { signal })
    ]);
    const currentBranch = currentBranchOutput.trim();
    const branchLines = branchOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const branches: GitBranchSummary[] = branchLines.map((name) => ({ name, current: name === currentBranch }));
    return { workspacePath: cwd, currentBranch, branches };
  }

  private async withRepositoryWriteLock<T>(
    workspacePath: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (signal?.aborted) throw toGitCommandError(['write'], { code: 'ABORT_ERR' });
    const commonGitDirectory = (await this.runGit(workspacePath, ['rev-parse', '--git-common-dir'], { signal })).trim();
    const lockKey = await realpath(resolve(workspacePath, commonGitDirectory));
    const previous = this.writeQueues.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
    const tail = previous.then(() => turn);
    this.writeQueues.set(lockKey, tail);
    void tail.then(() => {
      if (this.writeQueues.get(lockKey) === tail) this.writeQueues.delete(lockKey);
    });

    let acquired = false;
    try {
      await waitForQueue(previous, signal);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) release();
      else void previous.then(release, release);
    }
  }

  private async withOperationController<T>(
    options: GitOperationOptions,
    operation: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    const { operationId, signal } = options;
    if (operationId === undefined) return await operation(signal);
    if (operationId.trim().length === 0 || this.activeOperations.has(operationId)) {
      throw new RocDomainError({
        code: 'git_operation_id_invalid',
        message: 'Git 操作标识无效或正在使用。',
        category: 'validation',
        retryable: false,
        userAction: '请重试此 Git 操作。'
      });
    }

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    this.activeOperations.set(operationId, controller);
    try {
      return await operation(controller.signal);
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      if (this.activeOperations.get(operationId) === controller) this.activeOperations.delete(operationId);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, code: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function missingGitChangeError(action: string): RocDomainError {
  return new RocDomainError({
    code: 'git_file_change_missing',
    message: `当前文件没有可${action}的 Git 变更。`,
    category: 'not_found',
    retryable: false,
    userAction: '请选择一个存在未提交变更的文件。'
  });
}

function waitForQueue(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return previous;
  if (signal.aborted) return Promise.reject(toGitCommandError(['write'], { code: 'ABORT_ERR' }));
  return new Promise<void>((resolveQueue, rejectQueue) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      rejectQueue(toGitCommandError(['write'], { code: 'ABORT_ERR' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolveQueue();
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      rejectQueue(error);
    });
  });
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Some runtimes do not create a separate process group for execFile children.
      // Fall back to the direct child so cancellation and timeout still terminate Git.
    }
  }
  child.kill(signal);
}
