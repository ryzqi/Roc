import { spawn } from 'node:child_process';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { terminateProcessTreeWithRetry } from '../../services/process-tree';
import { ToolResourceCoordinator, type ResearchProcessAdmissionRequest } from '../../services/deep-agent/tool-resource-coordinator';
import { assertResearchProcessResourceLimits, ResearchProcessResourceMonitor,
  type ResearchProcessResourceLimits, type ResearchProcessResourceUsage } from './process-resources';
import { withResearchProcessGuard } from './process-guard';

export type ResearchProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  resourceLimits: ResearchProcessResourceLimits;
  admission: Omit<ResearchProcessAdmissionRequest, 'gpu'>;
  terminationGraceMs?: number;
  allowGpuAcceleration: boolean;
  networkAccess: 'none';
  additionalExecutables?: readonly string[];
  signal?: AbortSignal;
  input?: string;
  maxOutputBytes?: number;
  writeLimits: readonly ResearchProcessWriteLimit[];
};

export type ResearchProcessAdmission = { waitMs: number; holdMs: number };
export type ResearchProcessResult = { exitCode: number; stdout: string; stderr: string; resourceUsage: ResearchProcessResourceUsage; admission: ResearchProcessAdmission };
export type ResearchProcessWriteLimit = {
  path: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxEntries: number;
};

export class ResearchProcessError extends Error {
  admission: ResearchProcessAdmission | null = null;
  constructor(readonly code: string, readonly stdout = '', readonly stderr = '', readonly resourceUsage: ResearchProcessResourceUsage | null = null) {
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

export async function researchSandboxProfile(request: Pick<ResearchProcessRequest, 'command' | 'readablePaths' | 'writablePaths' | 'allowGpuAcceleration' | 'networkAccess' | 'additionalExecutables'>): Promise<string> {
  if (typeof request.allowGpuAcceleration !== 'boolean') throw new Error('research_process_acceleration_policy_required');
  if (request.networkAccess !== 'none') throw new Error('research_process_network_policy_required');
  const filter = async (path: string): Promise<string> => {
    if (!isAbsolute(path)) throw new Error('research_process_absolute_path_required');
    const resolved = await realpath(path);
    const info = await stat(resolved);
    return `(${info.isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(resolved)})`;
  };
  const readable = await Promise.all([...request.readablePaths, request.command].map(filter));
  const writable = await Promise.all(request.writablePaths.map(filter));
  const executable = await Promise.all([request.command, ...(request.additionalExecutables ?? [])].map(filter));
  return [
    '(version 1)', '(deny default)', '(import "system.sb")',
    '(allow mach-bootstrap)', '(allow syscall*)', '(allow process-fork)',
    // Darwin SDK: setpgid=82、setsid=147、posix_spawn=244；阻止运行代码脱离受控进程组。
    '(deny syscall-unix (syscall-number 82 147 244))',
    `(allow process-exec ${executable.join(' ')})`, '(allow signal (target self) (target children))',
    '(allow mach-lookup)', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* ${[...readable, ...writable].join(' ')})`,
    `(allow file-map-executable ${readable.join(' ')})`,
    ...(writable.length === 0 ? [] : [`(allow file-write* ${writable.join(' ')})`]),
    '(deny file-write-create (subpath "/cores"))',
    '(allow ipc-posix-shm)', '(allow ipc-posix-sem)',
    // Jobs using the ORT CoreML provider need the Apple GPU/CoreML services. This permission is
    // opt-in per job; CPU inference and ordinary experiment jobs do not receive it.
    ...(request.allowGpuAcceleration ? ['(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "AGXDeviceUserClient" "IOGPUDeviceUserClient"))'] : [])
  ].join('\n');
}

const processCoordinator = new ToolResourceCoordinator();

/** Browser-based research utilities share the same global process admission budget. */
export async function acquireResearchUtility(projectId: string, signal: AbortSignal) {
  return processCoordinator.acquireResearchProcess({projectId, priority: 'user', resourceClass: 'utility', gpu: false}, signal);
}

export async function runResearchProcess(request: ResearchProcessRequest): Promise<ResearchProcessResult> {
  assertResearchProcessResourceLimits(request.resourceLimits);
  const lease = await processCoordinator.acquireResearchProcess({ ...request.admission, gpu: request.allowGpuAcceleration }, request.signal);
  try {
    const result = await runAdmittedResearchProcess(request);
    const observation = lease.release();
    return { ...result, admission: { waitMs: lease.waitMs, holdMs: observation.holdMs } };
  } catch (error) {
    if (error instanceof ResearchProcessError && (error.code === 'research_process_kill_failed' || error.code === 'research_process_supervision_failed')) processCoordinator.quarantineResearchProcesses();
    const observation = lease.release();
    if (error instanceof ResearchProcessError) error.admission = { waitMs: lease.waitMs, holdMs: observation.holdMs };
    throw error;
  }
}

async function runAdmittedResearchProcess(request: ResearchProcessRequest): Promise<Omit<ResearchProcessResult, 'admission'>> {
  if (process.platform !== 'darwin') throw new Error('research_runtime_macos_required');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('research_process_timeout_required');
  const terminationGraceMs = request.terminationGraceMs ?? 1000;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0) throw new Error('research_process_termination_grace_invalid');
  const limit = request.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('research_process_output_limit_invalid');
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  if (!Array.isArray(request.writeLimits)) throw new ResearchProcessError('research_process_write_limits_required');
  if (request.writeLimits.length !== request.writablePaths.length || new Set(request.writeLimits.map(limit => limit.path)).size !== request.writeLimits.length) {
    throw new ResearchProcessError('research_process_write_limit_invalid');
  }
  for (const limit of request.writeLimits) {
    if (!request.writablePaths.includes(limit.path) || ![limit.maxFileBytes, limit.maxTotalBytes, limit.maxFiles, limit.maxEntries].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new ResearchProcessError('research_process_write_limit_invalid');
    }
  }
  try { await assertProcessWriteLimits(request.writeLimits); }
  catch { throw new ResearchProcessError('research_process_write_limit'); }
  const profile = await researchSandboxProfile(request);
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  return withResearchProcessGuard((guard, removeGuard) => new Promise((resolve, reject) => {
    const child = spawn(guard, [String(process.pid), '/usr/bin/sandbox-exec', '-p', profile, request.command, ...request.args], {
      cwd: request.cwd, env: request.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });
    let computationPid: number | undefined;
    let computationExitCode: number | undefined;
    let control = '';
    let controlBytes = 0;
    let removal: Promise<void> = Promise.resolve();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: string | null = null;
    let forcedKill: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let settling = false;
    let childError: Error | undefined;
    const resourceMonitor = new ResearchProcessResourceMonitor();
    let resourceTimer: ReturnType<typeof setTimeout> | undefined;
    let resourceTask: Promise<void> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (computationPid === undefined) return;
      try {
        process.kill(-computationPid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Darwin can return EPERM while the signalled group dissolves. The
        // awaited final cleanup proves absence or reports a real kill failure.
        if (code !== 'ESRCH' && code !== 'EPERM') stopped = 'research_process_kill_failed';
      }
    };
    const stop = (code: string): void => {
      if (stopped !== null || settled || settling) return;
      stopped = code;
      kill('SIGTERM');
      const graceMs = code === 'research_process_write_limit' || code === 'research_process_cpu_limit' || code === 'research_process_memory_limit' || code === 'research_process_resource_monitor_failed' || code === 'research_process_output_limit'
        ? 100
        : code === 'research_process_cancelled' || code === 'research_process_timeout'
          ? terminationGraceMs
          : 1000;
      forcedKill = setTimeout(() => kill('SIGKILL'), graceMs);
      forcedKill.unref();
    };
    let writeMonitor: ReturnType<typeof setTimeout> | undefined;
    let writeMonitorTask: Promise<void>;
    const monitorWrites = async (): Promise<void> => {
      if (settled || settling || stopped !== null) return;
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
    writeMonitorTask = monitorWrites();
    const monitorResources = async (): Promise<void> => {
      if (settled || settling || stopped !== null) return;
      try {
        if (computationPid !== undefined) await resourceMonitor.sample(computationPid);
        if (settled || settling || child.exitCode !== null || child.signalCode !== null) return;
        const usage = resourceMonitor.usage();
        if (usage.observedCpuTimeMs !== null && usage.observedCpuTimeMs > request.resourceLimits.cpuTimeMs) stop('research_process_cpu_limit');
        else if (usage.peakResidentBytes !== null && usage.peakResidentBytes > request.resourceLimits.maxResidentBytes) stop('research_process_memory_limit');
      } catch {
        if (!settled && !settling && child.exitCode === null && child.signalCode === null) stop('research_process_resource_monitor_failed');
      }
      if (!settled && !settling && stopped === null) {
        resourceTimer = setTimeout(() => { resourceTask = monitorResources(); }, 100);
        resourceTimer.unref();
      }
    };
    resourceTask = monitorResources();
    const timeout = setTimeout(() => stop('research_process_timeout'), request.timeoutMs);
    timeout.unref();
    const abort = (): void => stop('research_process_cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const channel = child.stdio[3];
    if (channel === null || channel === undefined) throw new Error('research_process_control_pipe_required');
    channel.on('data', (chunk: Buffer) => {
      controlBytes += chunk.byteLength;
      if (controlBytes > 64) { stop('research_process_supervision_failed'); return; }
      control += chunk.toString('ascii');
      let newline: number;
      while ((newline = control.indexOf('\n')) !== -1) {
        const line = control.slice(0, newline);
        control = control.slice(newline + 1);
        if (computationPid === undefined && /^[1-9]\d*$/.test(line) && Number.isSafeInteger(Number(line)) && Number(line) > 1) {
          computationPid = Number(line);
          // The supervisor has initialized and armed both kernel watches.
          // Removing a signed binary during dyld startup can kill its loader.
          removal = removeGuard();
          void removal.catch(() => stop('research_process_guard_cleanup_failed'));
          if (stopped !== null) kill('SIGKILL');
        } else if (computationPid !== undefined && computationExitCode === undefined && /^exit \d+$/.test(line) && Number(line.slice(5)) <= 255) {
          computationExitCode = Number(line.slice(5));
        } else stop('research_process_supervision_failed');
      }
    });
    channel.on('error', () => stop('research_process_supervision_failed'));
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
        clearTimeout(timeout);
        if (resourceTimer !== undefined) clearTimeout(resourceTimer);
        if (writeMonitor !== undefined) clearTimeout(writeMonitor);
        if (forcedKill !== undefined) clearTimeout(forcedKill);
        request.signal?.removeEventListener('abort', abort);
        if (resourceTask !== undefined) await resourceTask;
        try { await writeMonitorTask; }
        catch { stopped = 'research_process_write_limit'; }
        try { await assertProcessWriteLimits(request.writeLimits); }
        catch { stopped = 'research_process_write_limit'; }
        try {
          await removal;
          await terminateProcessTreeWithRetry({ pid: computationPid }, 100, 10);
          await terminateProcessTreeWithRetry(child, 100, 10);
        }
        catch { stopped = 'research_process_kill_failed'; }
        settled = true;
        const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
        const resourceUsage = resourceMonitor.usage();
        if (stopped !== null) reject(new ResearchProcessError(stopped, output.stdout, output.stderr, resourceUsage));
        else if (error !== undefined) reject(new ResearchProcessError('research_process_spawn_failed', output.stdout, output.stderr, resourceUsage));
        else if (code !== 0 || computationPid === undefined || computationExitCode === undefined || control !== '') reject(new ResearchProcessError('research_process_supervision_failed', output.stdout,
          `${output.stderr}\nresearch_process_guard_exit:code=${code},signal=${child.signalCode}`, resourceUsage));
        else resolve({ exitCode: computationExitCode, ...output, resourceUsage });
      };
      void finalize().catch(() => {
        settled = true;
        reject(new ResearchProcessError('research_process_completion_failed'));
      });
    };
    child.on('error', (error) => { childError = error; });
    // The native supervisor cleans descendants when the computation leader exits,
    // even after host death. Also clean immediately if the supervisor itself exits.
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', (code) => finish(code, childError));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop('research_process_input_failed');
    });
    child.stdin.end(request.input);
  }));
}
