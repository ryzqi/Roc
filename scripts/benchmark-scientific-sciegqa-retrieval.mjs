import {existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {directory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {sciegqaCorpusRoot} from '../evaluation/adapters/scientific-public/sciegqa-pdf.mjs';
import {readSciegqaIndex, sciegqaRegionRetrievalContract} from '../evaluation/adapters/scientific-public/sciegqa-retrieval.mjs';
import {evaluateSciegqaQuery, loadSciegqaRetrievalInputs, sciegqaRetrievalConfig,
  sciegqaFailure, sciegqaRetrievalProject, sciegqaSearchRequest, summarizeSciegqaRetrieval}
  from '../evaluation/adapters/scientific-public/sciegqa-retrieval-run.mjs';

export async function benchmarkSciegqaRetrieval(pdfRoot, correspondenceRoot, outputParent) {
  outputParent = resolve(outputParent);
  const contains = (parent, child) => {
    const rel = relative(resolve(parent), resolve(child));
    return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if ([pdfRoot, correspondenceRoot, sciegqaCorpusRoot]
    .some(input => contains(input, outputParent) || contains(outputParent, input))) {
    throw new Error('scientific_sciegqa_retrieval_output_overlaps_input');
  }
  for (let current = outputParent;; current = resolve(current, '..')) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('scientific_sciegqa_retrieval_output_link');
    }
    if (resolve(current, '..') === current) break;
  }
  const source = await loadSciegqaRetrievalInputs(pdfRoot, correspondenceRoot);
  const packages = readJson(join(ROOT, 'package.json'));
  const external = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)];
  const entry = 'evaluation/runtime/production-sciegqa-retrieval.ts';
  const compiled = await build({absWorkingDir: ROOT, entryPoints: [join(ROOT, entry)], bundle: true,
    outfile: 'sciegqa-evaluation-in-memory/production-sciegqa-retrieval.mjs',
    format: 'esm', platform: 'node', target: 'node22', external, write: false, metafile: true, logLevel: 'silent'});
  const codePaths = [...new Set(['scripts/benchmark-scientific-sciegqa-retrieval.mjs',
    'evaluation/lib/common.mjs',
    'scripts/prepare-scientific-sciegqa.py', 'scripts/prepare-scientific-sciegqa-sources.py',
    'scripts/verify-scientific-sciegqa-retrieval.mjs',
    'evaluation/adapters/scientific-public/pdf.mjs',
    'evaluation/adapters/scientific-public/sciegqa-pdf.mjs',
    'evaluation/adapters/scientific-public/sciegqa-cohort.mjs',
    'evaluation/adapters/scientific-public/sciegqa-evidence.mjs',
    'evaluation/adapters/scientific-public/sciegqa-retrieval-run.mjs',
    'evaluation/adapters/scientific-public/sciegqa-retrieval.mjs',
    'evaluation/adapters/rag/evidence.mjs', 'package.json', 'pnpm-lock.yaml',
    ...Object.keys(compiled.metafile.inputs)])].sort();
  const codeHashes = Object.fromEntries(codePaths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
  const root = directory(outputParent, 'sciegqa-bm25');
  for (const path of codePaths) {
    const target = join(root, 'code', path);
    mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    writeFileSync(target, readFileSync(join(ROOT, path)), {flag: 'wx', mode: 0o600});
  }
  const bundlePath = join(root, 'runtime/production-sciegqa-retrieval.mjs');
  mkdirSync(dirname(bundlePath), {mode: 0o700});
  writeFileSync(bundlePath, compiled.outputFiles[0].contents, {flag: 'wx', mode: 0o600});
  writeJson(join(root, 'inputs.json'), {pdfRoot: source.pdfRoot, correspondenceRoot: source.correspondenceRoot,
    nodeVersion: process.version,
    pdfVerificationHash: hash(source.verifiedPdf), correspondenceManifestHash: source.correspondence.manifestHash,
    correspondenceInventoryHash: source.correspondence.inventoryHash, config: sciegqaRetrievalConfig,
    contract: sciegqaRegionRetrievalContract, sourceIdentities: source.sources.map(({parsed, ...identity}) => identity),
    codeHashes, compiledBundleHashes: compiled.outputFiles.map(f => ({
      name: f.path.split('/').at(-1), sha256: sha256(f.contents)}))});
  let runtime, peakRssBytes = process.memoryUsage().rss;
  const sample = () => {peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);};
  const timer = setInterval(sample, 20), signal = AbortSignal.timeout(20 * 60_000);
  const started = performance.now(), latencies = [], rows = [];
  try {
    const {openSciegqaRetrieval} = await import(pathToFileURL(bundlePath).href);
    const dbPath = join(root, 'research.sqlite');
    runtime = await openSciegqaRetrieval({path: dbPath, sources: source.sources, projectId: sciegqaRetrievalProject,
      config: sciegqaRetrievalConfig, signal});
    sample();
    const indexMs = performance.now() - started;
    const state = readSciegqaIndex(dbPath, source.sources, sciegqaRetrievalProject), indexHash = hash(state);
    writeJson(join(root, 'index.json'), {indexHash, state});
    const bySource = new Map(source.sources.map(s => [s.id, s]));
    const byCorrespondence = new Map(source.correspondence.alignment.map(q => [q.id, q]));
    for (const [i, q] of source.questions.entries()) {
      const request = sciegqaSearchRequest(q), queryStarted = performance.now();
      let result = null, failure = null;
      try {result = await runtime.search(request, signal);}
      catch (error) {failure = sciegqaFailure(error);}
      const elapsedMs = performance.now() - queryStarted; latencies.push(elapsedMs); sample();
      const receipt = {questionId: q.id, publishedQuery: q.original.query, request, result,
        resultHash: result ? hash(result) : null, failure, elapsedMs};
      writeJson(join(root, `query-${i}.json`), receipt);
      rows.push(evaluateSciegqaQuery(q, byCorrespondence.get(q.id), bySource.get(q.paperId) ?? null,
        source.structures.get(q.paperId) ?? null, receipt, state));
      if ((i + 1) % 25 === 0) console.error(`Observed SciEGQA retrieval ${i + 1}/225`);
    }
    await runtime.close(); runtime = null;
    if (hash(readSciegqaIndex(dbPath, source.sources, sciegqaRetrievalProject)) !== indexHash) {
      throw new Error('scientific_sciegqa_retrieval_index_changed');
    }
    sample(); latencies.sort((a, b) => a - b);
    writeJson(join(root, 'scores.json'), rows);
    const report = {schemaVersion: 1, kind: 'scientific-sciegqa-production-pdf-bm25-component-baseline',
      status: 'measured-region-observations', root, workingDirectory: ROOT, command: process.argv,
      nodeVersion: process.version, measuredAt: new Date().toISOString(),
      sourceLockHash: source.cohort.sourceLockHash, cohortHash: hash(source.cohort),
      config: sciegqaRetrievalConfig, codeHashes, queries: rows.length, papers: source.cohort.papers.length,
      parsedPapers: source.sources.length, failedPapers: source.verifiedPdf.failedPapers,
      indexHash, indexUnchanged: true, deterministicScoreHash: hash(rows), metrics: summarizeSciegqaRetrieval(rows),
      performance: {indexMs, queryP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
        queryP95Ms: latencies[Math.ceil(latencies.length * .95) - 1], querySamples: rows.length,
        totalMs: performance.now() - started, sampledPeakRssBytes: peakRssBytes},
      providerCalls: 0, storedEmbeddings: 0, embeddingCost: null, qualityMetrics: null, scientificBaselineReady: false,
      limitations: ['All45 preselected papers/225 original human questions retained, including parse/search failures.',
        'Unqualified source questions remain null; candidate region recall includes failed parses/searches as misses.',
        'Any verified child text hit from a type-compatible parent with IoU>=0.5; not complete evidence-span recall.',
        'Mechanical region/block observation does not establish original glyph/answer or human locator accuracy.',
        'Original answers and evidence never enter production parser, IR, indexing or search runtime.',
        'Document-scoped BM25/no-rerank; no cross-paper, dense/visual, answer generation, Wiki or provider-cost score.',
        '20ms/boundary RSS samples can miss synchronous peaks; index latency excludes PDF parsing/source verification.']};
    writeJson(join(root, 'report.json'), report); return report;
  } catch (error) {
    writeJson(join(root, 'failure.json'), {status: 'failed', root, completedQueries: rows.length,
      ...sciegqaFailure(error)}); throw error;
  } finally {clearInterval(timer); if (runtime) await runtime.close();}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: node scripts/benchmark-scientific-sciegqa-retrieval.mjs PDF_RUN CORRESPONDENCE_ROOT OUTPUT_PARENT');
  benchmarkSciegqaRetrieval(...process.argv.slice(2)).then(r => console.log(JSON.stringify({
    root: r.root, metrics: r.metrics, performance: r.performance, deterministicScoreHash: r.deterministicScoreHash
  }, null, 2))).catch(error => {console.error(error.stack); process.exitCode = 1;});
}
