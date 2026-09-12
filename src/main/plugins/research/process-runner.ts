import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type ResearchProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  allowOcrAcceleration: boolean;
  networkAccess: 'none' | 'loopback' | 'full';
  allowPosixSpawn: boolean;
  additionalExecutables?: readonly string[];
  signal?: AbortSignal;
  input?: string;
  maxOutputBytes?: number;
};

export type ResearchProcessResult = { exitCode: number; stdout: string; stderr: string };

export class ResearchProcessError extends Error {
  constructor(readonly code: string, readonly stdout = '', readonly stderr = '') {
    super(code);
    this.name = 'ResearchProcessError';
  }
}

export async function researchSandboxProfile(request: Pick<ResearchProcessRequest, 'command' | 'readablePaths' | 'writablePaths' | 'allowOcrAcceleration' | 'networkAccess' | 'allowPosixSpawn' | 'additionalExecutables'>): Promise<string> {
  if (typeof request.allowOcrAcceleration !== 'boolean') throw new Error('research_process_acceleration_policy_required');
  if (!['none', 'loopback', 'full'].includes(request.networkAccess)) throw new Error('research_process_network_policy_required');
  if (typeof request.allowPosixSpawn !== 'boolean') throw new Error('research_process_spawn_policy_required');
  const filter = async (path: string): Promise<string> => {
    if (!isAbsolute(path)) throw new Error('research_process_absolute_path_required');
    const resolved = await realpath(path);
    return `(${(await stat(resolved)).isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(resolved)})`;
  };
  const readable = await Promise.all([...request.readablePaths, request.command].map(filter));
  const writable = await Promise.all(request.writablePaths.map(filter));
  const executable = await Promise.all([request.command, ...(request.additionalExecutables ?? [])].map(filter));
  return [
    '(version 1)', '(deny default)', '(import "system.sb")',
    '(allow mach-bootstrap)', '(allow syscall*)', '(allow process-fork)',
    // Darwin SDK: setpgid=82、setsid=147、posix_spawn=244；阻止运行代码脱离受控进程组。
    `(deny syscall-unix (syscall-number 82 147${request.allowPosixSpawn ? '' : ' 244'}))`,
    `(allow process-exec ${executable.join(' ')})`, '(allow signal (target self) (target children))',
    '(allow mach-lookup)', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* ${[...readable, ...writable].join(' ')})`,
    `(allow file-map-executable ${readable.join(' ')})`,
    ...(writable.length === 0 ? [] : [`(allow file-write* ${writable.join(' ')})`]),
    '(deny file-write-create (subpath "/cores"))',
    '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
    ...(request.networkAccess === 'full' ? ['(allow network*)'] : request.networkAccess === 'loopback'
      ? ['(allow network-outbound (remote ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))'] : []),
    // Vision 需要 IOSurface、GPU 和 ANE；只允许计算客户端，不开放整个 IOKit。
    ...(request.allowOcrAcceleration ? ['(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "AGXDeviceUserClient" "IOGPUDeviceUserClient" "H11ANEInDirectPathClient" "H1xANELoadBalancerDirectPathClient"))'] : [])
  ].join('\n');
}

export async function runResearchProcess(request: ResearchProcessRequest): Promise<ResearchProcessResult> {
  if (process.platform !== 'darwin') throw new Error('research_runtime_macos_required');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('research_process_timeout_required');
  const limit = request.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('research_process_output_limit_invalid');
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  const profile = await researchSandboxProfile(request);
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  return await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, request.command, ...request.args], {
      cwd: request.cwd, env: request.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: string | null = null;
    let forcedKill: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') stopped = 'research_process_kill_failed';
      }
    };
    const stop = (code: string): void => {
      if (stopped !== null || settled) return;
      stopped = code;
      kill('SIGTERM');
      forcedKill = setTimeout(() => kill('SIGKILL'), 1000);
      forcedKill.unref();
    };
    const timeout = setTimeout(() => stop('research_process_timeout'), request.timeoutMs);
    timeout.unref();
    const abort = (): void => stop('research_process_cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const append = (target: Buffer[], chunk: Buffer): void => {
      const available = Math.max(0, limit - bytes);
      if (available > 0) target.push(chunk.subarray(0, available));
      bytes += chunk.byteLength;
      if (bytes > limit) stop('research_process_output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      kill('SIGKILL');
      settled = true;
      clearTimeout(timeout);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      request.signal?.removeEventListener('abort', abort);
      const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (stopped !== null) reject(new ResearchProcessError(stopped, output.stdout, output.stderr));
      else if (error !== undefined) reject(new ResearchProcessError('research_process_spawn_failed', output.stdout, output.stderr));
      else resolve({ exitCode: code ?? 1, ...output });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop('research_process_input_failed');
    });
    child.stdin.end(request.input);
  });
}
