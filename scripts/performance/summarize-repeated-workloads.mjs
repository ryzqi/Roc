import assert from 'node:assert/strict';
import {summarize} from './report-lib.mjs';
import {rendererWorkloadSample, uiScenarioIds} from './summarize-ui-runs.mjs';
import {sustainedStreamConfig} from './sustained-stream-scenario.mjs';

export const enduranceMinutes = 30;
export const pdfPageTurns = 200;
const streamConfig = sustainedStreamConfig(String(enduranceMinutes));
const streamIds = streamConfig.checkpointMinutes.map(minutes => `history-5000-sustained-${minutes}m`);
const startupIds = ['events-0', 'events-1000', 'events-10000'];
const pdfId = `400-page-${pdfPageTurns}-continuous-turns`;
const finite = (value, name) => {
  assert.ok(Number.isFinite(value) && value >= 0, `repeat_metric_invalid:${name}`);
  return value;
};
const optional = (value, name) => value === null ? null : finite(value, name);

function scenes(run, expected) {
  assert.ok(Array.isArray(run.scenarios), 'repeat_scenarios_missing');
  assert.deepEqual(run.scenarios.map(scene => scene.id).sort(), [...expected].sort(), 'repeat_scenario_mismatch');
  return new Map(run.scenarios.map(scene => [scene.id, scene]));
}

function processSample(value) {
  const row = {};
  for (const name of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
    row[`main.${name}Bytes`] = finite(value.main?.[name], name);
  }
  row.mainPrivateMemoryBytes = finite(value.mainPrivateMemoryBytes, 'mainPrivateMemoryBytes');
  assert.ok(Array.isArray(value.processes) && value.processes.length > 0, 'repeat_process_samples_missing');
  row.processWorkingSetSumBytes = value.processes.reduce((sum, process) => sum + finite(process.workingSetBytes, 'workingSetBytes'), 0);
  const renderers = value.processes.filter(process => process.type === 'Tab');
  row.rendererProcessCount = renderers.length;
  row.rendererAppMetricsCpuPercentSum = renderers.length === 0 ? null :
    renderers.reduce((sum, process) => sum + finite(process.cpuPercent, 'renderer.cpuPercent'), 0);
  row.rendererWorkingSetBytesSum = renderers.length === 0 ? null :
    renderers.reduce((sum, process) => sum + finite(process.workingSetBytes, 'renderer.workingSetBytes'), 0);
  for (const name of ['p50Ms', 'p95Ms', 'maxMs']) {
    row[`eventLoopDelay.${name}`] = value.eventLoopDelay === null ? null : finite(value.eventLoopDelay?.[name], name);
  }
  return row;
}

function enduranceSamples(run) {
  assert.equal(run.kind, 'macos-app', 'repeat_kind_mismatch');
  assert.equal(run.fixture?.buildMode, 'production', 'repeat_requires_production');
  assert.equal(run.fixture?.samples, 1, 'repeat_child_samples_must_be_one');
  assert.equal(run.fixture.idleMinutes, enduranceMinutes, 'repeat_idle_duration_mismatch');
  assert.equal(run.fixture.idleVisibility, 'both', 'repeat_idle_visibility_mismatch');
  assert.deepEqual(run.fixture.uiWorkloads?.sustainedStream, streamConfig, 'repeat_stream_config_mismatch');
  const byId = scenes(run, [...startupIds, ...uiScenarioIds, ...streamIds]);
  const stream = run.sustainedStream;
  assert.deepEqual(stream?.config, streamConfig, 'repeat_stream_config_mismatch');
  assert.equal(stream.seededHistoryMessages, 5000, 'repeat_stream_history_mismatch');
  assert.equal(stream.precedingShortRunsInThread, 1, 'repeat_stream_history_mismatch');
  assert.equal(stream.completed?.terminal?.type, 'run_completed', 'repeat_stream_not_completed');
  assert.ok(typeof stream.runId === 'string' && stream.runId.length > 0, 'repeat_stream_run_missing');
  assert.equal(stream.completed.terminal.runId, stream.runId, 'repeat_stream_run_mismatch');
  assert.ok(stream.completed.streamDurationMs >= streamConfig.durationMs, 'repeat_stream_duration_short');
  assert.deepEqual(stream.checkpoints.map(point => point.scenarioId), streamIds, 'repeat_stream_checkpoints_mismatch');
  const rows = streamIds.map((id, index) => {
    const scene = byId.get(id);
    assert.equal(scene.samples?.length, 1, 'repeat_stream_sample_count');
    const point = scene.samples[0];
    assert.equal(point.minutes, streamConfig.checkpointMinutes[index], 'repeat_stream_checkpoint_mismatch');
    assert.deepEqual(stream.checkpoints[index], {scenarioId: id, ...point}, 'repeat_stream_checkpoint_mismatch');
    assert.ok(point.elapsedMs >= point.minutes * 60_000, 'repeat_stream_checkpoint_early');
    const sample = {...rendererWorkloadSample(scene), ...processSample(scene.processes)};
    for (const key of ['elapsedMs', 'textDeltaCount', 'windowTextDeltas', 'mountedRows']) sample[`stream.${key}`] = finite(point[key], key);
    assert.ok(point.windowTextDeltas > 0 && point.mountedRows > 0 && point.mountedRows < 100, 'repeat_stream_not_advancing_or_windowed');
    return {id, sample};
  });
  const idle = byId.get('events-0').idleSamples;
  const expectedIdle = ['visible', 'hidden'].flatMap(visibility => [0, 5, 30].map(minutes => `${visibility}-${minutes}`));
  assert.ok(Array.isArray(idle), 'repeat_idle_samples_missing');
  assert.deepEqual(idle.map(point => `${point.visibility}-${point.minutes}`), expectedIdle, 'repeat_idle_checkpoints_mismatch');
  for (const point of idle) {
    assert.equal(point.nativeVisible, point.visibility === 'visible', 'repeat_idle_native_visibility_mismatch');
    assert.equal(point.forwardedHidden, point.visibility === 'hidden', 'repeat_idle_forwarded_visibility_mismatch');
    assert.ok(point.elapsedMs >= point.minutes * 60_000, 'repeat_idle_checkpoint_early');
    const sample = {...processSample(point), elapsedMs: finite(point.elapsedMs, 'idle.elapsedMs'),
      mainCpuOneCorePercent: optional(point.mainCpuOneCorePercent, 'mainCpuOneCorePercent')};
    assert.equal(point.mainCpuOneCorePercent === null, point.minutes === 0, 'repeat_idle_cpu_interval_missing');
    for (const key of ['heapUsedBytes', 'heapTotalBytes', 'domNodes', 'documents']) sample[`renderer.${key}`] = finite(point.renderer?.[key], key);
    rows.push({id: `idle-${point.visibility}-${point.minutes}m`, sample});
  }
  const completion = {firstChunkMs: finite(stream.firstChunkMs, 'firstChunkMs')};
  for (const key of ['elapsedMs', 'streamDurationMs', 'textDeltaCount', 'receivedEvents']) completion[key] = finite(stream.completed[key], key);
  rows.push({id: 'sustained-stream-complete', sample: completion},
    {id: 'idle-reopen', sample: {reopenMs: finite(run.reopenMs, 'reopenMs')}});
  return rows;
}

function pdfSamples(run) {
  assert.equal(run.kind, 'pdf-reader', 'repeat_kind_mismatch');
  assert.equal(run.fixture?.samples, 1, 'repeat_child_samples_must_be_one');
  assert.equal(run.fixture.pages, 400, 'repeat_pdf_fixture_mismatch');
  assert.equal(run.fixture.pageTurns, pdfPageTurns, 'repeat_pdf_turns_mismatch');
  assert.equal(run.fixture.nativeReopen, false, 'repeat_pdf_reopen_variant');
  assert.equal(run.rendererBuild?.variant, 'current', 'repeat_pdf_reference_variant');
  const byId = scenes(run, ['400-page-open-close', pdfId, 'hidden-parser-ipc-competition']);
  const turns = byId.get(pdfId);
  assert.equal(turns.samples?.length, pdfPageTurns, 'repeat_pdf_turn_count');
  const sample = rendererWorkloadSample(turns);
  const rasterMs = turns.samples.map((point, index) => {
    assert.equal(point.page, index + 2, 'repeat_pdf_page_sequence');
    assert.ok(point.rasterAllocations >= 1 && Number.isInteger(point.rasterAllocations), 'repeat_pdf_raster_not_allocated');
    assert.ok(point.workers > 0 && point.bitmapBytes > 0, 'repeat_pdf_ownership_missing');
    return finite(point.rasterReadyMs, 'rasterReadyMs');
  });
  const raster = summarize(rasterMs);
  for (const key of ['p50', 'p95', 'max']) sample[`pageRasterReadyMs.${key}`] = raster[key];
  sample.pageTurns = raster.count;
  sample.rasterAllocations = turns.samples.reduce((total, point) => total + point.rasterAllocations, 0);
  sample.maxWorkers = Math.max(...turns.samples.map(point => finite(point.workers, 'workers')));
  sample.maxBitmapBytes = Math.max(...turns.samples.map(point => finite(point.bitmapBytes, 'bitmapBytes')));
  const rows = [{id: pdfId, sample}, {id: 'background-parse', sample: {elapsedMs: finite(run.backgroundParseMs, 'backgroundParseMs')}}];
  for (const [id, keys] of [['400-page-open-close', ['firstRasterMs', 'rasterAllocations', 'mainRssBytes', 'mainExternalBytes', 'processWorkingSetSumBytes']],
    ['hidden-parser-ipc-competition', ['ipcMs']]]) {
    const scene = byId.get(id);
    assert.equal(scene.samples?.length, 1, 'repeat_pdf_sample_count');
    rows.push({id, sample: Object.fromEntries(keys.map(key => [key, finite(scene.samples[0][key], key)]))});
  }
  return rows;
}

/** Each row comes from one completed child process; never pool pages or checkpoints. */
export function summarizeRepeatedWorkloads(workload, runs) {
  assert.ok(['endurance', 'pdf'].includes(workload), 'repeat_workload_invalid');
  assert.ok(runs.length > 0, 'repeat_runs_required');
  const first = runs[0];
  const rows = runs.map(run => {
    assert.ok(run.failedWorkload === undefined && run.failure === undefined && run.status !== 'failed', 'repeat_child_failed');
    for (const key of ['protocolSha256', 'fixtureSha256']) {
      assert.ok(typeof run[key] === 'string' && run[key].length > 0, `repeat_identity_missing:${key}`);
      assert.equal(run[key], first[key], `repeat_identity_mismatch:${key}`);
    }
    for (const key of ['gitSha', 'sourceSha256', 'lockSha256']) {
      assert.ok(typeof run.source?.[key] === 'string' && run.source[key].length > 0, `repeat_source_missing:${key}`);
      assert.equal(run.source[key], first.source[key], `repeat_source_mismatch:${key}`);
    }
    assert.ok(run.host?.display !== null && run.host?.display !== undefined, 'repeat_display_missing');
    assert.deepEqual(run.host, first.host, 'repeat_host_mismatch');
    assert.deepEqual(run.fixture, first.fixture, 'repeat_fixture_mismatch');
    assert.deepEqual(run.rendererBuild, first.rendererBuild, 'repeat_renderer_build_mismatch');
    return new Map((workload === 'endurance' ? enduranceSamples(run) : pdfSamples(run)).map(row => [row.id, row.sample]));
  });
  return [...rows[0].keys()].map(id => {
    const samples = rows.map(row => row.get(id)), summary = {}, missingSamples = {};
    for (const key of Object.keys(samples[0])) {
      const values = samples.map(sample => sample[key]).filter(value => value !== null);
      missingSamples[key] = samples.length - values.length;
      if (values.length > 0) summary[key] = summarize(values);
    }
    return {id, samples, summary, missingSamples};
  });
}
