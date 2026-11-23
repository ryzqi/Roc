import assert from 'node:assert/strict';
import {createWriteStream, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {finished} from 'node:stream/promises';
import {summarize} from './report-lib.mjs';
import {beginRendererProfile, endRendererProfile} from './profile-metrics.mjs';

const categories = 'devtools.timeline,toplevel,blink.user_timing';
const taskNames = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);

/** Aggregate by thread until Chromium supplies thread_name metadata (often at trace end).
 * Only top-level tasks contribute to busy time; nested Layout/Paint totals are separate.
 * No argument payload, URL, document text or individual trace event is retained here.
 */
export function createTraceSummary() {
  const threads = new Map();
  let eventCount = 0;
  return {
    add(events) {
      for (const event of events) {
        eventCount++;
        const key = `${event.pid}:${event.tid}`;
        let thread = threads.get(key);
        if (thread === undefined) {
          thread = {pid: event.pid, tid: event.tid, name: null, taskCount: 0, busyMs: 0,
            longTaskCount: 0, longTaskMs: 0, longestTaskMs: 0, layoutMs: 0, paintMs: 0};
          threads.set(key, thread);
        }
        if (event.ph === 'M' && event.name === 'thread_name') thread.name = event.args?.name ?? null;
        if (event.ph !== 'X' || !Number.isFinite(event.dur) || event.dur < 0) continue;
        const ms = event.dur / 1000;
        if (taskNames.has(event.name)) {
          thread.taskCount++;
          thread.busyMs += ms;
          thread.longestTaskMs = Math.max(thread.longestTaskMs, ms);
          if (ms >= 50) {thread.longTaskCount++; thread.longTaskMs += ms;}
        }
        if (event.name === 'Layout') thread.layoutMs += ms;
        if (event.name === 'Paint') thread.paintMs += ms;
      }
    },
    finish() {
      const rendererThreads = [...threads.values()].filter(thread => thread.name === 'CrRendererMain');
      return {categories, eventCount, rendererThreads, rendererThreadCount: rendererThreads.length,
        taskCount: rendererThreads.reduce((sum, thread) => sum + thread.taskCount, 0),
        busyMs: rendererThreads.reduce((sum, thread) => sum + thread.busyMs, 0),
        longTaskCount: rendererThreads.reduce((sum, thread) => sum + thread.longTaskCount, 0),
        longTaskMs: rendererThreads.reduce((sum, thread) => sum + thread.longTaskMs, 0),
        longestTaskMs: Math.max(0, ...rendererThreads.map(thread => thread.longestTaskMs)),
        layoutMs: rendererThreads.reduce((sum, thread) => sum + thread.layoutMs, 0),
        paintMs: rendererThreads.reduce((sum, thread) => sum + thread.paintMs, 0)};
    }
  };
}

export async function rendererSnapshot(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    const {metrics} = await cdp.send('Performance.getMetrics');
    const measured = Object.fromEntries(metrics.map(({name, value}) => [name, value]));
    const snapshot = {heapUsedBytes: measured.JSHeapUsedSize, heapTotalBytes: measured.JSHeapTotalSize,
      domNodes: measured.Nodes, documents: measured.Documents};
    assert.ok(Object.values(snapshot).every(Number.isFinite), 'renderer_metrics_missing');
    return snapshot;
  } finally {await cdp.detach();}
}

/** Short, explicitly instrumented workload. Never wrap a 30-minute idle interval:
 * RAF observers themselves prevent an idle Renderer. Raw export is opt-in and synthetic-only.
 */
export async function measureRendererWorkload(page, action, {rawTracePath = null} = {}) {
  const cdp = await page.context().newCDPSession(page);
  const aggregate = createTraceSummary();
  let raw = null, firstRawEvent = true, tracing = false, frames = null;
  const receive = ({value}) => {
    aggregate.add(value);
    if (raw !== null && value.length > 0) {
      raw.write(`${firstRawEvent ? '' : ','}${value.map(event => JSON.stringify(event)).join(',')}`);
      firstRawEvent = false;
    }
  };
  let before, started, result, profile = null, profilingStarted = false;
  try {
    if (rawTracePath !== null) {
      mkdirSync(dirname(rawTracePath), {recursive: true});
      raw = createWriteStream(rawTracePath, {flags: 'wx'});
      // Attach immediately so an output error cannot become an unhandled event.
      raw.on('error', () => {});
      raw.write('{"traceEvents":[');
    }
    cdp.on('Tracing.dataCollected', receive);
    before = await rendererSnapshot(page);
    started = performance.now();
    await cdp.send('Tracing.start', {categories, transferMode: 'ReportEvents'});
    tracing = true;
    await page.evaluate(() => {
      const sample = {intervals: [], inputs: [], previous: null, handle: 0};
      const tick = now => {
        if (sample.previous !== null) sample.intervals.push(now - sample.previous);
        sample.previous = now;
        sample.handle = requestAnimationFrame(tick);
      };
      sample.handle = requestAnimationFrame(tick);
      const onInput = event => {
        const started = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => sample.inputs.push({type: event.type, ms: performance.now() - started})));
      };
      const types = ['input', 'keydown', 'pointerdown'];
      for (const type of types) document.addEventListener(type, onInput, {capture: true, passive: true});
      window.__rocEndWorkload = () => {
        cancelAnimationFrame(sample.handle);
        for (const type of types) document.removeEventListener(type, onInput, true);
        delete window.__rocEndWorkload;
        return {intervals: sample.intervals, inputs: sample.inputs};
      };
    });
    profilingStarted = await beginRendererProfile(page, 'renderer-workload', {required:process.env.ROC_PERF_REQUIRE_PROFILE === '1'});
    result = await action();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  } finally {
    try {
      try {
        if (!page.isClosed()) {
          try {if (profilingStarted) profile = await endRendererProfile(page);}
          finally {frames = await page.evaluate(() => window.__rocEndWorkload?.() ?? null);}
        }
      } finally {
        if (tracing) {
          let timer, completed;
          const complete = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('renderer_trace_complete_timeout')), 30_000);
            completed = resolve;
            cdp.once('Tracing.tracingComplete', completed);
          });
          try {await Promise.all([cdp.send('Tracing.end'), complete]);}
          finally {clearTimeout(timer); cdp.off('Tracing.tracingComplete', completed);}
        }
      }
    } finally {
      cdp.off('Tracing.dataCollected', receive);
      try {await cdp.detach();}
      finally {if (raw !== null) {raw.end(']}\n'); await finished(raw);}}
    }
  }
  const elapsedMs = performance.now() - started;
  const trace = aggregate.finish();
  assert.ok(trace.eventCount > 0 && trace.rendererThreadCount > 0, 'renderer_trace_missing');
  const intervals = frames?.intervals ?? [];
  const inputs = frames?.inputs ?? [];
  return {result, elapsedMs, before, after: await rendererSnapshot(page), trace, rawTracePath,
    frameIntervalMs: intervals.length === 0 ? null : summarize(intervals),
    observedRafHz: intervals.length === 0 ? null : intervals.length * 1000 / intervals.reduce((sum, ms) => sum + ms, 0),
    inputToSecondRafMs: inputs.length === 0 ? null : summarize(inputs.map(input => input.ms)),
    inputSamples: inputs,
    ...(profile ?? {}),
    measurement: 'Instrumented CDP complete task events on CrRendererMain; nested Layout/Paint are inclusive separate totals. RAF cadence is not compositor FPS. Input to second RAF is a paint-opportunity proxy, not EventTiming or display presentation latency.'};
}
