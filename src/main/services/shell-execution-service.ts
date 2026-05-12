import { execFileSync } from 'node:child_process';
import type { ExecuteResponse } from 'deepagents';
import type { ShellExecutionDecision, ShellExecutionRequest, ShellExecutionResult } from '../../shared/types';
import { RocDomainError } from './errors';
import type { RtkExecutionMetadata, RtkService } from './rtk-service';
import type { TaskService } from './task-service';
import type { WorkspaceService } from './workspace-service';

const readOnlyCommands = new Set(['dir', 'ls', 'pwd', 'git status', 'git diff', 'rg', 'type', 'cat']);
const highRiskCommandPrefixes = [
  'remove-item',
  'rm',
  'del',
  'erase',
  'move-item',
  'ren',
  'rename-item',
  'set-itemproperty',
  'reg',
  'git push',
  'git reset',
  'git clean',
  'git checkout'
];
const powershellUtf8Prefix =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;';

type ExecutedShellCommand = {
  stdout: string;
  stderr: string;
  exitCode: number;
  usedRtk: boolean;
  bypassReason?: ShellExecutionResult['bypassReason'];
};

export class ShellExecutionService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly rtkService: RtkService,
    private readonly taskService: TaskService
  ) {}

  evaluate(request: ShellExecutionRequest): ShellExecutionDecision {
    const normalizedCommand = this.normalizeCommand(request.command);
    const cwd = this.resolveCwd(request);
    if (!this.workspaceService.isPathInsideCurrentWorkspace(cwd)) {
      return {
        status: 'requires_confirmation',
        reason: 'workspace_outside',
        riskLevel: 'high',
        normalizedCommand
      };
    }
    const commandSegments = this.splitCommandSegments(normalizedCommand);
    if (commandSegments.some((segment) => this.isHighRiskCommand(segment)) || this.hasRedirection(normalizedCommand)) {
      return {
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand
      };
    }
    if (!commandSegments.every((segment) => this.isReadOnlyCommand(segment))) {
      return {
        status: 'requires_confirmation',
        reason: 'unknown_command',
        riskLevel: 'medium',
        normalizedCommand
      };
    }
    return {
      status: 'allowed',
      riskLevel: 'low',
      normalizedCommand
    };
  }

  execute(request: ShellExecutionRequest): ShellExecutionResult {
    const decision = this.evaluate(request);
    if (decision.status !== 'allowed') {
      throw new RocDomainError({
        code: 'command_requires_confirmation',
        message: '命令需要确认，未执行。',
        category: 'permission',
        retryable: false,
        userAction: '请在任务确认卡片中查看命令、作用目录和风险原因后再决定是否执行。'
      });
    }

    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution =
      request.source === 'agent'
        ? this.runAgentCommand(request.command, cwd)
        : this.executeTerminalCommand(request.command, cwd);
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand: decision.normalizedCommand,
      cwd,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      durationMs: Date.now() - startedAt,
      usedRtk: execution.usedRtk,
      bypassReason: execution.bypassReason
    };

    if (request.source === 'agent' && request.threadId !== undefined && request.runId !== undefined) {
      this.taskService.recordEvent({
        threadId: request.threadId,
        runId: request.runId,
        type: 'agent_execute',
        payload: {
          command: result.command,
          normalizedCommand: result.normalizedCommand,
          cwd: result.cwd,
          exitCode: result.exitCode,
          usedRtk: result.usedRtk,
          bypassReason: result.bypassReason
        }
      });
    }

    return result;
  }

  executeAgentCommand(input: {
    command: string;
    cwd?: string;
    threadId?: string;
    runId?: string;
  }): ExecuteResponse & {
    command: string;
    cwd: string;
    usedRtk: boolean;
    bypassReason?: ShellExecutionResult['bypassReason'];
  } {
    const cwd = input.cwd ?? this.workspaceService.requireWorkspace().path;
    const startedAt = Date.now();
    const execution = this.runAgentCommand(input.command, cwd);
    const output = this.combineOutput(execution.stdout, execution.stderr);

    if (input.threadId !== undefined && input.runId !== undefined) {
      this.taskService.recordEvent({
        threadId: input.threadId,
        runId: input.runId,
        type: 'agent_execute',
        payload: {
          command: input.command,
          cwd,
          exitCode: execution.exitCode,
          durationMs: Date.now() - startedAt,
          usedRtk: execution.usedRtk,
          bypassReason: execution.bypassReason
        }
      });
    }

    return {
      command: input.command,
      cwd,
      output,
      exitCode: execution.exitCode,
      truncated: false,
      usedRtk: execution.usedRtk,
      bypassReason: execution.bypassReason
    };
  }

  private runAgentCommand(command: string, cwd: string): ExecutedShellCommand {
    const rtk = this.rtkService.getExecutionMetadata();
    if (rtk.resourceState !== 'ready') {
      const fallback = this.executePowerShell(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtk.bypassReason
      };
    }

    const rtkArgs = this.resolveRtkArgs(command);
    if (rtkArgs === null) {
      const fallback = this.executePowerShell(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: 'command_not_supported'
      };
    }

    const execution = this.executeRtk(rtkArgs, cwd, rtk);
    return {
      ...execution,
      usedRtk: true
    };
  }

  private executeTerminalCommand(command: string, cwd: string): ExecutedShellCommand {
    const execution = this.executePowerShell(command, cwd);
    return {
      ...execution,
      usedRtk: false,
      bypassReason: 'user_terminal_raw_output'
    };
  }

  private executeRtk(
    args: string[],
    cwd: string,
    metadata: RtkExecutionMetadata
  ): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    return this.execFile(metadata.binaryPath, args, cwd, {
      APPDATA: metadata.runtimeRoot,
      LOCALAPPDATA: metadata.runtimeRoot,
      XDG_CONFIG_HOME: metadata.runtimeRoot,
      XDG_DATA_HOME: metadata.runtimeRoot,
      RTK_DB_PATH: metadata.trackingDatabasePath,
      RTK_TEE_DIR: metadata.teeDir
    });
  }

  private executePowerShell(command: string, cwd: string): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    const encodedCommand = `${powershellUtf8Prefix} ${command}`;
    return this.execFile('powershell.exe', ['-NoProfile', '-Command', encodedCommand], cwd);
  }

  protected execFile(
    file: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {}
  ): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    try {
      return {
        stdout: execFileSync(file, args, {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            ...extraEnv
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        stderr: '',
        exitCode: 0
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const failed = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        return {
          stdout: this.toText(failed.stdout),
          stderr: this.toText(failed.stderr),
          exitCode: typeof failed.status === 'number' ? failed.status : 1
        };
      }
      throw error;
    }
  }

  private resolveCwd(request: ShellExecutionRequest): string {
    if (request.cwd !== undefined) {
      return request.cwd;
    }
    return this.workspaceService.requireWorkspace().path;
  }

  private normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  private isReadOnlyCommand(normalizedCommand: string): boolean {
    for (const command of readOnlyCommands) {
      if (normalizedCommand === command || normalizedCommand.startsWith(`${command} `)) {
        return true;
      }
    }
    return false;
  }

  private isHighRiskCommand(normalizedCommand: string): boolean {
    return highRiskCommandPrefixes.some((prefix) => normalizedCommand.startsWith(prefix));
  }

  private splitCommandSegments(normalizedCommand: string): string[] {
    return normalizedCommand
      .split(/[|;&]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private hasRedirection(normalizedCommand: string): boolean {
    return /(^|\s)\d?>{1,2}(\s|&|$)/.test(normalizedCommand);
  }

  private resolveRtkArgs(command: string): string[] | null {
    const normalized = this.normalizeCommand(command);
    if (normalized === 'ls' || normalized.startsWith('ls ')) {
      return ['ls', ...command.trim().split(/\s+/).slice(1)];
    }
    if (normalized === 'git status' || normalized.startsWith('git status ')) {
      return command.trim().split(/\s+/);
    }
    if (normalized === 'git diff' || normalized.startsWith('git diff ')) {
      return command.trim().split(/\s+/);
    }
    return null;
  }

  private toText(value: Buffer | string | undefined): string {
    if (value === undefined) {
      return '';
    }
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }

  private combineOutput(stdout: string, stderr: string): string {
    if (stdout.length === 0) {
      return stderr;
    }
    if (stderr.length === 0) {
      return stdout;
    }
    return `${stdout}\n[stderr]\n${stderr}`;
  }
}
