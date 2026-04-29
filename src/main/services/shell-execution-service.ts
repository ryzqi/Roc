import { execFileSync } from 'node:child_process';
import type { ShellExecutionDecision, ShellExecutionRequest, ShellExecutionResult } from '../../shared/types';
import { RocDomainError } from './errors';
import type { RtkService } from './rtk-service';
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
    const execution = this.executePowerShell(request.command, cwd);
    const rtkStatus = this.rtkService.getStatus();
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand: decision.normalizedCommand,
      cwd,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      durationMs: Date.now() - startedAt,
      usedRtk: false,
      bypassReason: request.source === 'terminal' ? 'user_terminal_raw_output' : rtkStatus.bypassReason
    };

    if (request.source === 'agent' && request.threadId !== undefined && request.runId !== undefined) {
      this.taskService.recordEvent({
        threadId: request.threadId,
        runId: request.runId,
        type: 'terminal_command',
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

  private executePowerShell(command: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
    try {
      return {
        stdout: execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd,
          encoding: 'utf8',
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

  private toText(value: Buffer | string | undefined): string {
    if (value === undefined) {
      return '';
    }
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }
}
