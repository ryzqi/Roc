import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../src/shared/types';
import type { WorkspaceService } from '../../src/main/services/workspace-service';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('GitService async git command scheduling', () => {
  let workspaceRoot: string | null = null;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('node:child_process');
    if (workspaceRoot !== null) {
      rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = null;
    }
  });

  it('serializes async refresh commands so git status cannot race on .git/index', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-git-queue-'));
    mkdirSync(join(workspaceRoot, '.git'));

    let activeCommands = 0;
    let maxActiveCommands = 0;
    const commands: string[] = [];
    const execFileMock = vi.fn((file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      expect(file).toBe('git');
      commands.push(args.join(' '));
      if (activeCommands > 0) {
        queueMicrotask(() => {
          callback(new Error('fatal: .git/index: index file open failed: Permission denied'), '', 'fatal: .git/index: index file open failed: Permission denied');
        });
        return null;
      }

      activeCommands += 1;
      maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
      setTimeout(() => {
        activeCommands -= 1;
        callback(null, stdoutForGitArgs(args), '');
      }, 5);
      return null;
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        execFile: execFileMock
      };
    });

    const { GitService } = await import('../../src/main/services/git-service');
    const gitService = new GitService(createWorkspaceService(workspaceRoot));

    const [status, branches] = await Promise.all([gitService.getStatusAsync(), gitService.listBranchesAsync()]);

    expect(status).toMatchObject({
      branch: 'main',
      changedFiles: 1,
      porcelain: [' M notes.txt']
    });
    expect(status.changes).toEqual([
      {
        index: ' ',
        worktree: 'M',
        relativePath: 'notes.txt',
        originalPath: undefined,
        porcelain: ' M notes.txt'
      }
    ]);
    expect(branches).toMatchObject({
      currentBranch: 'main',
      branches: [{ name: 'main', current: true }]
    });
    expect(maxActiveCommands).toBe(1);
    expect(commands).toHaveLength(5);
    expect(commands.filter((command) => command === 'branch --show-current')).toHaveLength(2);
    expect(commands.filter((command) => command === 'status --porcelain')).toHaveLength(1);
    expect(commands.filter((command) => command === 'status --porcelain=v1 -z')).toHaveLength(1);
    expect(commands.filter((command) => command === 'branch --format=%(refname:short)')).toHaveLength(1);
  });
});

function createWorkspaceService(workspacePath: string): WorkspaceService {
  const workspace: Workspace = {
    id: 'workspace_git_queue',
    path: workspacePath,
    displayName: 'git-queue',
    lastOpenedAt: '2026-05-26T00:00:00.000Z',
    trustState: 'trusted'
  };
  return {
    requireWorkspace: () => workspace,
    resolveInsideWorkspace: (relativePath: string) => join(workspacePath, relativePath)
  } as WorkspaceService;
}

function stdoutForGitArgs(args: string[]): string {
  const command = args.join(' ');
  if (command === 'branch --show-current') {
    return 'main\n';
  }
  if (command === 'branch --format=%(refname:short)') {
    return 'main\n';
  }
  if (command === 'status --porcelain') {
    return ' M notes.txt\n';
  }
  if (command === 'status --porcelain=v1 -z') {
    return ' M notes.txt\0';
  }
  throw new Error(`Unexpected git command: ${command}`);
}
