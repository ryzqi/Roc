import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { protocol } from './report-lib.mjs';

export function compareReports(before, after, { thresholdPercent = protocol.regressionPercent, reportOnly = [] } = {}) {
  for (const field of ['schemaVersion', 'kind', 'protocolSha256', 'fixtureSha256']) {
    assert.deepEqual(after[field], before[field], `performance_incompatible:${field}`);
  }
  assert.equal(after.source.lockSha256, before.source.lockSha256, 'performance_incompatible:source.lockSha256');
  for (const field of ['identitySha256', 'platform', 'arch', 'osRelease', 'totalMemoryBytes', 'node', 'electron', 'sqlite', 'display', 'power']) {
    assert.deepEqual(after.host[field], before.host[field], `performance_incompatible:host.${field}`);
  }
  assert.deepEqual(after.scenarios.map(scene => scene.id), before.scenarios.map(scene => scene.id), 'performance_incompatible:scenarios');
  const changes = [];
  for (let index = 0; index < before.scenarios.length; index++) {
    const left = before.scenarios[index], right = after.scenarios[index];
    for (const field of ['correctnessSha256', 'outputSha256', 'behaviorSha256', 'sourceSha256', 'parseMode', 'errorCode']) {
      assert.equal(right[field], left[field], `performance_correctness_changed:${left.id}:${field}`);
    }
    assert.deepEqual(Object.keys(right.summary), Object.keys(left.summary), `performance_incompatible:metrics:${left.id}`);
    for (const [metric, initial] of Object.entries(left.summary)) {
      const final = right.summary[metric];
      assert.equal(final.count, initial.count, `performance_incompatible:samples:${left.id}:${metric}`);
      for (const statistic of ['p50', 'p95', 'max']) {
        assert.ok(Number.isFinite(initial[statistic]) && Number.isFinite(final[statistic]), 'performance_metric_invalid');
        const percent = initial[statistic] === 0 ? (final[statistic] === 0 ? 0 : null) : (final[statistic] / initial[statistic] - 1) * 100;
        const noisy = reportOnly.includes(metric) || metric.endsWith('Bytes') || /cpu/iu.test(metric);
        changes.push({ scenario: left.id, metric, statistic, before: initial[statistic], after: final[statistic], percent,
          reportOnly: noisy, regression: !noisy && statistic === 'p95' && percent !== null && percent > thresholdPercent });
      }
    }
  }
  return { compatible: true, thresholdPercent, beforeSha: before.source.gitSha, afterSha: after.source.gitSha,
    regressionCandidates: changes.filter(change => change.regression), changes,
    limitation: 'Threshold candidates require repeated same-host measurements and noise review; a single run does not establish statistical significance.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [beforePath, afterPath, outputPath] = process.argv.slice(2);
  assert.ok(beforePath && afterPath, 'Usage: compare-reports.mjs before.json after.json [comparison.json]');
  const result = compareReports(JSON.parse(readFileSync(beforePath)), JSON.parse(readFileSync(afterPath)));
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ compatible: result.compatible, regressionCandidates: result.regressionCandidates }, null, 2));
  if (result.regressionCandidates.length > 0) process.exitCode = 1;
}
