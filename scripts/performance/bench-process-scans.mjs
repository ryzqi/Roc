import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeReport, protocol, readArguments, saveReport, summarizeRows } from './report-lib.mjs';

const legacy = process.argv.includes('--legacy');
const paired = process.argv.includes('--paired');
process.argv = process.argv.filter(argument => argument !== '--legacy' && argument !== '--paired');
const options = readArguments('.artifacts/mac-performance/process-scans.json');
const sourcePath = resolve(legacy ? 'tests/fixtures/process-write-limits-legacy.ts' : 'src/main/plugins/research/process-runner.ts');
const paths = paired ? [resolve('tests/fixtures/process-write-limits-legacy.ts'), resolve('src/main/plugins/research/process-runner.ts')] : [sourcePath];
const key = 'roc.performance.process-scan';
async function compile(path, profile) {
  const frozen = path.includes('legacy'), source = await readFile(path, 'utf8');
  const compiled = await build({
    stdin: { contents: source + (frozen ? '' : '\nexport { assertProcessWriteLimits };'),
      resolveDir: resolve(frozen ? 'tests/fixtures' : 'src/main/plugins/research'), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: profile ? [{
      name: 'scan-observation',
      setup(builder) {
        builder.onResolve({ filter: /^node:fs\/promises$/ }, args => args.namespace === 'scan-observation'
          ? { path: args.path, external: true } : { path: args.path, namespace: 'scan-observation' });
        builder.onLoad({ filter: /.*/, namespace: 'scan-observation' }, () => ({ contents: `
          import * as fs from 'node:fs/promises';
          export * from 'node:fs/promises';
          export async function lstat(path) {
            const m = globalThis[Symbol.for('${key}')];
            const start = performance.now();
            m.lstatCalls++; m.active++; m.maxActive = Math.max(m.maxActive, m.active);
            try {
              const info = await fs.lstat(path);
              if (info.isFile()) { m.files++; m.bytes += info.size; }
              return info;
            } finally { m.active--; m.lstatMs += performance.now() - start; }
          }
          export async function opendir(path) {
            const m = globalThis[Symbol.for('${key}')], start = performance.now();
            m.opendirCalls++;
            try { return await fs.opendir(path); }
            finally { m.opendirMs += performance.now() - start; }
          }`, loader: 'js' }));
      }
    }] : []
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)).assertProcessWriteLimits;
}
const scanners = await Promise.all(paths.map(async path => ({ scan: await compile(path, false), profileScan: await compile(path, true) })));
const execute = promisify(execFile);
const fixture = { ...protocol.process, samples: options.samples,
  writer: { files: 1000, fileBytes: 256, concurrentWrites: 64, mode: 'continuous-in-place' } };
const reports = paths.map(path => makeReport('process-scans', fixture, [path]));
const outputPaths = paired ? ['before', 'after'].map(suffix => options.outputPath.replace(/\.json$/, `-${suffix}.json`)) : [options.outputPath];
const root = await mkdtemp(join(tmpdir(), 'roc-process-scans-'));
let writer;
try {
  for (const count of [...protocol.process.files, 'live-writer']) {
    const live = count === 'live-writer', files = live ? fixture.writer.files : count;
    const directory = join(root, String(count));
    await mkdir(directory);
    for (let first = 0; first < files; first += 64) {
      await Promise.all(Array.from({ length: Math.min(64, files - first) }, (_, offset) =>
        writeFile(join(directory, String(first + offset)), Buffer.alloc(256))));
    }
    if (live) {
      const code = `
        const fs = require('node:fs/promises'), path = require('node:path');
        const directory = process.argv[1], bytes = Buffer.alloc(256, 42);
        let writes = 0, stopped = false;
        process.on('SIGTERM', () => { stopped = true; });
        (async () => {
          process.stdout.write('ready\\n');
          while (!stopped) {
            await Promise.all(Array.from({length:64}, (_, i) => fs.writeFile(path.join(directory, String((writes+i)%1000)), bytes)));
            writes += 64;
          }
          process.stdout.write(JSON.stringify({writes})+'\\n');
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
      writer = spawn(process.execPath, ['-e', code, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      writer.closed = new Promise(resolveStopped => writer.once('close', resolveStopped));
      await new Promise((resolveReady, reject) => {
        writer.stdout.once('data', resolveReady);
        writer.once('error', reject);
        writer.once('exit', code => { if (code !== null) reject(new Error(`writer_early_exit:${code}`)); });
      });
    }
    const limits = [{ path: directory, maxFileBytes: 1024, maxTotalBytes: Math.max(1024, files * 256),
      maxFiles: Math.max(1, files), maxEntries: Math.max(1, files) }];
    const allRows = paths.map(() => []), allPhases = paths.map(() => []);
    for (let iteration = 0; iteration < options.samples; iteration++) {
      const order = paired && iteration % 2 ? [1, 0] : paths.map((_, index) => index);
      for (const index of order) {
        const { scan, profileScan } = scanners[index];
        const timerStart = performance.now();
        const timer = new Promise(resolveTimer => setTimeout(() => resolveTimer(performance.now() - timerStart), 0));
        const cpu = process.cpuUsage(), start = performance.now();
        await scan(limits);
        const scanMs = performance.now() - start, used = process.cpuUsage(cpu), eventLoopMs = await timer;
        const metrics = { lstatCalls: 0, opendirCalls: 0, lstatMs: 0, opendirMs: 0, active: 0, maxActive: 0, files: 0, bytes: 0 };
        globalThis[Symbol.for(key)] = metrics;
        const profileStart = performance.now();
        await profileScan(limits);
        allPhases[index].push({ ...metrics, scanMs: performance.now() - profileStart });
        assert.equal(metrics.active, 0);
        if (!live) { assert.equal(metrics.files, files); assert.equal(metrics.bytes, files * 256); }
        const psStart = performance.now();
        await execute('/bin/ps', ['-o', 'pid=,pgid=,rss=,time=', '-p', String(process.pid)], { maxBuffer: 1024 * 1024 });
        allRows[index].push({ scanMs, eventLoopMs, psMs: performance.now() - psStart, scanCpuUserMicros: used.user,
          scanCpuSystemMicros: used.system, rssBytes: process.memoryUsage().rss,
          lstatCalls: metrics.lstatCalls, opendirCalls: metrics.opendirCalls });
      }
    }
    for (const [index, report] of reports.entries()) {
      report.scenarios.push({ id: String(count), summary: summarizeRows(allRows[index]), samples: allRows[index], phaseProfiles: allPhases[index] });
      saveReport(outputPaths[index], report);
      console.log(JSON.stringify({ files: count, path: paths[index], summary: report.scenarios.at(-1).summary }));
    }
    if (writer) {
      const activeWriter = writer;
      const stopped = activeWriter.closed;
      activeWriter.kill('SIGTERM'); await stopped; writer = undefined;
    }
  }
  for (const [index, report] of reports.entries()) {
    report.limitations.push(
    'Uninstrumented scan latency/CPU and separately instrumented opendir/lstat phases are distinct observations.',
    'lstatMs is the sum of asynchronous waits, not wall time or syscall CPU. Parallel waits overlap.',
    'Fresh lstat/opendir call counts are retained; bounded parallelism reduces sequential wait rounds, not authoritative checks.',
    'Live writer continuously truncates/overwrites the same 1000 files; transient sizes are allowed and not a frozen corpus hash.',
    'RSS is the benchmark process resident set, not macOS exclusive physical footprint; GPU/IOSurface/footprint are N/A.',
    'The production post-scan and ps sample timers remain independent at 100ms; no lower-frequency replacement.',
      ...(paired ? ['Frozen/current scans alternate within each sample on the same directory and live writer. Original separate-run reports remain.'] : [])
    );
    saveReport(outputPaths[index], report);
  }
} finally {
  if (writer) {
    const stopped = writer.closed;
    writer.kill('SIGTERM'); await stopped;
  }
  delete globalThis[Symbol.for(key)];
  await rm(root, { recursive: true, force: true });
}
