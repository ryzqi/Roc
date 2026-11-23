import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {makeReport} from './report-lib.mjs';
import {assertOrdinaryBuild, readRepeatedArguments, runRepeatedWorkloads} from './repeated-workload-runner.mjs';
import {enduranceMinutes, pdfPageTurns} from './summarize-repeated-workloads.mjs';

assert.equal(process.platform, 'darwin', 'macos_required');
assert.equal(process.arch, 'arm64', 'arm64_required');
const options = readRepeatedArguments(process.argv.slice(2));
const appBuildDir = resolve('dist');
assertOrdinaryBuild(appBuildDir);
const report = makeReport(`macos-${options.workload}-repeated`, {independentRuns: options.samples, buildMode: 'production',
  workload: options.workload, childSamples: 1,
  ...(options.workload === 'endurance' ? {streamMinutes: enduranceMinutes, visibleIdleMinutes: enduranceMinutes,
    hiddenIdleMinutes: enduranceMinutes, order: ['visible-idle', 'hidden-idle', 'ui-and-sustained-stream']}
    : {pdfPages: 400, pageTurns: pdfPageTurns})}, [
  'scripts/performance/bench-repeated-workloads.mjs', 'scripts/performance/repeated-workload-runner.mjs',
  'scripts/performance/child-environment.mjs', 'scripts/performance/child-report.mjs',
  'scripts/performance/summarize-repeated-workloads.mjs', 'scripts/performance/summarize-ui-runs.mjs',
  'scripts/performance/report-lib.mjs', 'scripts/performance/bench-macos-app.mjs', 'scripts/performance/bench-pdf-reader.mjs',
  'scripts/performance/sustained-stream-scenario.mjs', 'scripts/performance/renderer-workload-metrics.mjs',
  'scripts/performance/ui-workload-scenarios.mjs', 'tests/smoke/lib/performance-profile-seed.ts',
  'dist/renderer/.vite/manifest.json', 'dist/main/index.js', 'dist/preload/index.cjs']);
report.limitations.push(
  'Ordinary prebuilt production dist only; no build or React profiling. Rounds run strictly serially in fresh child processes and isolated profiles. OS filesystem caches are not cleared.',
  'Endurance preserves the existing child order: 30 minutes visible idle, 30 minutes hidden idle, then the UI workloads and 30 minutes sustained streaming. Idle and streaming use separate child-managed application profiles; this is not one uninterrupted 90-minute session.',
  'PDF rounds each include 200 continuous page turns plus the existing open/close and background parse IPC workloads. Page turns within one round are not independent process samples.',
  'P50/P95 use nearest rank across completed independent rounds at the same named scenario/checkpoint. Per-round page/RAF/input/event-loop percentiles are summarized as per-round values, never pooled event distributions; absent distributions remain null with missingSamples counts.',
  'Five rounds have a nearest-rank P95 equal to their maximum. Trace/RAF observers add overhead; RAF is not compositor FPS. Heap, DOM and process metrics are sampled observations, not exclusive footprint or a leak verdict.',
  'rendererAppMetricsCpuPercentSum sums Electron app.getAppMetrics cpuPercent for processes with type Tab, preserving its native sampling interval and scale. It is not mainCpuOneCorePercent or a newly normalized one-core percentage. Missing Tab processes produce null CPU/working-set sums and a zero process count, never a zero utilization observation.',
  'Each raw child report is embedded. A failure stops further rounds, retains available partial reports and stderr, and marks the failed and not-run rounds explicitly. Only completed, comparable rounds enter the summary; partial sample counts are not five-round acceptance.',
  'Temporary child JSON/Markdown and child-managed profiles are removed after completion or ordinary failure. JSON and Markdown record status and completed round counts; performance values alone do not imply all requested rounds completed.');
await runRepeatedWorkloads({...options, appBuildDir, report});
console.log(JSON.stringify({repeatedWorkloadsReport: resolve(options.outputPath), completedRuns: report.completedRuns, status: report.status}));
