import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ToolResourceCoordinator, type ResearchProcessAdmissionRequest } from '../../services/deep-agent/tool-resource-coordinator';
import { assertResearchProcessResourceLimits,
  type ResearchProcessResourceLimits, type ResearchProcessResourceUsage } from './process-resources';
import { ResearchProcessError, runSupervisedResearchProcess, type ResearchProcessAdmission } from './process-supervision';
import { mainResourceActivity } from '../../services/resource-activity';
export { ResearchProcessError, type ResearchProcessAdmission } from './process-supervision';

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

export type ResearchProcessResult = { exitCode: number; stdout: string; stderr: string; resourceUsage: ResearchProcessResourceUsage; admission: ResearchProcessAdmission };
export type ResearchProcessWriteLimit = {
  path: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxEntries: number;
};

async function assertProcessWriteLimits(limits: readonly ResearchProcessWriteLimit[]): Promise<void> {
  const batchSize = process.env.ROC_PERF_PROCESS_SCAN_BATCH === '0' ? 1 : 8;
  type Observation =
    | { kind: 'stat'; path: string; info: import('node:fs').Stats }
    | { kind: 'error'; error: unknown }
    | { kind: 'entry-limit' };
  for (const limit of limits) {
    const rootInfo = await lstat(limit.path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('research_process_write_path_invalid');
    const root = await realpath(limit.path);
    const stack = [root];
    let entriesSeen = 0;
    let filesSeen = 0;
    let bytesSeen = 0;
    let pending: Promise<Observation>[] = [];
    const consume = async (): Promise<void> => {
      const observations = await Promise.all(pending);
      pending = [];
      // Completion order must not change traversal, budgets or error precedence.
      for (const observation of observations) {
        entriesSeen += 1;
        if (entriesSeen > limit.maxEntries || observation.kind === 'entry-limit') throw new Error('research_process_write_entry_limit');
        if (observation.kind === 'error') {
          if ((observation.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw observation.error;
        }
        const { info, path } = observation;
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
    };
    while (stack.length > 0) {
      const directory = stack.pop();
      if (directory === undefined) break;
      let readFailed = false;
      let readError: unknown;
      try {
        for await (const entry of await opendir(directory)) {
          const entryNumber = entriesSeen + pending.length + 1;
          if (entryNumber > limit.maxEntries) pending.push(Promise.resolve({ kind: 'entry-limit' }));
          else {
            const path = join(directory, entry.name);
            // Fresh observations on every scan. Catch each rejection immediately,
            // including lookahead entries beyond the first failing observation.
            pending.push(lstat(path).then<Observation, Observation>(
              info => ({ kind: 'stat', path, info }),
              error => ({ kind: 'error', error })
            ));
          }
          if (pending.length === batchSize || entryNumber > limit.maxEntries) await consume();
        }
      } catch (error) {
        readFailed = true;
        readError = error;
      }
      // Partial batches precede iterator/close errors just as in the serial scan.
      if (pending.length > 0) await consume();
      if (readFailed) throw readError;
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

export function setResearchProcessResourcePolicy(policy: { background: boolean; pressure: boolean }): void {
  processCoordinator.setResearchResourcePolicy(policy);
}

/** Browser-based research utilities share the same global process admission budget. */
export async function acquireResearchUtility(projectId: string, signal: AbortSignal) {
  const releaseActivity = mainResourceActivity.begin('research_process');
  try {
    const lease = await processCoordinator.acquireResearchProcess({projectId, priority: 'user', resourceClass: 'utility', gpu: false}, signal);
    return { ...lease, quarantine: () => processCoordinator.quarantineResearchProcesses(),
      release: () => { try { return lease.release(); } finally { releaseActivity(); } } };
  } catch (error) {
    releaseActivity();
    throw error;
  }
}

export async function runResearchProcess(request: ResearchProcessRequest): Promise<ResearchProcessResult> {
  assertResearchProcessResourceLimits(request.resourceLimits);
  const releaseActivity = mainResourceActivity.begin('research_process');
  try {
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
  } finally {
    releaseActivity();
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
  return await runSupervisedResearchProcess({ ...request,
    prepareProfile: () => researchSandboxProfile(request),
    auditWrites: () => assertProcessWriteLimits(request.writeLimits) });
}
