import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareReports } from '../../scripts/performance/compare-reports.mjs';
import { summarize } from '../../scripts/performance/report-lib.mjs';

const report = () => ({ schemaVersion: 1, kind: 'fixture', protocolSha256: 'protocol', fixtureSha256: 'corpus',
  source: { gitSha: 'before' }, host: { identitySha256: 'host', platform: 'darwin', arch: 'arm64', node: 'node',
    electron: 'electron', sqlite: 'sqlite', display: [{ scaleFactor: 2 }], power: 'power' },
  scenarios: [{ id: 'query', summary: { durationMs: { count: 20, p50: 10, p95: 20, max: 30 } } }] });

test('report comparison refuses host, corpus, scenario and sample incompatibility', () => {
  for (const change of [
    value => { value.fixtureSha256 = 'other'; },
    value => { value.host.display[0].scaleFactor = 1; },
    value => { value.source.lockSha256 = 'changed'; },
    value => { value.scenarios[0].id = 'other'; },
    value => { value.scenarios[0].summary.durationMs.count = 3; }
  ]) {
    const after = report(); change(after);
    assert.throws(() => compareReports(report(), after), /performance_incompatible/u);
  }
});

test('comparison exposes P95 regression candidates and preserves noisy memory observations', () => {
  const before = report(), after = report();
  before.scenarios[0].summary.rssBytes = { count: 20, p50: 1, p95: 2, max: 3 };
  after.scenarios[0].summary.rssBytes = { count: 20, p50: 2, p95: 4, max: 6 };
  after.scenarios[0].summary.durationMs.p95 = 22;
  const compared = compareReports(before, after);
  assert.equal(compared.regressionCandidates.length, 1);
  assert.equal(compared.regressionCandidates[0].metric, 'durationMs');
  assert.ok(compared.changes.find(change => change.metric === 'rssBytes' && change.statistic === 'p95').reportOnly);
  before.scenarios[0].summary.cpuUserMicros = { count: 20, p50: 1, p95: 2, max: 3 };
  after.scenarios[0].summary.cpuUserMicros = { count: 20, p50: 2, p95: 4, max: 6 };
  assert.equal(compareReports(before, after).regressionCandidates.length, 1);
  assert.deepEqual(compareReports(report(), report()).regressionCandidates, []);
});

test('nearest-rank percentiles retain exact samples and reject missing or invalid values', () => {
  assert.deepEqual(summarize(Array.from({ length: 20 }, (_, index) => index + 1)), { count: 20, min: 1, p50: 10, p95: 19, max: 20 });
  assert.throws(() => summarize([]), /performance_samples_invalid/u);
  assert.throws(() => summarize([NaN]), /performance_samples_invalid/u);
});

test('frozen retrieval output and receipt hashes cannot pass comparison with changed behavior', () => {
  const before = report(), after = report();
  before.scenarios[0].correctnessSha256 = 'frozen';
  after.scenarios[0].correctnessSha256 = 'changed';
  assert.throws(() => compareReports(before, after), /performance_correctness_changed/u);
});

test('memory results and parser outcomes remain part of the comparison contract', () => {
  for (const field of ['outputSha256', 'behaviorSha256', 'parseMode', 'errorCode', 'sourceSha256']) {
    const before = report(), after = report();
    before.scenarios[0][field] = 'frozen';
    after.scenarios[0][field] = 'changed';
    assert.throws(() => compareReports(before, after), /performance_correctness_changed/u);
  }
});
