import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {directory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {loadPublicQasper} from '../evaluation/adapters/scientific-public/data.mjs';
import {publicScientificSourceLock, verifyPublicScientificSources} from '../evaluation/adapters/scientific-public/sources.mjs';
import {scorePublicScientificWiki} from '../evaluation/adapters/scientific-public/wiki.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

export async function benchmarkScientificPublicWiki(datasetRoot, outputRoot) {
  const sources = verifyPublicScientificSources(), data = loadPublicQasper(datasetRoot);
  const cohort = new Set(readJson(publicScientificSourceLock).qasper.pdfCohort);
  const documents = data.documents.filter(document => cohort.has(document.sourceId));
  const root = directory(resolve(outputRoot), 'public-wiki');
  const packages = readJson(join(ROOT, 'package.json'));
  const external = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)];
  const entry = join(ROOT, 'evaluation/runtime/public-scientific-wiki.ts');
  const compiled = await build({entryPoints: [entry], bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', external, logLevel: 'silent'});
  const paths = [...new Set(['scripts/benchmark-scientific-public-wiki.mjs',
    'evaluation/adapters/scientific-public/wiki.mjs', 'evaluation/adapters/rag/evidence.mjs',
    'evaluation/adapters/scientific-public/data.mjs', 'evaluation/adapters/scientific-public/sources.mjs',
    'evaluation/lib/common.mjs', 'evaluation/lib/data.mjs', 'scripts/lib/bundle-ts.mjs', 'package.json', 'pnpm-lock.yaml',
    ...Object.keys(compiled.metafile.inputs)])].sort();
  const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
  const {runPublicScientificWiki} = await importTypeScriptModule(entry,
    {platform: 'node', external, tempDir: join(ROOT, 'evaluation/.runtime/imports')});
  const started = performance.now();
  const run = await runPublicScientificWiki({path: join(root, 'research.sqlite'), documents});
  writeJson(join(root, 'run.json'), run);
  const scoring = scorePublicScientificWiki(join(root, 'research.sqlite'), documents, run);
  writeJson(join(root, 'scores.json'), scoring.scores);
  const report = {schemaVersion: 1, kind: 'scientific-public-wiki-source-component-baseline',
    status: 'measured', root, workingDirectory: ROOT, measuredAt: new Date().toISOString(),
    sourceLockHash: sources.sourceLockHash, sourceHash: hash(documents),
    codeHashes, papers: documents.length, deterministicScoreHash: scoring.deterministicScoreHash,
    metrics: scoring.metrics, totalMs: performance.now() - started,
    metricReasons: {factCoverage: 'No independently annotated complete Wiki fact set or generation run.',
      generatedCitationValidity: 'No model generation. Source-copy citation validity is a separate deterministic component metric.'},
    limitations: ['Official text paragraphs, not original PDF locators.',
      'Capture first50 production chunks per paper; topics select first20, frozen independently of gold.',
      'Production page budget may truncate source copies. Prefix citation validity and exact-copy rate are distinct.',
      'Explicit evidence invalidation, not PDF reparse or asynchronous source replacement.',
      'Assistant source-copy probes only exercise retention/stale contracts; they are not model answers.',
      'No scientific support approval or invented human review.'], scientificBaselineReady: false};
  writeJson(join(root, 'wiki-baseline.json'), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/benchmark-scientific-public-wiki.mjs DATASET OUTPUT_PARENT');
  benchmarkScientificPublicWiki(process.argv[2], process.argv[3])
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => {console.error(error.stack); process.exitCode = 1;});
}
