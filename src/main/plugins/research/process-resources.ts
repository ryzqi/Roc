import { execFile } from 'node:child_process';
import type { ResearchProcessResourceUsage } from '../../../shared/schemas/research-process-resources';
export type { ResearchProcessResourceUsage } from '../../../shared/schemas/research-process-resources';

export type ResearchProcessResourceLimits = {
  mode: 'monitored' | 'hard';
  cpuTimeMs: number;
  maxResidentBytes: number;
};

type ProcessSample = { identity: string; cpuTimeMs: number; residentBytes: number };

export function assertResearchProcessResourceLimits(limits: ResearchProcessResourceLimits): void {
  if (limits.mode === 'hard') throw new Error('research_process_hard_limits_unsupported');
  if (limits.mode !== 'monitored' || ![limits.cpuTimeMs, limits.maxResidentBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('research_process_resource_limits_invalid');
  }
}

/** macOS ps reports user + system CPU time and RSS in 1024-byte units. */
export function parseResearchProcessSamples(output: string, groupId: number): ProcessSample[] {
  return output.split('\n').filter(line => line.trim().length > 0).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+((?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null || Number(match[2]) !== groupId) throw new Error('research_process_resource_sample_invalid');
    const days = Number(match[4] ?? 0), hours = Number(match[5] ?? 0), minutes = Number(match[6]), seconds = Number(match[7]);
    const cpuTimeMs = ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000 + Number(`0.${match[8] ?? '0'}`) * 1000;
    const residentBytes = Number(match[9]) * 1024;
    if (![Number(match[1]), cpuTimeMs, residentBytes].every(value => Number.isSafeInteger(value) && value >= 0) || minutes > 59 && match[5] !== undefined || seconds > 59) {
      throw new Error('research_process_resource_sample_invalid');
    }
    return { identity: `${match[1]}:${match[10]}`, cpuTimeMs, residentBytes };
  });
}

export class ResearchProcessResourceMonitor {
  private readonly cpuHighWater = new Map<string, number>();
  private samples = 0;
  private peakResidentBytes = 0;

  record(output: string, groupId: number): void {
    const processes = parseResearchProcessSamples(output, groupId);
    if (processes.length === 0) return;
    let residentBytes = 0;
    for (const sample of processes) {
      this.cpuHighWater.set(sample.identity, Math.max(this.cpuHighWater.get(sample.identity) ?? 0, sample.cpuTimeMs));
      residentBytes += sample.residentBytes;
    }
    if (this.cpuHighWater.size > 8192 || !Number.isSafeInteger(residentBytes)) throw new Error('research_process_resource_sample_limit');
    this.samples += 1;
    this.peakResidentBytes = Math.max(this.peakResidentBytes, residentBytes);
  }

  usage(): ResearchProcessResourceUsage {
    return {
      mode: 'monitored', sampleIntervalMs: 100, samples: this.samples,
      observedCpuTimeMs: this.samples === 0 ? null : [...this.cpuHighWater.values()].reduce((sum, value) => sum + value, 0),
      peakResidentBytes: this.samples === 0 ? null : this.peakResidentBytes
    };
  }

  async sample(groupId: number): Promise<void> {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('/bin/ps', ['-g', String(groupId), '-o', 'pid=,pgid=,time=,rss=,lstart='], {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, encoding: 'utf8', maxBuffer: 512 * 1024, timeout: 1000, killSignal: 'SIGKILL'
      }, (error, stdout) => {
        if (error === null) resolve(stdout);
        else if ('code' in error && error.code === 1 && stdout.trim().length === 0) {
          try { process.kill(-groupId, 0); reject(error); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === 'ESRCH') resolve('');
            else reject(probe);
          }
        } else reject(error);
      });
    });
    this.record(output, groupId);
  }
}
