import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareReports } from './compare-reports.mjs';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/mac-background-reader-paired.json');
const referenceRenderer = process.env.ROC_PERF_PDF_REFERENCE_RENDERER;
assert.ok(referenceRenderer, 'frozen_reference_renderer_required');
const rawRoot = resolve('.artifacts/mac-performance/pdf-background-paired');
mkdirSync(rawRoot, { recursive: true });
const reports = [[], []];
for (let pair = 0; pair < options.samples; pair++) {
  for (const variant of pair % 2 === 0 ? [0, 1] : [1, 0]) {
    const path = join(rawRoot, `${pair + 1}-${variant === 0 ? 'reference' : 'current'}.json`);
    const env = { ...process.env, ROC_PERF_PDF_BACKGROUND_REOPEN: '1', ROC_PERF_PDF_HIDDEN_MS: '0' };
    if (variant === 1) delete env.ROC_PERF_PDF_REFERENCE_RENDERER;
    await new Promise((done, fail) => {
      const child = spawn(process.execPath, ['scripts/performance/bench-pdf-reader.mjs', path, '--samples', '1'],
        { env, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.resume();
      child.on('error', fail);
      child.on('exit', code => code === 0 ? done() : fail(new Error(`pdf_background_child_failed:${code}`)));
    });
    const bytes = readFileSync(path);
    reports[variant].push({ report: JSON.parse(bytes), raw: { path, sha256: sha256(bytes) } });
    console.log(JSON.stringify({ pair: pair + 1, variant: variant === 0 ? 'reference' : 'current' }));
  }
}

const outputs = reports.map((runs, variant) => {
  const first = runs[0].report;
  const report = makeReport('pdf-background-paired', {
    recipe: first.fixture, pairs: options.samples, order: 'AB/BA alternating fresh isolated applications',
    referenceReaderSha256: reports[0][0].report.rendererBuild.readerSourceSha256
  }, ['scripts/performance/bench-pdf-reader.mjs', 'dist/main/index.js', 'dist/preload/index.cjs']);
  report.host = first.host;
  report.rendererBuild = first.rendererBuild;
  report.rawArtifacts = runs.map(run => run.raw);
  for (const run of runs) {
    assert.equal(run.report.fixtureSha256, first.fixtureSha256);
    assert.deepEqual(run.report.source.sourceHashes, first.source.sourceHashes);
    assert.deepEqual(run.report.rendererBuild, first.rendererBuild);
  }
  for (const scene of first.scenarios) {
    const samples = runs.flatMap(run => run.report.scenarios.find(value => value.id === scene.id).samples);
    assert.equal(samples.length, options.samples);
    report.scenarios.push({ id: scene.id, samples, summary: summarizeRows(samples) });
  }
  report.limitations.push(
    'Each pair alternates fresh reference/current applications; the generated profile, Main/preload, PDF, viewport and probes match.',
    'One sample per application measures cold first-open and first native reopen; the original twenty-reopen warm runs remain separately available.',
    'The parser/status probe overlaps the real production parser; process scheduling and native allocation are observed rather than substituted.',
    'RSS is whole Main and working-set sums include shared pages; no exclusive footprint or thread attribution is claimed.'
  );
  saveReport(options.outputPath.replace(/\.json$/u, variant === 0 ? '-before.json' : '-after.json'), report);
  return report;
});
const comparison = compareReports(outputs[0], outputs[1]);
writeFileSync(options.outputPath.replace(/\.json$/u, '-comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
let seed = 0x726f63;
const randomIndex = length => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % length;
};
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const findings = comparison.regressionCandidates.map(candidate => {
  const left = outputs[0].scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  const right = outputs[1].scenarios.find(scene => scene.id === candidate.scenario).samples.map(row => row[candidate.metric]);
  const ratios = [];
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const a = [], b = [];
    for (let count = 0; count < left.length; count++) {
      const index = randomIndex(left.length); a.push(left[index]); b.push(right[index]);
    }
    ratios.push((percentile(b, .95) / percentile(a, .95) - 1) * 100);
  }
  const interval = { lowerPercent: percentile(ratios, .025), upperPercent: percentile(ratios, .975) };
  return { ...candidate, pairedBootstrap95: interval, establishedRegression: interval.lowerPercent > 5 };
});
const assessment = {
  method: 'seeded paired percentile bootstrap, 10000 resamples, P95 ratio, 95 percent interval',
  thresholdPercent: comparison.thresholdPercent, findings,
  establishedRegressions: findings.filter(item => item.establishedRegression),
  limitations: [
    'Fresh application pairs control order and load drift; tail intervals remain wide with twenty pairs.',
    'No established regression does not prove a speedup. Original independent-run flags and all distributions are retained.'
  ]
};
writeFileSync(options.outputPath, `${JSON.stringify(assessment, null, 2)}\n`);
console.log(JSON.stringify({ regressionCandidates: comparison.regressionCandidates,
  establishedRegressions: assessment.establishedRegressions }, null, 2));
if (assessment.establishedRegressions.length > 0) process.exitCode = 1;
