import { spawn } from 'node:child_process';
import { terminateProcessTreeWithRetry } from '../../services/process-tree';
import { assertResearchProcessResourceLimits, ResearchProcessResourceMonitor,
  type ResearchProcessResourceLimits, type ResearchProcessResourceUsage } from './process-resources';
import { withResearchProcessGuard } from './process-guard';

export type ResearchProcessAdmission = { waitMs: number; holdMs: number };
export type ProcessSupervisionResult = { exitCode: number; stdout: string; stderr: string; resourceUsage: ResearchProcessResourceUsage };

export class ResearchProcessError extends Error {
  admission: ResearchProcessAdmission | null = null;
  constructor(readonly code: string, readonly stdout = '', readonly stderr = '', readonly resourceUsage: ResearchProcessResourceUsage | null = null) {
    super(code);
    this.name = 'ResearchProcessError';
  }
}

/** Internal supervision only. Each entry point supplies its own closed permission policy. */
export type ProcessSupervisionRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  resourceLimits: ResearchProcessResourceLimits;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  input?: string;
  maxOutputBytes?: number;
  prepareProfile: () => Promise<string>;
  auditWrites: () => Promise<void>;
};

export async function runSupervisedResearchProcess(request: ProcessSupervisionRequest): Promise<ProcessSupervisionResult> {
  assertResearchProcessResourceLimits(request.resourceLimits);
  if (process.platform !== 'darwin') throw new Error('research_runtime_macos_required');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('research_process_timeout_required');
  const terminationGraceMs = request.terminationGraceMs ?? 1000;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0) throw new Error('research_process_termination_grace_invalid');
  const limit = request.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('research_process_output_limit_invalid');
  if (request.signal?.aborted) throw new ResearchProcessError('research_process_cancelled');
  try { await request.auditWrites(); }
  catch { throw new ResearchProcessError('research_process_write_limit'); }
  const profile = await request.prepareProfile();
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
        await request.auditWrites();
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
        try { await request.auditWrites(); }
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
