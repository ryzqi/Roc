import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {makeReport, readArguments, saveReport} from './report-lib.mjs';
import {summarizeUiRuns, uiScenarioIds} from './summarize-ui-runs.mjs';
import {benchmarkChildEnvironment} from './child-environment.mjs';
import {readChildReport} from './child-report.mjs';

assert.equal(process.platform, 'darwin', 'macos_required');
assert.equal(process.arch, 'arm64', 'arm64_required');
const options = readArguments('.artifacts/mac-performance/ui-workloads.json');
if (!process.argv.includes('--samples')) options.samples = 5;
assert.equal(options.idleMinutes, 0, 'ui_runner_does_not_measure_idle');
const output = resolve(options.outputPath);
assert.ok(!existsSync(output) && !existsSync(output.replace(/\.json$/u, '') + '.md'), 'ui_output_already_exists');
const appBuildDir = resolve('dist');
assert.ok(!existsSync(join(appBuildDir, 'renderer/.vite/profiling-build.json')), 'ui_runner_requires_ordinary_build');
const report = makeReport('macos-ui-workloads', {independentRuns: options.samples, buildMode: 'production',
  scenarioIds: uiScenarioIds, viewport: {width: 1440, height: 900}}, [
  'scripts/performance/bench-ui-workloads.mjs', 'scripts/performance/summarize-ui-runs.mjs',
  'scripts/performance/child-environment.mjs', 'scripts/performance/child-report.mjs',
  'scripts/performance/bench-macos-app.mjs', 'scripts/performance/renderer-workload-metrics.mjs',
  'scripts/performance/ui-workload-scenarios.mjs', 'tests/smoke/lib/performance-profile-seed.ts',
  'dist/renderer/.vite/manifest.json', 'dist/main/index.js', 'dist/preload/index.cjs']);
report.limitations.push(
  'Ordinary prebuilt production dist; each independent round uses a fresh app process and isolated profile. This runner does not build the app. OS filesystem caches remain warm.',
  'One aggregate sample per scenario per round. Twenty switches and individual RAF/input events inside a round are not independent runs. P50/P95 use nearest rank; with five rounds P95 is the maximum.',
  'frameIntervalMs and inputToSecondRafMs columns summarize per-round distribution statistics, not a pooled event distribution. Missing distributions remain null, with explicit missingSamples counts.',
  'Short CDP trace/RAF observers add overhead. RAF cadence is not compositor FPS; input-to-second-RAF is a paint opportunity proxy. Heap and DOM are point samples, not peak memory or proof of absence of leaks.',
  'No React profiling, 30-minute idle or sustained-stream claim. Synthetic local fixtures do not measure external model or scholarly services. Raw child reports remain embedded; temporary child JSON/Markdown and profiles are removed.');
report.runs = [];
report.completedRuns = 0;
report.status = 'incomplete';
const temporary = mkdtempSync(join(tmpdir(), 'roc-ui-workload-runs-'));
try {
  for (let iteration = 0; iteration < options.samples; iteration++) {
    const sample = join(temporary, `sample-${iteration}.json`);
    const env = benchmarkChildEnvironment(process.env, {ROC_PERF_APP_DIR: appBuildDir, ROC_PERF_REQUIRE_PROFILE: '0',
      ROC_PERF_UI_WORKLOADS: '1', ROC_PERF_STREAM_MINUTES: '0', ROC_PERF_IDLE_VISIBILITY: 'hidden', ROC_PERF_KEEP_ARTIFACTS: '0'});
    try {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, ['scripts/performance/bench-macos-app.mjs', sample, '--samples', '1', '--idle-minutes', '0'],
          {stdio: 'inherit', env});
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`ui_sample_failed:${iteration}:${code ?? signal}`)));
      });
      const evidence = readChildReport(sample);
      assert.ok(evidence.report !== null && evidence.reportReadError === undefined, 'ui_child_report_missing_or_invalid');
      const run = evidence.report;
      const scenarios = summarizeUiRuns([...report.runs, run]);
      report.runs.push(run);
      report.scenarios = scenarios;
      report.host.display = run.host.display;
      report.completedRuns = report.runs.length;
      report.status = report.completedRuns === options.samples ? 'complete' : 'incomplete';
      saveReport(output, report);
    } catch (error) {
      report.status = 'failed';
      const {report: sampleReport, ...evidence} = readChildReport(sample);
      report.failure = {iteration: iteration + 1, error: String(error), sample: sampleReport, ...evidence};
      saveReport(output, report);
      throw error;
    }
  }
  console.log(JSON.stringify({uiWorkloadsReport: output, completedRuns: report.completedRuns}));
} finally {rmSync(temporary, {recursive: true, force: true});}
