import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { compareReports } from './compare-reports.mjs';
import { sha256 } from './report-lib.mjs';

const files = ['memory', 'rag', 'process', 'app', 'pdf', 'reader', 'ocr', 'idle'];
const reports = files.map(name => {
  const path = `.artifacts/mac-performance/${name}-before.json`;
  const bytes = readFileSync(path), report = JSON.parse(bytes);
  assert.equal(report.host.platform, 'darwin');
  assert.equal(report.host.arch, 'arm64');
  assert.ok(report.scenarios.length > 0, `baseline_incomplete:${name}`);
  compareReports(report, report);
  const minimumSamples = name === 'ocr' ? 5 : name === 'pdf' ? 3 : name === 'idle' ? 1 : 20;
  for (const scene of report.scenarios) {
    assert.ok(scene.samples.length >= minimumSamples, `baseline_samples_missing:${name}:${scene.id}`);
  }
  if (name === 'idle') {
    assert.deepEqual(report.idleSamples.map(sample => sample.minutes), [0, 5, 30, 60]);
  }
  return {
    name, path, sha256: sha256(bytes), measuredAt: report.measuredAt,
    kind: report.kind, source: report.source, host: report.host,
    protocolSha256: report.protocolSha256, fixtureSha256: report.fixtureSha256, fixture: report.fixture,
    scenarios: report.scenarios.map(({ samples, processSamples, idleSamples, ...summary }) => summary),
    ...(name === 'idle' ? {
      idle: report.idleSamples.map(sample => ({
        minutes: sample.minutes, mainRssBytes: sample.main.rss,
        mainPrivateMemoryBytes: sample.mainPrivateMemoryBytes, mainHeapUsedBytes: sample.main.heapUsed,
        cpu: sample.cpu, eventLoopDelay: sample.eventLoopDelay,
        processWorkingSets: sample.processes.map(({ type, workingSetBytes, cpuPercent }) => ({ type, workingSetBytes, cpuPercent }))
      })), reopenMs: report.reopenMs
    } : {}),
    limitations: report.limitations
  };
});
const baseline = {
  schemaVersion: 1, phase: 'PR-00A', status: 'Verified passing',
  auditBase: '98dcf50e414619db2612074ad46fdafcca3c6f23',
  productionBase: reports[0].source.gitSha, reports,
  limitations: [
    'Working sets/RSS include shared memory; no exclusive physical footprint or IOSurface measurement.',
    'Instruments/xctrace is unavailable on this host.',
    'The long hidden-idle observation overlaps development and benchmark activity; it is a resource-lifetime reference, not a quiet-host performance gate.',
    'Startup was measured before the external event-loop observer was added. Reader and idle process samples contain event-loop observations.',
    'PDF parser has three samples and controlled OCR has five; OCR raw output includes unrecognized table structure and is not a calibrated accuracy claim.'
  ]
};
const output = '.artifacts/mac-performance/mac-optimization-baseline.json';
writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);
const rows = reports.flatMap(report => report.scenarios.flatMap(scene =>
  Object.entries(scene.summary).filter(([metric]) => metric.endsWith('Ms')).map(([metric, value]) =>
    `| ${report.name} | ${scene.id} | ${metric} | ${value.count} | ${value.p50.toFixed(2)} | ${value.p95.toFixed(2)} |`)));
writeFileSync(output.replace(/\.json$/u, '.md'), [
  '# macOS optimization baseline', '', `Production source: ${baseline.productionBase}. Status: ${baseline.status}.`,
  '', '| Workload | Scenario | Metric | Samples | P50 ms | P95 ms |', '| --- | --- | --- | ---: | ---: | ---: |',
  ...rows, '', ...baseline.limitations.map(value => `- ${value}`), ''
].join('\n'));
console.log(JSON.stringify({ output, reports: reports.map(({ name, scenarios }) => ({ name, scenarios: scenarios.length })) }));
