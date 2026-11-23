import assert from 'node:assert/strict';
import {summarize, summarizeRows} from '../report-lib.mjs';

/** Percentiles cover independent workload totals, never the retained slowest commit sample. */
export function summarizeProfileRuns(runs) {
  assert.ok(runs.length > 0,'profiling_runs_required');
  const first = runs[0];
  for (const run of runs) {
    assert.ok(run.failedWorkload === undefined && run.failure === undefined &&
      (run.status === undefined || run.status === 'complete'), 'profiling_run_failed_or_incomplete');
    assert.equal(run.kind, 'macos-app', 'profiling_kind_mismatch');
    assert.equal(run.fixture?.buildMode, 'react-production-profiling', 'profiling_build_mode_mismatch');
    assert.equal(run.fixture.samples, 1, 'profiling_child_samples_must_be_one');
    assert.equal(run.fixture.idleMinutes, 0, 'profiling_run_contains_idle');
    assert.equal(run.fixture.uiWorkloads?.sustainedStream, null, 'profiling_run_contains_soak');
    for (const key of ['protocolSha256', 'fixtureSha256']) {
      assert.ok(typeof run[key] === 'string' && run[key].length > 0, `profiling_identity_missing:${key}`);
      assert.equal(run[key], first[key], `profiling_identity_mismatch:${key}`);
    }
    for (const key of ['gitSha', 'sourceSha256', 'lockSha256']) {
      assert.ok(typeof run.source?.[key] === 'string' && run.source[key].length > 0, `profiling_source_missing:${key}`);
      assert.equal(run.source[key], first.source[key], `profiling_source_mismatch:${key}`);
    }
    assert.ok(run.host?.display !== null && run.host?.display !== undefined, 'profiling_display_missing');
    assert.deepEqual(run.host, first.host, 'profiling_host_mismatch');
    assert.deepEqual(run.fixture, first.fixture, 'profiling_fixture_mismatch');
    assert.deepEqual(run.rendererBuild, first.rendererBuild, 'profiling_renderer_build_mismatch');
  }
  const scenarios = runs.map(run=>run.scenarios.filter(scene=>scene.measurement?.buildMode === 'react-production-profiling'));
  const ids = scenarios[0].map(scene=>scene.id);
  assert.ok(ids.length > 0,'profiling_scenarios_missing');
  for (const scenes of scenarios) assert.deepEqual(scenes.map(scene=>scene.id),ids,'profiling_scenario_mismatch');
  return ids.map((id,index)=>{
    const profiles = scenarios.map(scenes=>scenes[index].measurement);
    const samples = profiles.map(({reactProfile,ipcProfile})=>{
      const root = reactProfile.boundaries.find(boundary=>boundary.id === 'root');
      assert.ok(root !== undefined && reactProfile.rootCommits > 0,'profiling_root_commits_missing');
      return {rootCommits:reactProfile.rootCommits, rootActualRenderMs:root.actualRenderMs,
        rootMaxActualRenderMs:root.maxActualRenderMs, ipcCalls:ipcProfile.calls};
    });
    const boundaryIds = [...new Set(profiles.flatMap(profile=>profile.reactProfile.boundaries.map(row=>row.id)))];
    const channelIds = [...new Set(profiles.flatMap(profile=>profile.ipcProfile.channels.map(row=>row.channel)))];
    return {id,samples,summary:summarizeRows(samples),
      boundaries:boundaryIds.map(boundary=>({id:boundary,
        ...Object.fromEntries(['commits','actualRenderMs','maxActualRenderMs'].map(key=>[key,
          summarize(profiles.map(profile=>profile.reactProfile.boundaries.find(row=>row.id===boundary)?.[key] ?? 0))]))})),
      ipcChannels:channelIds.map(channel=>({channel,
        ...Object.fromEntries(['calls','fulfilled','rejected','inFlight'].map(key=>[key,
          summarize(profiles.map(profile=>profile.ipcProfile.channels.find(row=>row.channel===channel)?.[key] ?? 0))]))})),
      profiles};
  });
}
