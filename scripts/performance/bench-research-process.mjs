import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeReport, protocol, readArguments, saveReport, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/process-before.json');
const sourcePath = resolve('src/main/plugins/research/process-runner.ts');
// Expose the existing private production scanner only in this disposable benchmark bundle.
const compiled = await build({ stdin: { contents: (await readFile(sourcePath, 'utf8')) + '\nexport { assertProcessWriteLimits };',
  resolveDir: resolve('src/main/plugins/research'), loader: 'ts' }, bundle: true, write: false, format: 'esm',
  platform: 'node', logLevel: 'silent' });
const { assertProcessWriteLimits } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const execute = promisify(execFile);
const report = makeReport('process-supervision', { ...protocol.process, samples: options.samples }, [sourcePath]);
const root = await mkdtemp(join(tmpdir(), 'roc-process-performance-'));
try {
  for (const count of protocol.process.files) {
    const directory = join(root, String(count));
    await mkdir(directory);
    for (let first = 0; first < count; first += 64) {
      await Promise.all(Array.from({ length: Math.min(64, count - first) }, (_, offset) =>
        writeFile(join(directory, String(first + offset)), Buffer.alloc(protocol.process.fileBytes))));
    }
    const rows = [];
    for (let iteration = 0; iteration < options.samples; iteration++) {
      const cpu = process.cpuUsage(), start = performance.now();
      await assertProcessWriteLimits([{ path: directory, maxFileBytes: 1024, maxTotalBytes: Math.max(1024, count * 256),
        maxFiles: Math.max(1, count), maxEntries: Math.max(1, count) }]);
      const scanMs = performance.now() - start, used = process.cpuUsage(cpu), psStart = performance.now();
      await execute('/bin/ps', ['-o', 'pid=,pgid=,rss=,time=', '-p', String(process.pid)], { maxBuffer: 1024 * 1024 });
      rows.push({ scanMs, psMs: performance.now() - psStart, scanCpuUserMicros: used.user, scanCpuSystemMicros: used.system,
        rssBytes: process.memoryUsage().rss });
    }
    report.scenarios.push({ id: String(count), summary: summarizeRows(rows), samples: rows });
    saveReport(options.outputPath, report);
    console.log(JSON.stringify({ files: count, summary: report.scenarios.at(-1).summary }));
  }
  report.limitations.push('Scanner/ps workload is warm isolated output, not a live writer. 100ms authority remains unchanged.',
    'Asynchronous lstat calls are measured in scan latency; syscall counts require the PR-09 instrumented scanner.');
  saveReport(options.outputPath, report);
} finally {
  await rm(root, { recursive: true, force: true });
}
