import { lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, readJson, ROOT, sha256, writeJson } from '../evaluation/lib/common.mjs';
import { defaultPublicScientificRoot, publicScientificSourceLock,
  verifyPublicScientificSources } from '../evaluation/adapters/scientific-public/sources.mjs';
import { scoreFailedPublicStructurePage, scorePublicStructurePage, structureScoringContract,
  summarizePublicStructure } from '../evaluation/adapters/scientific-public/structure.mjs';

function artifactPath(root, name) {
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(name) === name) {
    throw new Error('scientific_public_artifact_path_invalid');
  }
  for (let current = path; current !== root; current = resolve(current, '..')) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('scientific_public_artifact_path_invalid');
  }
  if (!lstatSync(path).isFile()) throw new Error('scientific_public_artifact_not_regular');
  return path;
}

export function scoreScientificPublicParserRun(root) {
  root = resolve(root);
  const runPath = artifactPath(root, 'run.json'), run = readJson(runPath);
  const sources = verifyPublicScientificSources();
  if (run.status !== 'processed-unscored' || !run.cohortComplete || run.pages !== 46
    || run.sourceLockHash !== sources.sourceLockHash || run.rows.length !== run.pages) {
    throw new Error('scientific_public_parser_run_unqualified');
  }
  const lock = readJson(publicScientificSourceLock), pins = lock.files.filter(file =>
    file.path.startsWith('omnidocbench/images/'));
  if (hash(run.rows.map(row => row.image)) !== hash(pins.map(pin => pin.path))) {
    throw new Error('scientific_public_parser_cohort_changed');
  }
  const labels = readJson(join(defaultPublicScientificRoot, 'omnidocbench/labels.json'));
  const goldByImage = new Map(labels.map(page => [page.page_info.image_path, page]));
  const scores = run.rows.map((row, index) => {
    if (row.sourceHash !== pins[index].sha256 || row.modelManifest !== run.modelManifest) {
      throw new Error('scientific_public_parser_source_changed');
    }
    const gold = goldByImage.get(row.image.split('/').at(-1));
    if (!gold) throw new Error('scientific_public_gold_page_missing');
    const identity = { image: row.image, sampleId: gold.page_info.sample_id,
      sourcePage: gold.page_info.page_no, pageAttribute: gold.page_info.page_attribute };
    if (row.status === 'failed') {
      if (!row.failure?.code || row.structured !== null || row.result !== null) {
        throw new Error('scientific_public_failure_receipt_invalid');
      }
      return { ...identity, ...scoreFailedPublicStructurePage(gold, row.failure.code) };
    }
    if (row.status !== 'parsed' || row.failure !== null) throw new Error('scientific_public_page_status_invalid');
    const outputRoot = join(root, `page-${index}/output`);
    if (hash(row.artifacts) !== row.artifactsHash) throw new Error('scientific_public_parser_receipt_changed');
    for (const artifact of row.artifacts) if (sha256(readFileSync(artifactPath(outputRoot, artifact.path))) !== artifact.sha256) {
      throw new Error('scientific_public_parser_artifact_changed');
    }
    const structured = readJson(artifactPath(root, row.structured));
    if (structured.parserFingerprint !== row.parserFingerprint || structured.modelManifest !== run.modelManifest) {
      throw new Error('scientific_public_parser_fingerprint_changed');
    }
    return { ...identity, status: 'parsed', coordinateVerified: true, ...scorePublicStructurePage(gold, structured) };
  });
  const metrics = summarizePublicStructure(scores);
  const latencies = run.rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const report = { schemaVersion: 1, kind: 'scientific-public-raster-parser-component-baseline',
    status: 'measured', root, workingDirectory: ROOT, sourceLockHash: sources.sourceLockHash,
    runHash: hash(run), modelHashes: run.modelHashes, modelManifest: run.modelManifest,
    parserOptions: run.parserOptions, parserCodeHashes: run.codeHashes,
    scoringContract: structureScoringContract,
    scoringCodeHashes: Object.fromEntries(['scripts/score-scientific-public-parser.mjs',
      'evaluation/adapters/scientific-public/structure.mjs'].map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
    metrics, failedPages: scores.filter(score => score.status === 'failed').length,
    failures: scores.filter(score => score.status === 'failed').map(({ image, failureCode }) => ({ image, failureCode })),
    deterministicScoreHash: hash(scores),
    performance: { pageP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
      pageP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
      totalPageMs: latencies.reduce((sum, ms) => sum + ms, 0),
      sampledPeakRssBytes: Math.max(...run.rows.map(row => row.peakRssBytes)), pageSamples: run.pages },
    evidence: { verifiedSources: run.pages, verifiedArtifacts: run.rows.reduce((sum, row) => sum + row.artifacts.length, 0),
      goldPassedToParser: false, publishedAnnotationKind: 'upstream-human-assisted-expert-reviewed',
      rawScores: join(root, 'scores.json'), rawRun: runPath },
    limitations: [...run.limitations.filter(item => !item.includes('not yet been scored')),
      'Custom collapsed-category subset metrics; not official leaderboard scores.',
      'CER/WER align one-to-one IoU matched text regions, with unmatched gold deletions and unmatched predictions insertions.',
      'Reading-order pair denominator includes unmatched gold objects.',
      'Table cells and normalized formulas retain gold denominator even when detection fails.',
      'Explicit per-page parser failures stay in all gold denominators with zero recovery; no output or coordinate verification is asserted for them.',
      'Whitespace WER is not linguistic segmentation for Chinese.',
      'TEDS follows ordered-tree edit distance with tag/span and fractional character/markup token costs; normalization differs from upstream tooling.',
      'No complete-PDF version mapping, native/OCR fusion, cross-paper or Wiki score.'],
    scientificBaselineReady: false };
  writeJson(join(root, 'scores.json'), scores);
  writeJson(join(root, 'parser-baseline.json'), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/score-scientific-public-parser.mjs RUN_ROOT');
  try {
    const report = scoreScientificPublicParserRun(process.argv[2]);
    console.log(JSON.stringify({ root: report.root, metrics: report.metrics, performance: report.performance }, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
