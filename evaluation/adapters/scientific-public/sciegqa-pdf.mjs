import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {hash, readJson, ROOT, sha256} from '../../lib/common.mjs';
import {publicPdfArtifactPath, verifyPublicPdfReceipt} from './pdf.mjs';
import {verifySciegqaCohort} from './sciegqa-cohort.mjs';

export const sciegqaCorpusRoot = join(ROOT, 'evaluation/local/corpora/sciegqa-bench-v1');
export const sciegqaCohortPath = join(ROOT, 'evaluation/corpora/scientific-rag/sciegqa-cohort.lock.json');

/** Reconstruct original bytes/labels and preselection before production use.
 * No correspondence status or published answer reaches the parser. */
export function loadSciegqaPdfCohort() {
  execFileSync('python3', [join(ROOT, 'scripts/prepare-scientific-sciegqa.py'),
    '--output-root', sciegqaCorpusRoot, '--verify'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const manifest = readJson(publicPdfArtifactPath(sciegqaCorpusRoot, 'manifest.json'));
  const labels = readJson(publicPdfArtifactPath(sciegqaCorpusRoot, 'labels.json'));
  const cohort = verifySciegqaCohort(readJson(sciegqaCohortPath), manifest, labels);
  if (cohort.papers.length !== 45 || cohort.questionCount !== 225
    || cohort.papers.some(p => !p.pdf)
    || new Set(cohort.papers.map(p => p.pdf.sha256)).size !== 45) {
    throw new Error('scientific_sciegqa_pdf_sources_unavailable');
  }
  return {cohort, cohortHash: hash(cohort), manifestHash: hash(manifest)};
}

export function verifySciegqaPdfHeader(run, inputs, source) {
  const pins = source.cohort.papers.map(p => p.pdf);
  if (run.kind !== 'scientific-sciegqa-full-pdf-parser-component-run'
    || run.status !== 'processed-unscored' || !run.cohortComplete
    || run.papers !== 45 || run.questions !== 225 || run.rows?.length !== 45
    || run.sourceLockHash !== source.cohort.sourceLockHash
    || inputs.sourceLockHash !== run.sourceLockHash
    || run.cohortHash !== source.cohortHash || inputs.cohortHash !== source.cohortHash
    || inputs.manifestHash !== source.manifestHash
    || hash(inputs.pins) !== hash(pins)
    || hash(inputs.codeHashes) !== hash(run.codeHashes)
    || hash(inputs.modelHashes) !== hash(run.modelHashes)
    || inputs.modelManifest !== run.modelManifest
    || hash(inputs.parserOptions) !== hash(run.parserOptions)
    || hash(run.parserOptions) !== hash({tier: 'complete', device: 'cpu', pageRange: ''})
    || !Array.isArray(inputs.compiledBundleHashes) || !inputs.compiledBundleHashes.length
    || run.rows.some((row, i) => row.datasetPaperId !== source.cohort.papers[i].id
      || row.source !== pins[i].path || row.sourceHash !== pins[i].sha256
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
      || !Number.isFinite(row.peakRssBytes) || row.peakRssBytes <= 0)
    || run.failedPapers !== run.rows.filter(row => row.status === 'failed').length) {
    throw new Error('scientific_sciegqa_pdf_run_unqualified');
  }
  return pins;
}

export async function verifySciegqaPdfRun(root) {
  root = resolve(root);
  const source = loadSciegqaPdfCohort();
  const run = readJson(publicPdfArtifactPath(root, 'run.json'));
  const inputs = readJson(publicPdfArtifactPath(root, 'inputs.json'));
  const pins = verifySciegqaPdfHeader(run, inputs, source), rows = [];
  for (const [i, row] of run.rows.entries()) {
    rows.push({...await verifyPublicPdfReceipt(root, sciegqaCorpusRoot, row, i, pins[i], run.modelManifest),
      datasetPaperId: source.cohort.papers[i].id});
  }
  const latencies = run.rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  return {schemaVersion: 1, kind: 'scientific-sciegqa-full-pdf-provenance-component-baseline',
    status: 'verified-provenance-unscored-quality', root, workingDirectory: ROOT,
    sourceLockHash: run.sourceLockHash, cohortHash: source.cohortHash, manifestHash: source.manifestHash,
    runHash: hash(run), papers: rows.length, questions: run.questions,
    parsedPapers: rows.filter(row => row.status === 'parsed').length, failedPapers: run.failedPapers,
    verifiedPages: rows.reduce((n, row) => n + (row.pageCount ?? 0), 0),
    rows, deterministicOutputHash: hash(rows), parserCodeHashes: run.codeHashes,
    modelHashes: run.modelHashes, modelManifest: run.modelManifest,
    verifierCodeHashes: Object.fromEntries(['evaluation/adapters/scientific-public/sciegqa-pdf.mjs',
      'evaluation/adapters/scientific-public/pdf.mjs'].map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
    performance: {paperP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
      paperP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
      totalPaperMs: latencies.reduce((n, ms) => n + ms, 0),
      sampledPeakRssBytes: Math.max(...run.rows.map(row => row.peakRssBytes)), paperSamples: rows.length},
    qualityMetrics: null, scientificBaselineReady: false,
    limitations: ['Preselected45 papers/225 questions retained; parse failures are not excluded.',
      'Source/artifact/actual viewport verification is not human evidence locator accuracy.',
      'Published semantic-region correspondence candidates are independently stored, not parser gold.',
      'No full document text/cell/LaTeX/order, retrieval, generated Wiki or embedding cost score.',
      'Cooperative600s cancellation and20ms RSS sampling may exceed budget/miss synchronous peaks.']};
}
