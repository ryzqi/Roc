import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';
import { directory, hash, readJson, ROOT, sha256, writeJson } from '../evaluation/lib/common.mjs';
import { loadPublicQasper, publicQasperSearchRequest, scoreQasperRetrieval } from '../evaluation/adapters/scientific-public/data.mjs';
import { verifyPublicScientificSources } from '../evaluation/adapters/scientific-public/sources.mjs';
import { readRagState, verifyRagSearch } from '../evaluation/adapters/rag/evidence.mjs';

export async function benchmarkPublicScientificRetrieval(datasetRoot, outputRoot) {
  const sources = verifyPublicScientificSources();
  const imported = loadPublicQasper(datasetRoot);
  const tasks = imported.pdfCohortTasks;
  if (tasks.length < 200 || sources.pdfCount !== 45) throw new Error('scientific_public_cohort_incomplete');
  const packages = readJson(join(ROOT, 'package.json'));
  const { openProductionRag } = await importTypeScriptModule(join(ROOT, 'evaluation/runtime/production-rag.ts'), {
    platform: 'node', external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
    tempDir: join(ROOT, 'evaluation/.runtime/imports')
  });
  const root = directory(resolve(outputRoot), 'qasper-bm25');
  const config = { mode: 'bm25', rerank: 'none', candidateLimit: 80, topK: 20, contextMaxChars: 6000 };
  const started = performance.now(), signal = AbortSignal.timeout(20 * 60_000);
  const documents = imported.documents.map(document => ({ ...document,
    blocks: document.blocks.map(({ id: ignored, ...block }) => block) }));
  writeJson(join(root, 'published-annotations.json'), tasks.map(task => ({
    id: task.id, paperId: task.clusterId, split: task.split, publishedAnnotation: task.publishedAnnotation
  })));
  const dbPath = join(root, 'research.sqlite');
  const runtime = await openProductionRag({ path: dbPath, documents, config, signal,
    projectId: 'scientific-public-qasper' });
  const indexMs = performance.now() - started;
  try {
    const initial = readRagState(dbPath, documents), indexHash = hash(initial);
    writeJson(join(root, 'index.json'), { indexHash, state: initial });
    const rows = [];
    for (const [i, task] of tasks.entries()) {
      const document = imported.documents.find(doc => doc.sourceId === task.clusterId);
      const request = publicQasperSearchRequest(task, document);
      const queryStarted = performance.now();
      const result = await runtime.search(request, signal);
      const elapsedMs = performance.now() - queryStarted;
      const artifact = `search-${i}.json`;
      writeJson(join(root, artifact), { taskId: task.id, publishedQuestion: task.visible.question,
        request, result, resultHash: hash(result) });
      verifyRagSearch(result, initial, request, document.projectId);
      const score = scoreQasperRetrieval(task, result, initial, document);
      rows.push({ id: task.id, paperId: task.clusterId, split: task.split, elapsedMs, artifact,
        rankingHash: hash({ query: result.query, hits: result.hits, ranking: result.ranking }), ...score });
      if ((i + 1) % 50 === 0) console.error(`Verified retrieval ${i + 1}/${tasks.length}`);
    }
    const final = readRagState(dbPath, documents);
    if (hash(final) !== indexHash) throw new Error('scientific_public_index_changed');
    writeJson(join(root, 'scores.json'), rows);
    const scoreSummary = selected => {
      const answerable = selected.filter(row => !row.unanswerable);
      const mean = key => answerable.length ? answerable.reduce((sum, row) => sum + row[key], 0) / answerable.length : null;
      return { queries: selected.length, answerableEvidenceQueries: answerable.length,
        unanswerableQueries: selected.length - answerable.length,
        evidenceRecallAt5: mean('evidenceRecallAt5'), evidenceRecallAt10: mean('evidenceRecallAt10'),
        evidenceRecallAt20: mean('evidenceRecallAt20'), evidenceCompletionMRRAt20: mean('reciprocalRank'),
        chunkRecallAt5: mean('chunkRecallAt5'), chunkRecallAt10: mean('chunkRecallAt10'),
        chunkRecallAt20: mean('chunkRecallAt20'), mrrAt10: mean('reciprocalRankAt10'), ndcgAt10: mean('ndcgAt10') };
    };
    const latencies = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
    const report = { schemaVersion: 1, kind: 'scientific-public-qasper-scoped-bm25-component-baseline',
      status: 'measured', root, command: process.argv, workingDirectory: ROOT, nodeVersion: process.version,
      measuredAt: new Date().toISOString(), sourceLockHash: sources.sourceLockHash,
      qasperQualificationHash: imported.dataset.qasperQualification.hash,
      adaptedTasksHash: hash(tasks), sourceDocumentsHash: hash(documents), config,
      production: 'evaluation/runtime/production-rag.ts', verifier: 'evaluation/adapters/rag/evidence.mjs',
      inputs: { documents: documents.length, pdfCohort: sources.pdfCount, queries: rows.length },
      metrics: scoreSummary(rows), splits: Object.fromEntries(['development', 'holdout'].map(split =>
        [split, scoreSummary(rows.filter(row => row.split === split))])),
      performance: { indexMs, queryP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
        queryP95Ms: latencies[Math.ceil(latencies.length * .95) - 1], querySamples: rows.length },
      evidence: { indexHash, indexUnchanged: true, verifiedSearches: rows.length, modelCalls: 0 },
      deterministicScoreHash: hash(rows.map(({ elapsedMs, artifact, ...row }) => row)),
      codeHashes: Object.fromEntries(['scripts/benchmark-scientific-public-retrieval.mjs',
        'evaluation/adapters/scientific-public/data.mjs', 'evaluation/runtime/production-rag.ts',
        'evaluation/adapters/rag/evidence.mjs', 'src/main/plugins/research/knowledge-repository.ts',
        'src/main/plugins/research/embedding-service.ts', 'src/main/plugins/research/knowledge-chunks.ts', 'pnpm-lock.yaml']
        .map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
      limitations: ['Published public holdout does not establish model non-exposure.',
        'Paper-scoped official text paragraphs; PDF extraction and page/bbox mapping are not measured.',
        'Full evidence paragraphs require union coverage by retrieved child chunks; max recall over upstream nonempty evidence references.',
        'Binary chunk relevance uses positive interval overlap with published evidence; best metric over upstream nonempty references.',
        'Unanswerable queries are counted separately; retrieval alone cannot measure abstention or answer quality.',
        'No cross-paper, semantic embedding/reranking, scientific object or Wiki/update score.'],
      scientificBaselineReady: false };
    writeJson(join(root, 'report.json'), report);
    return report;
  } catch (error) {
    writeJson(join(root, 'failure.json'), { status: 'failed', code: error.message, root });
    throw error;
  } finally { await runtime.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: node scripts/benchmark-scientific-public-retrieval.mjs DATASET_ROOT OUTPUT_PARENT');
  mkdirSync(resolve(args[1]), { recursive: true });
  benchmarkPublicScientificRetrieval(resolve(args[0]), resolve(args[1])).then(report =>
    console.log(JSON.stringify({ root: report.root, metrics: report.metrics, performance: report.performance }, null, 2)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
