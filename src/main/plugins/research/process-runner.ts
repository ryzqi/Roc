import { spawn } from 'node:child_process';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export type ResearchProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  allowGpuAcceleration: boolean;
  networkAccess: 'none' | 'loopback' | 'full';
  allowPosixSpawn: boolean;
  additionalExecutables?: readonly string[];
  signal?: AbortSignal;
  input?: string;
  maxOutputBytes?: number;
  writeLimits?: readonly ResearchProcessWriteLimit[];
};

export type ResearchProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ResearchProcessWriteLimit = {
  path: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxEntries: number;
};

export class ResearchProcessError extends Error {
  constructor(readonly code: string, readonly stdout = '', readonly stderr = '') {
    super(code);
    this.name = 'ResearchProcessError';
  }
}

async function assertProcessWriteLimits(limits: readonly ResearchProcessWriteLimit[]): Promise<void> {
  for (const limit of limits) {
    const rootInfo = await lstat(limit.path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('research_process_write_path_invalid');
    const root = await realpath(limit.path);
    const stack = [root];
    let entriesSeen = 0;
    let filesSeen = 0;
    let bytesSeen = 0;
    while (stack.length > 0) {
      const directory = stack.pop();
      if (directory === undefined) break;
      for await (const entry of await opendir(directory)) {
        entriesSeen += 1;
        if (entriesSeen > limit.maxEntries) throw new Error('research_process_write_entry_limit');
        const path = join(directory, entry.name);
        let info: Awaited<ReturnType<typeof lstat>>;
        try { info = await lstat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (info.isSymbolicLink()) throw new Error('research_process_write_symlink');
        if (info.isDirectory()) stack.push(path);
        else if (info.isFile()) {
          filesSeen += 1;
          bytesSeen += info.size;
          if (info.nlink !== 1 || !Number.isSafeInteger(bytesSeen) || filesSeen > limit.maxFiles || info.size > limit.maxFileBytes || bytesSeen > limit.maxTotalBytes) {
            throw new Error('research_process_write_limit');
          }
        } else throw new Error('research_process_write_entry_invalid');
      }
    }
  }
}

export async function researchSandboxProfile(request: Pick<ResearchProcessRequest, 'command' | 'readablePaths' | 'writablePaths' | 'allowGpuAcceleration' | 'networkAccess' | 'allowPosixSpawn' | 'additionalExecutables'>): Promise<string> {
  if (typeof request.allowGpuAcceleration !== 'boolean') throw new Error('research_process_acceleration_policy_required');
  if (!['none', 'loopback', 'full'].includes(request.networkAccess)) throw new Error('research_process_network_policy_required');
  if (typeof request.allowPosixSpawn !== 'boolean') throw new Error('research_process_spawn_policy_required');
  const filter = async (path: string): Promise<string> => {
    if (!isAbsolute(path)) throw new Error('research_process_absolute_path_required');
    const resolved = await realpath(path);
    const info = await stat(resolved);
    return `(${info.isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(resolved)})`;
  };
  const readable = await Promise.all([...request.readablePaths, request.command].map(filter));
  const writable = await Promise.all(request.writablePaths.map(filter));
  const executable = await Promise.all([request.command, ...(request.additionalExecutables ?? [])].map(filter));
  const networkRules: string[] = [];
  switch (request.networkAccess) {
    case 'none': break;
    case 'full': networkRules.push('(allow network*)'); break;
    case 'loopback': networkRules.push('(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))'); break;
    default: throw new Error('research_process_network_policy_required');
  }
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
    ...networkRules,
    // Jobs using the ORT CoreML provider need the Apple GPU/CoreML services. This permission is
    // opt-in per job; CPU inference and ordinary experiment jobs do not receive it.
    ...(request.allowGpuAcceleration ? ['(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "AGXDeviceUserClient" "IOGPUDeviceUserClient"))'] : [])
  ].join('\n');
}

export async function runResearchProcess(request: ResearchProcessRequest): Promise<ResearchProcessResult> {
  if (process.platform !== 'darwin') throw new Error('research_runtime_macos_required');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('research_process_timeout_required');
  const limit = request.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('research_process_output_limit_invalid');
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  for (const limit of request.writeLimits ?? []) {
    if (!request.writablePaths.includes(limit.path) || ![limit.maxFileBytes, limit.maxTotalBytes, limit.maxFiles, limit.maxEntries].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new ResearchProcessError('research_process_write_limit_invalid');
    }
  }
  if (request.writeLimits !== undefined) {
    try { await assertProcessWriteLimits(request.writeLimits); }
    catch { throw new ResearchProcessError('research_process_write_limit'); }
  }
  const profile = await researchSandboxProfile(request);
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, request.command, ...request.args], {
      cwd: request.cwd, env: request.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: string | null = null;
    let forcedKill: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let settling = false;
    let childError: Error | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') stopped = 'research_process_kill_failed';
      }
    };
    const stop = (code: string): void => {
      if (stopped !== null || settled || settling) return;
      stopped = code;
      kill('SIGTERM');
      forcedKill = setTimeout(() => kill('SIGKILL'), code === 'research_process_write_limit' ? 100 : 1000);
      forcedKill.unref();
    };
    let writeMonitor: ReturnType<typeof setTimeout> | undefined;
    let writeMonitorTask: Promise<void> | undefined;
    const monitorWrites = async (): Promise<void> => {
      if (settled || settling || stopped !== null || request.writeLimits === undefined) return;
      try {
        await assertProcessWriteLimits(request.writeLimits);
      } catch {
        stop('research_process_write_limit');
      }
      if (!settled && !settling && stopped === null) {
        writeMonitor = setTimeout(() => { writeMonitorTask = monitorWrites(); }, 100);
        writeMonitor.unref();
      }
    };
    if (request.writeLimits !== undefined) writeMonitorTask = monitorWrites();
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
      if (settled || settling) return;
      settling = true;
      const finalize = async (): Promise<void> => {
        kill('SIGKILL');
        clearTimeout(timeout);
        if (writeMonitor !== undefined) clearTimeout(writeMonitor);
        if (forcedKill !== undefined) clearTimeout(forcedKill);
        request.signal?.removeEventListener('abort', abort);
        if (writeMonitorTask !== undefined) {
          try { await writeMonitorTask; }
          catch { stopped = 'research_process_write_limit'; }
        }
        if (request.writeLimits !== undefined) {
          try { await assertProcessWriteLimits(request.writeLimits); }
          catch { stopped = 'research_process_write_limit'; }
        }
        settled = true;
        const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
        if (stopped !== null) reject(new ResearchProcessError(stopped, output.stdout, output.stderr));
        else if (error !== undefined) reject(new ResearchProcessError('research_process_spawn_failed', output.stdout, output.stderr));
        else resolve({ exitCode: code ?? 1, ...output });
      };
      void finalize().catch(() => {
        settled = true;
        reject(new ResearchProcessError('research_process_completion_failed'));
      });
    };
    child.on('error', (error) => { childError = error; });
    child.on('close', (code) => finish(code, childError));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop('research_process_input_failed');
    });
    child.stdin.end(request.input);
  });
}
