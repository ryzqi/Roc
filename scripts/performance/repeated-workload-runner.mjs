import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {saveReport} from './report-lib.mjs';
import {enduranceMinutes, pdfPageTurns, summarizeRepeatedWorkloads} from './summarize-repeated-workloads.mjs';
import {benchmarkChildEnvironment} from './child-environment.mjs';
import {readChildReport} from './child-report.mjs';

export function readRepeatedArguments(arguments_) {
  const args = [...arguments_];
  const outputPath = args.shift();
  assert.ok(typeof outputPath === 'string' && !outputPath.startsWith('--') && outputPath.endsWith('.json'), 'repeat_new_json_output_required');
  const options = {outputPath, samples: 5, workload: null}, seen = new Set();
  while (args.length > 0) {
    const name = args.shift(), value = args.shift();
    assert.ok(!seen.has(name), `repeat_option_duplicate:${name}`);
    seen.add(name);
    if (name === '--samples') {
      options.samples = Number(value);
      assert.ok(typeof value === 'string' && /^\d+$/u.test(value) && Number.isSafeInteger(options.samples) && options.samples > 0,
        'repeat_samples_invalid');
    } else if (name === '--workload') {
      assert.ok(['endurance', 'pdf'].includes(value), 'repeat_workload_invalid');
      options.workload = value;
    } else throw new Error(`repeat_option_unknown:${name}`);
  }
  assert.ok(options.workload !== null, 'repeat_workload_required');
  return options;
}

export function assertOrdinaryBuild(appBuildDir) {
  assert.ok(!existsSync(join(appBuildDir, 'renderer/.vite/profiling-build.json')), 'repeat_requires_ordinary_build');
  for (const file of ['main/index.js', 'preload/index.cjs', 'renderer/index.html', 'renderer/.vite/manifest.json']) {
    assert.ok(existsSync(join(appBuildDir, file)), `repeat_build_missing:${file}`);
  }
}

export function repeatedChildEnvironment(workload, environment, appBuildDir) {
  assert.ok(['endurance', 'pdf'].includes(workload), 'repeat_workload_invalid');
  return benchmarkChildEnvironment(environment, {ROC_PERF_APP_DIR: appBuildDir, ROC_PERF_REQUIRE_PROFILE: '0', ROC_PERF_KEEP_ARTIFACTS: '0',
    ROC_PERF_UI_WORKLOADS: workload === 'endurance' ? '1' : '0',
    ROC_PERF_STREAM_MINUTES: workload === 'endurance' ? String(enduranceMinutes) : '0',
    ROC_PERF_IDLE_VISIBILITY: workload === 'endurance' ? 'both' : 'hidden',
    ROC_PERF_PDF_PAGE_TURNS: workload === 'pdf' ? String(pdfPageTurns) : '0'});
}

async function spawnChild({args, env}) {
  return await new Promise((resolve_, reject) => {
    const child = spawn(process.execPath, args, {stdio: ['ignore', 'inherit', 'pipe'], env});
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-16_384);
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    // close follows stdio drainage and process exit: no next round overlaps this one.
    child.once('close', (exitCode, signal) => resolve_({exitCode, signal, stderrTail}));
  });
}

/** The CLI supplies provenance; dependency injection permits lifecycle tests without Electron. */
export async function runRepeatedWorkloads({outputPath, workload, samples, appBuildDir, report},
  {executeChild = spawnChild, environment = process.env} = {}) {
  assert.ok(['endurance', 'pdf'].includes(workload), 'repeat_workload_invalid');
  assert.ok(Number.isSafeInteger(samples) && samples > 0, 'repeat_samples_invalid');
  const output = resolve(outputPath);
  assert.ok(output.endsWith('.json'), 'repeat_new_json_output_required');
  assert.ok(!existsSync(output) && !existsSync(output.replace(/\.json$/u, '') + '.md'), 'repeat_output_already_exists');
  report.status = 'incomplete';
  report.completedRuns = 0;
  report.runs = Array.from({length: samples}, (_, index) => ({iteration: index + 1, status: 'not_run', report: null}));
  const persist = () => saveReport(output, {...report, limitations: [
    `Run status: ${report.status}. Completed independent rounds: ${report.completedRuns}/${samples}.` +
      (report.failure === undefined ? '' : ` Failed round: ${report.failure.iteration}; ${report.failure.error}`),
    ...report.limitations]});
  const temporary = mkdtempSync(join(tmpdir(), `roc-${workload}-runs-`));
  try {
    persist();
    for (const attempt of report.runs) {
      const samplePath = join(temporary, `sample-${attempt.iteration}.json`);
      const script = `scripts/performance/${workload === 'endurance' ? 'bench-macos-app' : 'bench-pdf-reader'}.mjs`;
      const args = [script, samplePath, '--samples', '1', ...(workload === 'endurance' ? ['--idle-minutes', String(enduranceMinutes)] : [])];
      attempt.status = 'running';
      persist();
      try {
        attempt.process = await executeChild({args, env: repeatedChildEnvironment(workload, environment, appBuildDir),
          outputPath: samplePath, iteration: attempt.iteration});
        Object.assign(attempt, readChildReport(samplePath));
        assert.equal(attempt.process.exitCode, 0, `repeat_child_failed:${attempt.iteration}:${attempt.process.exitCode ?? attempt.process.signal}`);
        assert.ok(attempt.report !== null && attempt.reportReadError === undefined, 'repeat_child_report_missing_or_invalid');
        const completed = report.runs.filter(run => run.status === 'complete').map(run => run.report);
        report.scenarios = summarizeRepeatedWorkloads(workload, [...completed, attempt.report]);
        report.host.display = attempt.report.host.display;
        attempt.status = 'complete';
        report.completedRuns++;
        report.status = report.completedRuns === samples ? 'complete' : 'incomplete';
        persist();
      } catch (error) {
        if (attempt.report === null && attempt.reportReadError === undefined) Object.assign(attempt, readChildReport(samplePath));
        attempt.status = 'failed';
        attempt.error = String(error);
        report.status = 'failed';
        report.failure = {iteration: attempt.iteration, error: String(error)};
        persist();
        throw error;
      }
    }
    return report;
  } finally {rmSync(temporary, {recursive: true, force: true});}
}
