import { execFile, execFileSync } from 'node:child_process';
import type { ExecuteResponse } from 'deepagents';
import type { ShellExecutionRequest, ShellExecutionResult, TaskEvent } from '../../shared/types';
import type { RtkExecutionMetadata, RtkService } from './rtk-service';
import type { WorkspaceService } from './workspace-service';
import { containsVirtualWorkspacePath } from './deep-agent/shell-path-guard';
import {
  buildAgentExecutePayload,
  buildRtkEnvironment,
  combineOutput,
  normalizeShellCommand,
  resolveRtkRoute,
  resolveRtkRouteAsync,
  toText,
  type RtkRoutingDecision
} from './shell-execution-helpers';

const powershellUtf8Prefix =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;';

type ExecutedShellCommand = {
  stdout: string;
  stderr: string;
  exitCode: number;
  usedRtk: boolean;
  bypassReason?: ShellExecutionResult['bypassReason'];
};

export type ShellTaskEventRecorder = {
  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): unknown;
};

export class ShellExecutionService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly rtkService: RtkService,
    private readonly taskService: ShellTaskEventRecorder
  ) {}

  execute(request: ShellExecutionRequest): ShellExecutionResult {
    const normalizedCommand = normalizeShellCommand(request.command);
    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution =
      request.source === 'agent'
        ? (this.rejectVirtualWorkspacePath({
            command: request.command,
            cwd,
            fallbackCwd: this.readFallbackCwd()
          }) ?? this.runAgentCommand(request.command, cwd))
        : this.executeTerminalCommand(request.command, cwd);
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand,
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
        payload: buildAgentExecutePayload({
          command: result.command,
          normalizedCommand: result.normalizedCommand,
          cwd: result.cwd,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          usedRtk: result.usedRtk,
          bypassReason: result.bypassReason,
          output: combineOutput(result.stdout, result.stderr)
        })
      });
    }

    return result;
  }

  async executeAsync(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    const normalizedCommand = normalizeShellCommand(request.command);
    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution =
      request.source === 'agent'
        ? (this.rejectVirtualWorkspacePath({
            command: request.command,
            cwd,
            fallbackCwd: this.readFallbackCwd()
          }) ?? (await this.runAgentCommandAsync(request.command, cwd)))
        : await this.executeTerminalCommandAsync(request.command, cwd);
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand,
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
        payload: buildAgentExecutePayload({
          command: result.command,
          normalizedCommand: result.normalizedCommand,
          cwd: result.cwd,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          usedRtk: result.usedRtk,
          bypassReason: result.bypassReason,
          output: combineOutput(result.stdout, result.stderr)
        })
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
    const workspaceRouteViolation = this.rejectVirtualWorkspacePath({
      command: input.command,
      cwd,
      fallbackCwd: input.cwd === undefined ? cwd : this.readFallbackCwd()
    });
    if (workspaceRouteViolation !== null) {
      if (input.threadId !== undefined && input.runId !== undefined) {
        this.taskService.recordEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'agent_execute',
          payload: buildAgentExecutePayload({
            command: input.command,
            cwd,
            exitCode: workspaceRouteViolation.exitCode,
            durationMs: 0,
            usedRtk: false,
            bypassReason: workspaceRouteViolation.bypassReason,
            output: workspaceRouteViolation.stderr
          })
        });
      }

      return {
        command: input.command,
        cwd,
        output: workspaceRouteViolation.stderr,
        exitCode: workspaceRouteViolation.exitCode,
        truncated: false,
        usedRtk: false,
        bypassReason: workspaceRouteViolation.bypassReason
      };
    }
    const startedAt = Date.now();
    const execution = this.runAgentCommand(input.command, cwd);
    const output = combineOutput(execution.stdout, execution.stderr);

    if (input.threadId !== undefined && input.runId !== undefined) {
      this.taskService.recordEvent({
        threadId: input.threadId,
        runId: input.runId,
        type: 'agent_execute',
        payload: buildAgentExecutePayload({
          command: input.command,
          cwd,
          exitCode: execution.exitCode,
          durationMs: Date.now() - startedAt,
          usedRtk: execution.usedRtk,
          bypassReason: execution.bypassReason,
          output
        })
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

  async executeAgentCommandAsync(input: {
    command: string;
    cwd?: string;
    threadId?: string;
    runId?: string;
  }): Promise<
    ExecuteResponse & {
      command: string;
      cwd: string;
      usedRtk: boolean;
      bypassReason?: ShellExecutionResult['bypassReason'];
    }
  > {
    const cwd = input.cwd ?? this.workspaceService.requireWorkspace().path;
    const workspaceRouteViolation = this.rejectVirtualWorkspacePath({
      command: input.command,
      cwd,
      fallbackCwd: input.cwd === undefined ? cwd : this.readFallbackCwd()
    });
    if (workspaceRouteViolation !== null) {
      if (input.threadId !== undefined && input.runId !== undefined) {
        this.taskService.recordEvent({
          threadId: input.threadId,
          runId: input.runId,
          type: 'agent_execute',
          payload: buildAgentExecutePayload({
            command: input.command,
            cwd,
            exitCode: workspaceRouteViolation.exitCode,
            durationMs: 0,
            usedRtk: false,
            bypassReason: workspaceRouteViolation.bypassReason,
            output: workspaceRouteViolation.stderr
          })
        });
      }

      return {
        command: input.command,
        cwd,
        output: workspaceRouteViolation.stderr,
        exitCode: workspaceRouteViolation.exitCode,
        truncated: false,
        usedRtk: false,
        bypassReason: workspaceRouteViolation.bypassReason
      };
    }
    const startedAt = Date.now();
    const execution = await this.runAgentCommandAsync(input.command, cwd);
    const output = combineOutput(execution.stdout, execution.stderr);

    if (input.threadId !== undefined && input.runId !== undefined) {
      this.taskService.recordEvent({
        threadId: input.threadId,
        runId: input.runId,
        type: 'agent_execute',
        payload: buildAgentExecutePayload({
          command: input.command,
          cwd,
          exitCode: execution.exitCode,
          durationMs: Date.now() - startedAt,
          usedRtk: execution.usedRtk,
          bypassReason: execution.bypassReason,
          output
        })
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

    const rtkRoute = resolveRtkRoute(command);
    if (rtkRoute.kind === 'fallback') {
      const fallback = this.executePowerShell(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtkRoute.bypassReason
      };
    }

    const execution = this.executeRtk(rtkRoute.args, cwd, rtk);
    return {
      ...execution,
      usedRtk: true
    };
  }

  private async runAgentCommandAsync(command: string, cwd: string): Promise<ExecutedShellCommand> {
    const rtk = this.rtkService.getExecutionMetadata();
    if (rtk.resourceState !== 'ready') {
      const fallback = await this.executePowerShellAsync(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtk.bypassReason
      };
    }

    const rtkRoute = await resolveRtkRouteAsync(command, rtk);
    if (rtkRoute.kind === 'fallback') {
      const fallback = await this.executePowerShellAsync(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtkRoute.bypassReason
      };
    }

    const execution = await this.executeRtkAsync(rtkRoute.args, cwd, rtk);
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

  private async executeTerminalCommandAsync(command: string, cwd: string): Promise<ExecutedShellCommand> {
    const execution = await this.executePowerShellAsync(command, cwd);
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
    return this.execFile(metadata.binaryPath, args, cwd, buildRtkEnvironment(metadata));
  }

  private async executeRtkAsync(
    args: string[],
    cwd: string,
    metadata: RtkExecutionMetadata
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    return await this.execFileAsync(metadata.binaryPath, args, cwd, buildRtkEnvironment(metadata));
  }

  private executePowerShell(command: string, cwd: string): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    const encodedCommand = `${powershellUtf8Prefix} ${command}`;
    return this.execFile('powershell.exe', ['-NoProfile', '-Command', encodedCommand], cwd);
  }

  private async executePowerShellAsync(
    command: string,
    cwd: string
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    const encodedCommand = `${powershellUtf8Prefix} ${command}`;
    return await this.execFileAsync('powershell.exe', ['-NoProfile', '-Command', encodedCommand], cwd);
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
          stdout: toText(failed.stdout),
          stderr: toText(failed.stderr),
          exitCode: typeof failed.status === 'number' ? failed.status : 1
        };
      }
      throw error;
    }
  }

  protected async execFileAsync(
    file: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {}
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    return await new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            ...extraEnv
          },
          windowsHide: true
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (error === null) {
            resolve({
              stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
              stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
              exitCode: 0
            });
            return;
          }
          if (typeof error === 'object' && error !== null && 'code' in error) {
            resolve({
              stdout: toText(stdout as Buffer | string | undefined),
              stderr: toText(stderr as Buffer | string | undefined),
              exitCode: typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
            });
            return;
          }
          reject(error);
        }
      );
    });
  }

  private resolveCwd(request: ShellExecutionRequest): string {
    if (request.cwd !== undefined) {
      return request.cwd;
    }
    return this.workspaceService.requireWorkspace().path;
  }

  private rejectVirtualWorkspacePath(input: { command: string; cwd: string; fallbackCwd: string }): ExecutedShellCommand | null {
    if (!containsVirtualWorkspacePath(input.command) && !containsVirtualWorkspacePath(input.cwd)) {
      return null;
    }

    return {
      stdout: '',
      exitCode: 1,
      stderr: `Error: /workspace is a Deep Agents file-tool route, not a shell directory. Use the selected workspace root on Windows: ${input.fallbackCwd}`,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    };
  }

  private readFallbackCwd(): string {
    return this.workspaceService.getCurrentWorkspace()?.path ?? 'selected workspace root';
  }

}
