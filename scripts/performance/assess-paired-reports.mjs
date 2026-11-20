import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { compareReports } from './compare-reports.mjs';
import { sha256 } from './report-lib.mjs';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath && outputPath, 'Usage: assess-paired-reports.mjs before.json after.json assessment.json');
const leftBytes = readFileSync(beforePath), rightBytes = readFileSync(afterPath);
const before = JSON.parse(leftBytes), after = JSON.parse(rightBytes);
assert.equal(before.fixture.order, 'AB/BA alternating', 'documented_pairing_required');
assert.equal(after.fixture.order, before.fixture.order);
const comparison = compareReports(before, after, { reportOnly: ['workers', 'readyMs', 'validationMs'] });
let seed = 0x726f63;
const randomIndex = length => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % length;
};
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const findings = comparison.regressionCandidates.map(candidate => {
  const left = before.scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  const right = after.scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  assert.ok(left.length >= 20 && left.length === right.length && left.every(Number.isFinite) && right.every(Number.isFinite), 'paired_samples_invalid');
  const ratios = [];
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const a = [], b = [];
    for (let count = 0; count < left.length; count++) {
      const index = randomIndex(left.length); a.push(left[index]); b.push(right[index]);
    }
    ratios.push((percentile(b, .95) / percentile(a, .95) - 1) * 100);
  }
  const interval = { lowerPercent: percentile(ratios, .025), upperPercent: percentile(ratios, .975) };
  return { ...candidate, pairedBootstrap95: interval, establishedRegression: interval.lowerPercent > comparison.thresholdPercent };
});
const result = {
  method: 'seeded paired percentile bootstrap, 10000 resamples, P95 ratio, 95 percent interval',
  pairing: before.fixture.order, pairs: before.fixture.pairs, thresholdPercent: comparison.thresholdPercent,
  sourceReports: [{ path: beforePath, sha256: sha256(leftBytes) }, { path: afterPath, sha256: sha256(rightBytes) }],
  findings, establishedRegressions: findings.filter(item => item.establishedRegression),
  limitations: [
    'Rows must represent the same pair index; the benchmark enforces alternating variants and complete output parity.',
    'Twenty pairs leave wide tail intervals. No established regression does not prove equivalence or a speedup.',
    'Original percentage flags are retained without raising the five percent threshold.'
  ]
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (result.establishedRegressions.length > 0) process.exitCode = 1;
