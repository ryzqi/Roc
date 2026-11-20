import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/mac-chat-replay-after.json');
const legacy = process.env.ROC_PERF_REPLAY_IMPL === 'legacy';
const entry = legacy ? 'tests/fixtures/chat-replay-legacy.ts' : 'src/renderer/assistant/replay-tail-store.ts';
const fixture = { version: 1, createdAt: '2026-11-14T00:00:00.000Z', scenarios: [
  { id: 'completed-64-runs', stores: 1, runs: 64, events: 256, textBytes: 8192, completed: true },
  { id: 'active-over-10k', stores: 1, runs: 1, events: 12_050, textBytes: 1024, completed: false },
  { id: 'four-controllers', stores: 4, runs: 4, events: 2200, textBytes: 4096, completed: false }
] };
const report = makeReport('mac-chat-replay', fixture, [
  entry, 'src/renderer/assistant/use-chat-run.ts', 'scripts/performance/bench-chat-replay.mjs'
]);
report.implementation = legacy ? 'frozen-14b97220' : 'renderer-global-budget';
report.limitations.push(
  'storedBytes counts serialized UTF-8 event bytes, not V8 object overhead or exclusive physical footprint.',
  'heapUsedBytes is Chromium heap retained after explicit GC; rendererRssBytes is app.getAppMetrics workingSetSize.',
  'The queue runs in real Chromium. Hook recovery/visibility/transcript behavior is verified separately by Electron lifecycle tests.',
  'CPU, GPU/IOSurface and macOS physical footprint are unavailable in this focused cache benchmark.'
);
const dir = mkdtempSync(join(tmpdir(), 'roc-chat-replay-bench-'));
let app;
try {
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
      import { ReplayByteBudget, ChatReplayStore } from './${entry}';
      window.runCacheScenario = spec => {
        const budget = new ReplayByteBudget();
        const stores = Array.from({length: spec.stores}, () => new ChatReplayStore(budget));
        window.cacheStores = stores;
        window.cacheBudget = budget;
        window.encodingCalls = 0;
        let peakStoredBytes = 0;
        const started = performance.now();
        for (let run = 0; run < spec.runs; run++) {
          const runId = 'run-' + run, store = stores[run % stores.length];
          const remember = (sequence, event) => store.remember({
            runId, sequence, createdAt: '${fixture.createdAt}', event: {...event, runId}
          });
          remember(1, {type: 'run_started', threadId: 'thread', providerId: 'p', modelId: 'm', mode: 'chat', createdAt: '${fixture.createdAt}'});
          for (let index = 0; index < spec.events; index++) {
            const prefix = runId + '/' + index + ':';
            const text = prefix.padEnd(spec.textBytes, 'x');
            remember(index + 2, {type: 'assistant_block', block: {
              kind: index % 11 === 0 ? 'reasoning' : 'text', blockId: 'block-' + (index % 11), phase: 'delta', text
            }});
          }
          if (spec.completed) remember(spec.events + 2, {type: 'run_completed'});
          peakStoredBytes = Math.max(peakStoredBytes, budget.snapshot().storedBytes);
        }
        const elapsedMs = performance.now() - started;
        const encodingCalls = window.encodingCalls;
        const stats = stores.flatMap((store, index) => Array.from({length: spec.runs}, (_, run) =>
          run % spec.stores === index ? {runId:'run-' + run, ...store.stats('run-' + run)} : null).filter(Boolean));
        const tail = spec.id === 'active-over-10k' ? [...stores[0].events('run-0')] : null;
        return {elapsedMs, encodingCalls, peakStoredBytes, storedBytes: budget.snapshot().storedBytes,
          retainedEvents: stats.reduce((sum, tail) => sum + tail.eventCount, 0), stats, tail};
      };
      window.clearCacheScenario = () => {
        for (const store of window.cacheStores ?? []) store.clear();
        return window.cacheBudget.snapshot().storedBytes;
      };
    ` },
    outfile: join(dir, 'cache.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  writeFileSync(join(dir, 'index.html'), `<div></div><script>
    window.encodingCalls = 0;
    const NativeTextEncoder = TextEncoder;
    window.TextEncoder = class extends NativeTextEncoder {
      encode(value) { window.encodingCalls++; return super.encode(value); }
    };
  </script><script src="cache.js"></script>`);
  writeFileSync(join(dir, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show:false});
      window.loadFile(${JSON.stringify(join(dir, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(dir, 'main.cjs')] });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof runCacheScenario === 'function');
  const cdp = await page.context().newCDPSession(page);
  const pid = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
  for (const scene of fixture.scenarios) {
    const samples = [];
    let behaviorSha256 = null;
    for (let index = 0; index < options.samples; index++) {
      await cdp.send('HeapProfiler.collectGarbage');
      const result = await page.evaluate(spec => runCacheScenario(spec), scene);
      if (result.tail !== null) {
        const digest = sha256(JSON.stringify(result.tail));
        behaviorSha256 ??= digest;
        assert.equal(digest, behaviorSha256);
      }
      await cdp.send('HeapProfiler.collectGarbage');
      const heapUsedBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
      const rendererRssBytes = await app.evaluate(({app}, pid) =>
        (app.getAppMetrics().find(metric => metric.pid === pid)?.memory.workingSetSize ?? 0) * 1024, pid);
      const afterClearStoredBytes = await page.evaluate(() => clearCacheScenario());
      assert.equal(afterClearStoredBytes, 0);
      await cdp.send('HeapProfiler.collectGarbage');
      const heapAfterClearBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
      if (!legacy) assert.ok(result.storedBytes <= 24 * 1024 * 1024);
      const {tail, stats, ...metrics} = result;
      samples.push({...metrics, heapUsedBytes, heapAfterClearBytes, rendererRssBytes, afterClearStoredBytes});
      process.stdout.write(`${scene.id} ${index + 1}/${options.samples}: ${result.elapsedMs.toFixed(2)}ms, ${result.storedBytes} retained bytes\n`);
    }
    report.scenarios.push({id: scene.id, behaviorSha256, samples, summary: summarizeRows(samples)});
  }
  console.log(saveReport(options.outputPath, report));
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}
