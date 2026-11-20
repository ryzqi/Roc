import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShellExecutionRequest, ShellExecutionResult, TaskEvent } from '../../shared/types';
import { assertConsumedExecutionGrant, isConsumedExecutionGrant, type ConsumedExecutionGrant } from './deep-agent/execution-grant-broker';
import { normalizeShellCommand } from './deep-agent/shell-policy';
import { redact } from './deep-agent/redaction';
import type { RtkService } from './rtk-service';
import {
  buildAgentExecutePayload,
  buildRtkEnvironment,
  combineOutput,
  toText
} from './shell-execution-helpers';
import type { WorkspaceService } from './workspace-service';
import { terminateProcessTreeWithRetry } from './process-tree';

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
  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): void;
};

export class ShellExecutionService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly rtkService: RtkService,
    private readonly taskService: ShellTaskEventRecorder
  ) {}

  execute(request: ShellExecutionRequest): ShellExecutionResult {
    if (request.source !== 'terminal') throw new Error('shell_agent_grant_required');
    const normalizedCommand = normalizeShellCommand(request.command);
    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution = this.executeTerminalCommand(request.command, cwd);
    const cappedExecution = this.capExecutionOutput(execution);
    return {
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
  }

  async executeAsync(request: ShellExecutionRequest): Promise<ShellExecutionResult> {
    if (request.signal?.aborted) throw new Error('shell_execution_aborted');
    if (request.source !== 'terminal') throw new Error('shell_agent_grant_required');
    const normalizedCommand = normalizeShellCommand(request.command);
    const cwd = this.resolveCwd(request);
    const startedAt = Date.now();
    const execution = await this.executeTerminalCommandAsync(request.command, cwd, request.signal);
    const cappedExecution = this.capExecutionOutput(execution);
    return {
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
  }

  async executeGrantedAgentAsync(input: {
    command: string;
    signal?: AbortSignal;
    grant: ConsumedExecutionGrant;
  }): Promise<ShellExecutionResult> {
    const { grant } = input;
    const startedAt = Date.now();
    let recorded = false;
    try {
      assertConsumedExecutionGrant(grant, {
        command: input.command,
        cwd: grant.cwd,
        profile: 'trusted_host',
        workspacePath: grant.workspacePath
      });
      if (input.signal?.aborted) throw new Error('shell_execution_aborted');
      const execution = await this.executeSystemShellAsync(input.command, grant.cwd, input.signal, false, {
        maxDurationMs: grant.maxDurationMs,
        maxOutputBytes: grant.maxOutputBytes,
        captureArtifact: false
      });
      const result: ShellExecutionResult = {
        command: input.command,
        normalizedCommand: normalizeShellCommand(input.command),
        cwd: grant.cwd,
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        durationMs: Date.now() - startedAt,
        usedRtk: false,
        truncated: execution.truncated === true
      };
      recorded = true;
      this.recordGrantedAgentExecution(grant, result);
      return result;
    } catch (error) {
      if (!recorded) {
        recorded = true;
        this.recordGrantedAgentExecution(grant, {
          command: input.command,
          normalizedCommand: normalizeShellCommand(input.command),
          cwd: grant.cwd,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          usedRtk: false,
          truncated: false
        }, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  recordGrantedAgentExecution(grant: ConsumedExecutionGrant, result: ShellExecutionResult, executionError?: string): void {
    if (!isConsumedExecutionGrant(grant)) throw new Error('execution_grant_not_consumed');
    this.taskService.recordEvent({
      threadId: grant.threadId,
      runId: grant.runId,
      type: 'agent_execute',
      payload: buildGrantedAgentExecutePayload(grant, result, executionError)
    });
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
    inheritEnvironment = false,
    limits?: { maxOutputBytes: number; maxDurationMs: number; captureArtifact: boolean }
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    const shell = resolveCommandShell(command);
    return this.execFileAsync(shell.file, shell.args, cwd, inheritEnvironment ? {} : this.agentShellEnvironment(), signal, inheritEnvironment, limits);
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
    inheritEnvironment = false,
    limits?: { maxOutputBytes: number; maxDurationMs: number; captureArtifact: boolean }
  ): Promise<Omit<ExecutedShellCommand, 'usedRtk' | 'bypassReason'>> {
    const outputLimit = limits?.maxOutputBytes ?? maxOutputBytes;
    const artifactLimit = 1024 * 1024;
    const maxDurationMs = limits?.maxDurationMs ?? shellDeadlineMs;
    if (!Number.isInteger(outputLimit) || outputLimit <= 0 || outputLimit > 1024 * 1024) {
      throw new Error('shell_execution_output_limit_invalid');
    }
    if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 120000) {
      throw new Error('shell_execution_deadline_invalid');
    }
    const metadata = this.rtkService.getExecutionMetadata();
    const captureArtifact = limits?.captureArtifact ?? true;
    if (captureArtifact) mkdirSync(metadata.teeDir, { recursive: true });
    const artifactPath = captureArtifact ? join(metadata.teeDir, `shell-${Date.now()}-${randomUUID()}.log`) : undefined;
    const artifact = artifactPath === undefined ? null : createWriteStream(artifactPath, { encoding: 'utf8' });
    return new Promise((resolve, reject) => {
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let capturedOutputBytes = 0;
      let artifactBytes = 0;
      let artifactTruncated = false;
      const append = (current: Buffer, chunk: Buffer | string): { value: Buffer; truncated: boolean } => {
        const remainingBytes = Math.max(0, outputLimit - capturedOutputBytes);
        const result = appendBounded(current, chunk, current.byteLength + remainingBytes);
        capturedOutputBytes += result.value.byteLength - current.byteLength;
        return result;
      };
      const appendArtifact = (stream: 'STDOUT' | 'STDERR', chunk: Buffer | string): void => {
        if (artifact === null || artifactTruncated) return;
        const output = Buffer.concat([Buffer.from(`${stream}\n`), Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const remaining = artifactLimit - artifactBytes;
        if (remaining <= 0) {
          artifactTruncated = true;
          return;
        }
        const slice = output.subarray(0, remaining);
        artifact.write(slice);
        artifactBytes += slice.length;
        if (slice.length < output.length) artifactTruncated = true;
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
        if (artifact === null || artifactPath === undefined) return;
        artifact.end(() => {
          if (!truncated && !artifactTruncated) rmSync(artifactPath, { force: true });
        });
      };
      const terminate = async (message: string): Promise<Error> => {
        try {
          await terminateProcessTreeWithRetry(child);
          return new Error(message);
        } catch (error) {
          return new Error(message, { cause: error });
        }
      };
      const stopWithError = async (message: string): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        const failure = await terminate(message);
        finishArtifact(false);
        reject(failure);
      };
      const abort = () => { void stopWithError('shell_execution_aborted'); };
      const deadline = setTimeout(() => { void stopWithError('shell_execution_deadline_exceeded'); }, maxDurationMs);
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        appendArtifact('STDOUT', chunk);
        const result = append(stdout, chunk);
        stdout = result.value;
        stdoutTruncated = stdoutTruncated || result.truncated;
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        appendArtifact('STDERR', chunk);
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
        const stderrText = stderr.toString('utf8');
        resolve({ stdout: stdout.toString('utf8'), stderr: `${stderrText}${stderrText.length === 0 ? '' : '\n'}${error.message}`, exitCode: 1 });
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const truncated = stdoutTruncated || stderrTruncated || artifactTruncated;
        finishArtifact(truncated);
        resolve({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          exitCode: code === null ? 1 : code,
          truncated,
          ...(truncated && artifactPath !== undefined ? { teePath: artifactPath } : {})
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

}

export function buildGrantedAgentExecutePayload(grant: ConsumedExecutionGrant, result: ShellExecutionResult, executionError?: string): Record<string, unknown> {
  return {
    ...buildAgentExecutePayload({
      command: result.command,
      normalizedCommand: result.normalizedCommand,
      cwd: result.cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      usedRtk: result.usedRtk,
      bypassReason: result.bypassReason,
      output: combineOutput(result.stdout, result.stderr)
    }),
    grantId: grant.grantId,
    grantSchemaVersion: grant.schemaVersion,
    toolCallId: grant.toolCallId,
    profile: grant.profile,
    approvalReference: grant.approvalReference ?? null,
    executionError: executionError === undefined ? null : redact(executionError).slice(0, 512)
  };
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

function appendBounded(current: Buffer, chunk: Buffer | string, maxBytes: number): { value: Buffer; truncated: boolean } {
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maxBytes - current.byteLength);
  if (chunkBuffer.byteLength <= remaining) {
    return { value: Buffer.concat([current, chunkBuffer]), truncated: false };
  }
  return { value: Buffer.concat([current, chunkBuffer.subarray(0, remaining)]), truncated: true };
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
