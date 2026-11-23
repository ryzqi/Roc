import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {buildProfilingApp} from './profiling/build-app.mjs';
import {summarizeProfileRuns} from './profiling/summarize-runs.mjs';
import {makeReport,readArguments,saveReport} from './report-lib.mjs';
import {benchmarkChildEnvironment} from './child-environment.mjs';
import {readChildReport} from './child-report.mjs';

assert.equal(process.platform,'darwin','macos_required');
assert.equal(process.arch,'arm64','arm64_required');
const options = readArguments('.artifacts/mac-performance/react-profile.json');
assert.equal(options.idleMinutes,0,'profiling_runner_does_not_measure_idle');
const output = resolve(options.outputPath);
assert.ok(!existsSync(output) && !existsSync(output.replace(/\.json$/u,'')+'.md'),'profiling_output_already_exists');
const build = buildProfilingApp();
try {
  const report = makeReport('macos-react-profiler',{independentRuns:options.samples,buildMode:'react-production-profiling',
    viewport:{width:1440,height:900}},[
    'electron.profiling.config.ts','scripts/performance/bench-react-profiler.mjs',
    'scripts/performance/child-environment.mjs','scripts/performance/child-report.mjs',
    'scripts/performance/profile-metrics.mjs','scripts/performance/renderer-workload-metrics.mjs',
    ...['build-app','build-plugin','collectors','preload-runtime','renderer-runtime','summarize-runs']
      .map(name=>`scripts/performance/profiling/${name}.mjs`),
    join(build.directory,'renderer/.vite/profiling-build.json'),join(build.directory,'renderer/.vite/manifest.json')]);
  report.limitations.push(
    'Dedicated production profiling build; React reconciler, stable boundary wrappers, preload IPC counters and workload observers add overhead. Ordinary production wall-clock/CPU/heap results remain separate.',
    'Each sample is a fresh isolated app profile and a full UI workload invocation. P50/P95 summarize per-run totals; the slowest eight callback records per boundary are bounded diagnostics, not a commit-duration distribution.',
    'actualRenderMs is inclusive React Profiler actualDuration render work, not commit-phase time. Nested boundaries overlap and must not be summed; baseDuration is an estimate.',
    'IPC counts cover exact renderer invoke starts in the workload interval, not incoming events or payload bytes. Fulfilled, rejected and pending calls are separate; application failures may resolve successfully.',
    'No 30-minute idle or sustained-stream claim is made by this instrumented hotspot run. Synthetic local fixtures do not measure external model or scholarly services.');
  report.runs = [];
  report.completedRuns = 0;
  report.status = 'incomplete';
  for (let iteration=0;iteration<options.samples;iteration++) {
    const sample = join(build.directory,`sample-${iteration}.json`);
    const env = benchmarkChildEnvironment(process.env, {ROC_PERF_APP_DIR:build.directory,ROC_PERF_REQUIRE_PROFILE:'1',
      ROC_PERF_UI_WORKLOADS:'1',ROC_PERF_STREAM_MINUTES:'0',ROC_PERF_IDLE_VISIBILITY:'hidden',ROC_PERF_KEEP_ARTIFACTS:'0'});
    try {
      await new Promise((done,reject)=>{
        const child = spawn(process.execPath,['scripts/performance/bench-macos-app.mjs',sample,'--samples','1','--idle-minutes','0'],
          {stdio:'inherit',env});
        child.once('error',reject);
        child.once('exit',(code,signal)=>code===0 ? done() : reject(new Error(`profiling_sample_failed:${iteration}:${code ?? signal}`)));
      });
      const evidence=readChildReport(sample);
      assert.ok(evidence.report!==null && evidence.reportReadError===undefined,'profiling_child_report_missing_or_invalid');
      const run=evidence.report;
      assert.equal(run.scenarios.filter(scene=>scene.measurement?.buildMode==='react-production-profiling').length,7,'profiling_workload_coverage');
      assert.ok(run.scenarios.some(scene=>scene.measurement?.ipcProfile?.calls > 0),'profiling_ipc_calls_missing');
      const summary = summarizeProfileRuns([...report.runs,run]);
      report.runs.push(run);
      report.scenarios = summary;
      report.host.display = run.host.display;
      report.completedRuns = report.runs.length;
      report.status = report.completedRuns === options.samples ? 'complete' : 'incomplete';
      saveReport(output,report);
    } catch (error) {
      report.status = 'failed';
      const {report:sampleReport,...evidence}=readChildReport(sample);
      report.failure = {iteration:iteration+1,error:String(error),sample:sampleReport,...evidence};
      saveReport(output,report);
      throw error;
    }
  }
  console.log(JSON.stringify({reactProfileReport:output,completedRuns:report.completedRuns}));
} finally {build.dispose();}
