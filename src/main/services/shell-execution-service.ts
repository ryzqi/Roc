import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShellExecutionRequest, ShellExecutionResult, TaskEvent } from '../../shared/types';
import { evaluateShellPolicy, normalizeShellCommand } from './deep-agent/shell-policy';
import type { RtkExecutionMetadata, RtkService } from './rtk-service';
import {
  buildAgentExecutePayload,
  buildRtkEnvironment,
  combineOutput,
  resolveRtkRoute,
  resolveRtkRouteAsync,
  toText
} from './shell-execution-helpers';
import type { WorkspaceService } from './workspace-service';
import { terminateProcessTree } from './process-tree';

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
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'LOGNAME'
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
        ? (this.rejectAgentShellPolicy({
            command: request.command,
            cwd,
            defaultCwd: this.readFallbackCwd(),
            allowedCommands: request.allowedCommands
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
        ? (this.rejectAgentShellPolicy({
            command: request.command,
            cwd,
            defaultCwd: this.readFallbackCwd(),
            allowedCommands: request.allowedCommands
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

  private runAgentCommand(command: string, cwd: string): ExecutedShellCommand {
    const rtk = this.rtkService.getExecutionMetadata();
    if (rtk.resourceState !== 'ready') {
      const policyDenial = this.rejectFinalAgentCommand(command, cwd);
      if (policyDenial !== null) {
        return policyDenial;
      }
      const fallback = this.executeSystemShell(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtk.bypassReason
      };
    }

    const rtkRoute = resolveRtkRoute(command);
    if (rtkRoute.kind === 'fallback') {
      const policyDenial = this.rejectFinalAgentCommand(command, cwd);
      if (policyDenial !== null) {
        return policyDenial;
      }
      const fallback = this.executeSystemShell(command, cwd);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtkRoute.bypassReason
      };
    }

    const policyDenial = this.rejectFinalAgentCommand(formatRtkPolicyCommand(rtkRoute.args), cwd);
    if (policyDenial !== null) {
      return policyDenial;
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
      const policyDenial = this.rejectFinalAgentCommand(command, cwd);
      if (policyDenial !== null) {
        return policyDenial;
      }
      const fallback = await this.executeSystemShellAsync(command, cwd, signal);
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
      const policyDenial = this.rejectFinalAgentCommand(command, cwd);
      if (policyDenial !== null) {
        return policyDenial;
      }
      const fallback = await this.executeSystemShellAsync(command, cwd, signal);
      return {
        ...fallback,
        usedRtk: false,
        bypassReason: rtkRoute.bypassReason
      };
    }

    const policyDenial = this.rejectFinalAgentCommand(formatRtkPolicyCommand(rtkRoute.args), cwd);
    if (policyDenial !== null) {
      return policyDenial;
    }
    const execution = await this.executeRtkAsync(rtkRoute.args, cwd, rtk, signal);
    return {
      ...execution,
      usedRtk: true
    };
  }

  private executeTerminalCommand(command: string, cwd: string): ExecutedShellCommand {
    const execution = this.executeSystemShellWithEnvironment(command, cwd, true);
    return {
      ...execution,
      usedRtk: false,
      bypassReason: 'user_terminal_raw_output'
    };
  }

  private async executeTerminalCommandAsync(command: string, cwd: string, signal?: AbortSignal): Promise<ExecutedShellCommand> {
    const execution = await this.executeSystemShellAsync(command, cwd, signal, true);
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

  private executeSystemShell(command: string, cwd: string): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    return this.executeSystemShellWithEnvironment(command, cwd, false);
  }

  private executeSystemShellWithEnvironment(
    command: string,
    cwd: string,
    inheritEnvironment: boolean
  ): Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'> {
    const shell = resolveCommandShell(command);
    return this.execFile(shell.file, shell.args, cwd, inheritEnvironment ? {} : this.agentShellEnvironment(), inheritEnvironment);
  }

  private async executeSystemShellAsync(
    command: string,
    cwd: string,
    signal?: AbortSignal,
    inheritEnvironment = false
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    const shell = resolveCommandShell(command);
    return await this.execFileAsync(shell.file, shell.args, cwd, inheritEnvironment ? {} : this.agentShellEnvironment(), signal, inheritEnvironment);
  }

  private agentShellEnvironment(): Record<string, string> {
    const metadata = this.rtkService.getExecutionMetadata();
    if (metadata.resourceState !== 'ready') {
      return {};
    }
    return {
      ...buildRtkEnvironment(metadata),
      PATH: [dirname(metadata.binaryPath), process.env.PATH].filter(Boolean).join(':')
    };
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
        detached: true,
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
      const terminate = (message: string): Error => {
        try {
          terminateProcessTree(child);
          return new Error(message);
        } catch (error) {
          return new Error(message, { cause: error });
        }
      };
      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        const failure = terminate('shell_execution_aborted');
        cleanup();
        finishArtifact(false);
        reject(failure);
      };
      const deadline = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const failure = terminate('shell_execution_deadline_exceeded');
        cleanup();
        finishArtifact(false);
        reject(failure);
      }, shellDeadlineMs);
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        artifact.write(`STDOUT\n${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`);
        const result = append(stdout, chunk);
        stdout = result.value;
        stdoutTruncated = stdoutTruncated || result.truncated;
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
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

  private rejectFinalAgentCommand(command: string, cwd: string): ExecutedShellCommand | null {
    // RTK routing may rewrite the command. The host-execution boundary checks that final representation too.
    return this.rejectAgentShellPolicy({ command, cwd, defaultCwd: this.readFallbackCwd() });
  }

  private rejectAgentShellPolicy(input: {
    command: string;
    cwd: string;
    defaultCwd: string;
    allowedCommands?: readonly string[];
  }): ExecutedShellCommand | null {
    const verdict = evaluateShellPolicy(input);
    if (verdict.verdict === 'allow') {
      return null;
    }
    return {
      stdout: '',
      exitCode: 1,
      stderr: verdict.message,
      usedRtk: false,
      bypassReason: verdict.reason
    };
  }

  private readFallbackCwd(): string {
    return this.workspaceService.getCurrentWorkspace()?.path ?? 'selected workspace root';
  }

}

function formatRtkPolicyCommand(args: readonly string[]): string {
  return `rtk ${args.join(' ')}`;
}

function resolveCommandShell(command: string): { file: string; args: string[] } {
  return { file: '/bin/zsh', args: ['-f', '-c', command] };
}

function buildShellEnvironment(extraEnv: Record<string, string>, inheritProcessEnvironment: boolean): NodeJS.ProcessEnv {
  if (inheritProcessEnvironment) {
    return { ...process.env, ...extraEnv };
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of shellEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    environment[key] = value;
  }
  return environment;
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
