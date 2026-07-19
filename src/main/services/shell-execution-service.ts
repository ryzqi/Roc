import type { ExecuteResponse } from 'deepagents';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShellExecutionRequest, ShellExecutionResult, TaskEvent } from '../../shared/types';
import { containsVirtualWorkspacePath } from './deep-agent/shell-path-guard';
import type { RtkExecutionMetadata, RtkService } from './rtk-service';
import {
  buildAgentExecutePayload,
  buildRtkEnvironment,
  combineOutput,
  normalizeShellCommand,
  resolveRtkRoute,
  resolveRtkRouteAsync,
  toText
} from './shell-execution-helpers';
import type { WorkspaceService } from './workspace-service';

const powershellUtf8Prefix =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;';

type ExecutedShellCommand = {
  stdout: string;
  stderr: string;
  exitCode: number;
  usedRtk: boolean;
  bypassReason?: ShellExecutionResult['bypassReason'];
  truncated?: boolean;
  teePath?: string;
};

const maxOutputBytes = 64 * 1024;
const shellDeadlineMs = 120 * 1000;
const shellEnvironmentKeys = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR'
] as const;

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
        ? (this.authorizeAgentCommand(request) ?? this.rejectVirtualWorkspacePath({
            command: request.command,
            cwd,
            fallbackCwd: this.readFallbackCwd()
          }) ?? this.runAgentCommand(request.command, cwd))
        : this.executeTerminalCommand(request.command, cwd);
    const cappedExecution = this.capExecutionOutput(execution);
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand,
      cwd,
      stdout: cappedExecution.stdout,
      stderr: cappedExecution.stderr,
      exitCode: execution.exitCode,
      durationMs: Date.now() - startedAt,
      usedRtk: cappedExecution.usedRtk,
      bypassReason: cappedExecution.bypassReason,
      truncated: cappedExecution.truncated,
      ...(cappedExecution.teePath === undefined ? {} : { teePath: cappedExecution.teePath })
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
    if (request.signal?.aborted) {
      throw new Error('shell_execution_aborted');
    }
    const normalizedCommand = normalizeShellCommand(request.command);
    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution =
      request.source === 'agent'
        ? (this.authorizeAgentCommand(request) ?? this.rejectVirtualWorkspacePath({
            command: request.command,
            cwd,
            fallbackCwd: this.readFallbackCwd()
          }) ?? (await this.runAgentCommandAsync(request.command, cwd, request.signal)))
        : await this.executeTerminalCommandAsync(request.command, cwd, request.signal);
    const cappedExecution = this.capExecutionOutput(execution);
    const result: ShellExecutionResult = {
      command: request.command,
      normalizedCommand,
      cwd,
      stdout: cappedExecution.stdout,
      stderr: cappedExecution.stderr,
      exitCode: execution.exitCode,
      durationMs: Date.now() - startedAt,
      usedRtk: cappedExecution.usedRtk,
      bypassReason: cappedExecution.bypassReason,
      truncated: cappedExecution.truncated,
      ...(cappedExecution.teePath === undefined ? {} : { teePath: cappedExecution.teePath })
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

  private async runAgentCommandAsync(command: string, cwd: string, signal?: AbortSignal): Promise<ExecutedShellCommand> {
    const rtk = this.rtkService.getExecutionMetadata();
    if (rtk.resourceState !== 'ready') {
      const fallback = await this.executePowerShellAsync(command, cwd, signal);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtk.bypassReason
      };
    }

    if (signal?.aborted) {
      throw new Error('shell_execution_aborted');
    }
    const rtkRoute = await resolveRtkRouteAsync(
      command,
      rtk,
      signal,
      buildShellEnvironment(buildRtkEnvironment(rtk), false)
    );
    if (signal?.aborted) {
      throw new Error('shell_execution_aborted');
    }
    if (rtkRoute.kind === 'fallback') {
      const fallback = await this.executePowerShellAsync(command, cwd, signal);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtkRoute.bypassReason
      };
    }

    const execution = await this.executeRtkAsync(rtkRoute.args, cwd, rtk, signal);
    return {
      ...execution,
      usedRtk: true
    };
  }

  private executeTerminalCommand(command: string, cwd: string): ExecutedShellCommand {
    const execution = this.executePowerShellWithEnvironment(command, cwd, true);
    return {
      ...execution,
      usedRtk: false,
      bypassReason: 'user_terminal_raw_output'
    };
  }

  private async executeTerminalCommandAsync(command: string, cwd: string, signal?: AbortSignal): Promise<ExecutedShellCommand> {
    const execution = await this.executePowerShellAsync(command, cwd, signal, true);
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
    metadata: RtkExecutionMetadata,
    signal?: AbortSignal
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    return await this.execFileAsync(metadata.binaryPath, args, cwd, buildRtkEnvironment(metadata), signal);
  }

  private executePowerShell(command: string, cwd: string): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    return this.executePowerShellWithEnvironment(command, cwd, false);
  }

  private executePowerShellWithEnvironment(
    command: string,
    cwd: string,
    inheritEnvironment: boolean
  ): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    const encodedCommand = `${powershellUtf8Prefix} ${command}`;
    return this.execFile('powershell.exe', ['-NoProfile', '-Command', encodedCommand], cwd, {}, inheritEnvironment);
  }

  private async executePowerShellAsync(
    command: string,
    cwd: string,
    signal?: AbortSignal,
    inheritEnvironment = false
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    const encodedCommand = `${powershellUtf8Prefix} ${command}`;
    return await this.execFileAsync('powershell.exe', ['-NoProfile', '-Command', encodedCommand], cwd, {}, signal, inheritEnvironment);
  }

  protected execFile(
    file: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
    inheritEnvironment = false
  ): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    try {
      return {
        stdout: execFileSync(file, args, {
          cwd,
          encoding: 'utf8',
          env: buildShellEnvironment(extraEnv, inheritEnvironment),
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
    extraEnv: Record<string, string> = {},
    signal?: AbortSignal,
    inheritEnvironment = false
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    return await new Promise((resolve, reject) => {
      const metadata = this.rtkService.getExecutionMetadata();
      mkdirSync(metadata.teeDir, { recursive: true });
      const artifactPath = join(metadata.teeDir, `shell-${Date.now()}-${randomUUID()}.log`);
      const artifact = createWriteStream(artifactPath, { encoding: 'utf8' });
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      const append = (current: string, chunk: Buffer | string): { value: string; truncated: boolean } => {
        const result = capText(`${current}${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`, maxOutputBytes);
        return result;
      };
      const child = spawn(file, args, {
        cwd,
        env: buildShellEnvironment(extraEnv, inheritEnvironment),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const cleanup = () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      };
      const finishArtifact = (truncated: boolean) => {
        artifact.end(() => {
          if (!truncated) {
            rmSync(artifactPath, { force: true });
          }
        });
      };
      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        terminateProcessTree(child);
        cleanup();
        finishArtifact(false);
        reject(new Error('shell_execution_aborted'));
      };
      const deadline = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        terminateProcessTree(child);
        cleanup();
        finishArtifact(false);
        reject(new Error('shell_execution_deadline_exceeded'));
      }, shellDeadlineMs);
      child.stdout.on('data', (chunk: Buffer | string) => {
        artifact.write(`STDOUT\n${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`);
        const result = append(stdout, chunk);
        stdout = result.value;
        stdoutTruncated = stdoutTruncated || result.truncated;
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        artifact.write(`STDERR\n${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`);
        const result = append(stderr, chunk);
        stderr = result.value;
        stderrTruncated = stderrTruncated || result.truncated;
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        finishArtifact(false);
        resolve({ stdout, stderr: `${stderr}${stderr.length === 0 ? '' : '\n'}${error.message}`, exitCode: 1 });
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const truncated = stdoutTruncated || stderrTruncated;
        finishArtifact(truncated);
        resolve({
          stdout,
          stderr,
          exitCode: code === null ? 1 : code,
          truncated,
          ...(truncated ? { teePath: artifactPath } : {})
        });
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private authorizeAgentCommand(request: ShellExecutionRequest): ExecutedShellCommand | null {
    if (request.allowedCommands === undefined) {
      return null;
    }
    const normalized = normalizeShellCommand(request.command);
    if (request.allowedCommands.some((allowed) => normalizeShellCommand(allowed) === normalized)) {
      return null;
    }
    return {
      stdout: '',
      stderr: 'Error: this background shell command is not durably pre-authorized.',
      exitCode: 1,
      usedRtk: false,
      bypassReason: request.allowedCommands.length === 0 ? 'background_shell_command_not_pre_authorized' : 'shell_run_not_authorized'
    };
  }

  private capExecutionOutput(execution: ExecutedShellCommand): ExecutedShellCommand {
    const stdout = capText(execution.stdout, maxOutputBytes);
    const stderr = capText(execution.stderr, maxOutputBytes);
    if (execution.truncated === true && execution.teePath !== undefined) {
      return execution;
    }
    if (!stdout.truncated && !stderr.truncated) {
      return { ...execution, truncated: false };
    }
    const metadata = this.rtkService.getExecutionMetadata();
    mkdirSync(metadata.teeDir, { recursive: true });
    const teePath = join(metadata.teeDir, `shell-${Date.now()}-${randomUUID()}.log`);
    writeFileSync(teePath, `STDOUT\n${execution.stdout}\nSTDERR\n${execution.stderr}`, 'utf8');
    return {
      ...execution,
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: true,
      teePath
    };
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

function buildShellEnvironment(extraEnv: Record<string, string>, inheritProcessEnvironment: boolean): NodeJS.ProcessEnv {
  if (inheritProcessEnvironment) {
    return { ...process.env, ...extraEnv };
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of shellEnvironmentKeys) {
    const value = readEnvironmentValue(key);
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    environment[key] = value;
  }
  return environment;
}

function readEnvironmentValue(key: string): string | undefined {
  for (const existingKey of Object.keys(process.env)) {
    if (existingKey.toUpperCase() === key) {
      return process.env[existingKey];
    }
  }
  return undefined;
}

function capText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: `${buffer.subarray(0, maxBytes).toString('utf8')}\n[truncated; full output: tee artifact]`,
    truncated: true
  };
}

function terminateProcessTree(child: ReturnType<typeof execFile>): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      child.kill();
    }
    return;
  }
  child.kill();
}
