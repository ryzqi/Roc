import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from './report-lib.mjs';

const [beforePath, afterPath, comparisonPath, outputPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath && comparisonPath && outputPath, 'paired_noise_arguments_required');
const beforeBytes = readFileSync(beforePath), afterBytes = readFileSync(afterPath);
const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes), comparison = JSON.parse(readFileSync(comparisonPath));
assert.equal(comparison.compatible, true);
assert.equal(before.fixtureSha256, after.fixtureSha256);
const pairingNote = 'Frozen/current scans alternate within each sample on the same directory and live writer. Original separate-run reports remain.';
assert.ok(before.limitations.includes(pairingNote) && after.limitations.includes(pairingNote), 'alternating_pairs_required');
let seed = 0x726f63;
function randomIndex(length) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % length;
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const findings = comparison.regressionCandidates.filter(item => !item.reportOnly).map(candidate => {
  const left = before.scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  const right = after.scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  assert.equal(left.length, right.length);
  assert.ok(left.every(value => typeof value === 'number' && value > 0));
  const changes = [];
  for (let iteration = 0; iteration < 10000; iteration++) {
    const a = [], b = [];
    for (let count = 0; count < left.length; count++) {
      const index = randomIndex(left.length); a.push(left[index]); b.push(right[index]);
    }
    changes.push((percentile(b, .95) / percentile(a, .95) - 1) * 100);
  }
  const interval = { lowerPercent: percentile(changes, .025), upperPercent: percentile(changes, .975) };
  return { ...candidate, pairedBootstrap95: interval, establishedRegression: interval.lowerPercent > 5 };
});
const report = {
  method: 'seeded paired percentile bootstrap, 10000 resamples, P95 ratio, 95 percent interval',
  thresholdPercent: 5, beforeSha256: sha256(beforeBytes), afterSha256: sha256(afterBytes),
  originalComparisonRetained: resolve(comparisonPath), findings,
  establishedRegressions: findings.filter(item => item.establishedRegression),
  limitations: [
    'Requires genuinely alternating paired samples; matching row numbers in independent runs are not pairs.',
    'Small-sample tail intervals can be wide; absence of an established regression is not proof of a speedup.',
    'Original comparison candidates and the five-percent threshold remain unchanged.'
  ]
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.establishedRegressions.length > 0) process.exitCode = 1;
