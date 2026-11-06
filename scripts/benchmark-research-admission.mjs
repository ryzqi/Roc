import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';
const { ToolResourceCoordinator } = await importTypeScriptModule('src/main/services/deep-agent/tool-resource-coordinator.ts', { platform: 'node' });
const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
assert.equal(process.platform, 'darwin', 'native_macos_benchmark_required');
const protocol = { samples: 3, projects: 6, jobs: 12, nativeHoldMs: 140, globalLimit: 2, projectLimit: 1, parseLimit: 1, gpuLimit: 1,
  priority: 'oldest eligible background yields to foreground once; no further eligible overtakes', starvationWaitTargetMs: 10_000 };
const request = (projectId, priority = 'user') => ({ projectId, priority, resourceClass: 'compute', gpu: false });
async function fairness() {
  const coordinator = new ToolResourceCoordinator(), order = [], observations = [], leases = [];
  const queue = (id, priority) => coordinator.acquireResearchProcess(request(id, priority), undefined, observation => observations.push({ id, ...observation }))
    .then(lease => { leases.push(lease); order.push(id); return lease; });
  try {
    const a = await queue('active-a', 'user'), b = await queue('active-b', 'user');
    const background = queue('background', 'background'), user1 = queue('user1', 'user'), user2 = queue('user2', 'user');
    await nextTurn(); a.release(); const first = await user1;
    const user3 = queue('user3', 'user'); first.release(); const oldest = await background;
    assert.deepEqual(order, ['active-a', 'active-b', 'user1', 'background']);
    oldest.release(); (await user2).release(); (await user3).release(); b.release();
    assert.equal(coordinator.researchProcesses.active, 0); assert.equal(coordinator.researchProcesses.queued, 0);
    const backgroundReceipt = observations.find(o => o.id === 'background');
    assert.ok(backgroundReceipt.waitMs < protocol.starvationWaitTargetMs);
    return { order, eligibleBackgroundOvertakes: 1, starvationDetected: false, observations };
  } finally { for (const lease of leases) lease.release(); }
}
const root = await mkdtemp('/private/tmp/roc-admission-benchmark-');
const controllers = [], pending = [];
const nativeSource = `#include <stdio.h>\n#include <unistd.h>\n#include <time.h>\n#include <stdlib.h>\ndouble stamp(){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000.0+t.tv_nsec/1000000.0;}\nint main(int n,char **v){if(n!=3)return 2;double start=stamp();usleep(atoi(v[2])*1000);printf("{\\"id\\":\\"%s\\",\\"startMs\\":%.3f,\\"endMs\\":%.3f}\\n",v[1],start,stamp());return 0;}\n`;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
function assertCapacity(rows, key, limit) {
  const selected = key === 'global' ? rows : rows.filter(r => key === 'parse' ? r.resourceClass === 'parse' : key === 'gpu' ? r.gpu : r.projectId === key);
  const events = selected.flatMap(r => [{ time: r.startMs, delta: 1 }, { time: r.endMs, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0, peak = 0; for (const event of events) { active += event.delta; peak = Math.max(peak, active); assert.ok(active <= limit, `${key}_capacity_exceeded`); }
  assert.equal(active, 0); return peak;
}
try {
  const source = join(root, 'probe.c'), executable = join(root, 'probe'); await writeFile(source, nativeSource);
  await promisify(execFile)('/usr/bin/clang', ['-O0', source, '-o', executable], { timeout: 30_000 });
  const samples = [];
  for (let sample = 0; sample < protocol.samples; sample++) {
    const jobs = Array.from({ length: protocol.jobs }, (_, i) => ({ id: `s${sample}-j${i}`, projectId: `project-${i % protocol.projects}`,
      priority: i % 3 === 0 ? 'background' : 'user', resourceClass: i % 3 === 0 ? 'parse' : 'compute', gpu: i % 4 === 0 }));
    const start = performance.now();
    const running = jobs.map(async job => {
      const controller = new AbortController(); controllers.push(controller);
      const result = await runResearchProcess({ command: executable, args: [job.id, String(protocol.nativeHoldMs)], cwd: root,
        readablePaths: [executable, '/usr/lib', '/System/Library'], writablePaths: [], writeLimits: [], environment: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000, maxOutputBytes: 4096, resourceLimits: { mode: 'monitored', cpuTimeMs: 5000, maxResidentBytes: 128 * 1024 * 1024 },
        admission: { projectId: job.projectId, priority: job.priority, resourceClass: job.resourceClass }, allowGpuAcceleration: job.gpu,
        networkAccess: 'none', signal: controller.signal });
      assert.equal(result.exitCode, 0); assert.ok(result.resourceUsage.samples > 0);
      const interval = JSON.parse(result.stdout); assert.equal(interval.id, job.id); assert.ok(interval.endMs > interval.startMs);
      return { ...job, ...interval, admission: result.admission, usage: result.resourceUsage };
    });
    pending.push(...running); const rows = await Promise.all(running);
    const peaks = { global: assertCapacity(rows, 'global', 2), parse: assertCapacity(rows, 'parse', 1), gpu: assertCapacity(rows, 'gpu', 1),
      projects: Object.fromEntries([...new Set(jobs.map(j => j.projectId))].map(id => [id, assertCapacity(rows, id, 1)])) };
    assert.equal(peaks.global, 2, 'unrelated_jobs_must_overlap');
    const maxWaitMs = Math.max(...rows.map(r => r.admission.waitMs)); assert.ok(maxWaitMs < protocol.starvationWaitTargetMs, 'bounded_fixture_starvation');
    const summary = { elapsedMs: performance.now() - start, waitP95Ms: p95(rows.map(r => r.admission.waitMs)), holdP95Ms: p95(rows.map(r => r.admission.holdMs)),
      maxWaitMs, starvationDetected: false, peaks };
    samples.push({ summary, rows }); console.log(JSON.stringify({ sample, ...summary }));
  }
  const paths = ['scripts/benchmark-research-admission.mjs', 'src/main/services/deep-agent/tool-resource-coordinator.ts', 'src/main/plugins/research/process-runner.ts'];
  const report = { contractVersion: 1, protocol, protocolSha256: createHash('sha256').update(JSON.stringify(protocol)).digest('hex'),
    nativeSourceSha256: createHash('sha256').update(nativeSource).digest('hex'),
    sourceHashes: Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
    hardware: { cpu: cpus()[0].model, memoryBytes: totalmem(), node: process.version, platform: process.platform, arch: process.arch },
    fairness: await fairness(), samples, limits: 'Finite native probes use real admission/sandbox/monitor/cleanup. parse/compute/GPU are admission classes; this does not measure parser, experiment or GPU throughput. Wait target is frozen for this bounded workload, not a universal scheduler deadline.' };
  const output = resolve(process.argv[2] ?? '.artifacts/research-optimization/admission-current.json'); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally { for (const controller of controllers) controller.abort(); await Promise.allSettled(pending); await rm(root, { recursive: true, force: true }); }
