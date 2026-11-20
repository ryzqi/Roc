import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {publicPdfArtifactPath, verifyPublicPdfReceipt} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock,
  verifyPublicScientificSources} from '../evaluation/adapters/scientific-public/sources.mjs';

export async function verifyScientificPublicPdfRun(root, {persist = true} = {}) {
  root = resolve(root);
  const run = readJson(publicPdfArtifactPath(root, 'run.json'));
  const inputs = readJson(publicPdfArtifactPath(root, 'inputs.json'));
  const sources = verifyPublicScientificSources(), lock = readJson(publicScientificSourceLock);
  const pins = lock.files.filter(file => file.path.endsWith('.pdf'));
  if (run.kind !== 'scientific-public-full-pdf-parser-component-run' || run.status !== 'processed-unscored'
    || !run.cohortComplete || run.papers !== 45 || run.rows.length !== pins.length
    || run.sourceLockHash !== sources.sourceLockHash || inputs.sourceLockHash !== sources.sourceLockHash
    || hash(inputs.pins) !== hash(pins) || hash(inputs.codeHashes) !== hash(run.codeHashes)
    || hash(inputs.modelHashes) !== hash(run.modelHashes) || inputs.modelManifest !== run.modelManifest
    || hash(inputs.parserOptions) !== hash(run.parserOptions)) throw new Error('scientific_pdf_run_unqualified');
  const rows = [];
  for (const [i, row] of run.rows.entries()) {
    rows.push(await verifyPublicPdfReceipt(root, defaultPublicScientificRoot, row, i, pins[i], run.modelManifest));
  }
  if (rows.filter(row => row.status === 'failed').length !== run.failedPapers) throw new Error('scientific_pdf_failure_count_invalid');
  const latencies = run.rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  if (run.rows.some(row => !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
    || !Number.isFinite(row.peakRssBytes) || row.peakRssBytes <= 0)) throw new Error('scientific_pdf_performance_invalid');
  const report = {schemaVersion: 1, kind: 'scientific-public-full-pdf-provenance-component-baseline',
    status: 'verified-provenance-unscored-quality', root, workingDirectory: ROOT,
    sourceLockHash: sources.sourceLockHash, runHash: hash(run), papers: rows.length,
    parsedPapers: rows.filter(row => row.status === 'parsed').length,
    failedPapers: run.failedPapers, verifiedPages: rows.reduce((sum, row) => sum + (row.pageCount ?? 0), 0),
    rows, deterministicOutputHash: hash(rows),
    modelHashes: run.modelHashes, modelManifest: run.modelManifest, parserCodeHashes: run.codeHashes,
    verifierCodeHashes: Object.fromEntries(['scripts/verify-scientific-public-pdf.mjs',
      'evaluation/adapters/scientific-public/pdf.mjs'].map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
    performance: {paperP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
      paperP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
      totalPaperMs: latencies.reduce((sum, ms) => sum + ms, 0),
      sampledPeakRssBytes: Math.max(...run.rows.map(row => row.peakRssBytes)), paperSamples: rows.length},
    qualityMetrics: null, qualityMetricsReason: 'No independent full-PDF structure or QASPER-to-specific-PDF evidence gold.',
    limitations: [...run.limitations, 'Viewport/bbox geometry validity is not human-verified locator accuracy.'],
    scientificBaselineReady: false};
  if (persist) writeJson(join(root, 'verified-pdf.json'), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-scientific-public-pdf.mjs RUN_ROOT');
  verifyScientificPublicPdfRun(process.argv[2]).then(report => console.log(JSON.stringify({
    root: report.root, papers: report.papers, failedPapers: report.failedPapers,
    verifiedPages: report.verifiedPages, performance: report.performance, deterministicOutputHash: report.deterministicOutputHash
  }, null, 2))).catch(error => {console.error(error.stack); process.exitCode = 1;});
}
