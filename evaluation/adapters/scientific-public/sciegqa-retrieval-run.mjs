import {join, resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {hash, readJson, sha256} from '../../lib/common.mjs';
import {verifyRagSearch} from '../rag/evidence.mjs';
import {publicPdfArtifactPath} from './pdf.mjs';
import {verifySciegqaCohort} from './sciegqa-cohort.mjs';
import {sciegqaCohortPath, sciegqaCorpusRoot, verifySciegqaPdfRun} from './sciegqa-pdf.mjs';
import {loadSciegqaCorrespondence, mapSciegqaRegions, readSciegqaIndex,
  sciegqaRegionRetrievalContract, scoreSciegqaRegionRetrieval} from './sciegqa-retrieval.mjs';

export const sciegqaRetrievalProject = 'scientific-public-sciegqa';
export const sciegqaRetrievalConfig = {mode: 'bm25', rerank: 'none', candidateLimit: 80, topK: 20, contextMaxChars: 6000};

export function sciegqaFailure(error) {
  return {code: String(error?.code ?? error?.message ?? error) || 'scientific_sciegqa_search_failed'};
}

/** Validate saved executable bytes, not just two copies of their claimed hashes. */
export function verifySciegqaExecutionArtifacts(root, inputs) {
  const hashes = inputs.codeHashes, bundles = inputs.compiledBundleHashes;
  if (!hashes || !Object.keys(hashes).length || !Array.isArray(bundles) || bundles.length !== 1) {
    throw new Error('scientific_sciegqa_execution_identity_missing');
  }
  for (const [path, expected] of Object.entries(hashes)) {
    if (!/^[a-f0-9]{64}$/u.test(expected)
      || sha256(readFileSync(publicPdfArtifactPath(join(root, 'code'), path))) !== expected) {
      throw new Error('scientific_sciegqa_execution_code_changed');
    }
  }
  const bundle = bundles[0];
  if (bundle.name !== 'production-sciegqa-retrieval.mjs'
    || !/^[a-f0-9]{64}$/u.test(bundle.sha256)
    || sha256(readFileSync(publicPdfArtifactPath(root, `runtime/${bundle.name}`))) !== bundle.sha256) {
    throw new Error('scientific_sciegqa_execution_bundle_changed');
  }
}

export async function loadSciegqaRetrievalInputs(pdfRoot, correspondenceRoot) {
  pdfRoot = resolve(pdfRoot); correspondenceRoot = resolve(correspondenceRoot);
  const verifiedPdf = await verifySciegqaPdfRun(pdfRoot);
  const manifest = readJson(publicPdfArtifactPath(sciegqaCorpusRoot, 'manifest.json'));
  const labels = readJson(publicPdfArtifactPath(sciegqaCorpusRoot, 'labels.json'));
  const cohort = verifySciegqaCohort(readJson(sciegqaCohortPath), manifest, labels);
  const correspondence = loadSciegqaCorrespondence(correspondenceRoot, manifest, labels);
  const sources = [], structures = new Map();
  const run = readJson(publicPdfArtifactPath(pdfRoot, 'run.json'));
  for (const [i, paper] of cohort.papers.entries()) {
    const row = run.rows[i];
    if (row.status === 'failed') continue;
    const parsed = readJson(publicPdfArtifactPath(pdfRoot, row.result));
    const resultHash = verifiedPdf.rows[i].resultHash;
    if (hash(parsed) !== resultHash) throw new Error('scientific_sciegqa_retrieval_parse_changed');
    sources.push({id: paper.id, title: paper.docName, sourceUri: `https://arxiv.org/abs/${paper.docName}`,
      sourceHash: paper.pdf.sha256, resultHash, parseId: `evaluation-sciegqa:${resultHash}`, parsed});
    structures.set(paper.id, readJson(publicPdfArtifactPath(pdfRoot, row.structured)));
  }
  const byLabel = new Map(labels.map(q => [q.id, q]));
  const questions = cohort.papers.flatMap(p => p.questions.map(q => byLabel.get(q.id)));
  if (questions.length !== 225 || questions.some(q => !q)) {
    throw new Error('scientific_sciegqa_retrieval_cohort_incomplete');
  }
  return {pdfRoot, correspondenceRoot, verifiedPdf, cohort, correspondence, sources, structures, questions};
}

export function sciegqaSearchRequest(question) {
  const query = question.original.query.trim();
  if (!query) throw new Error('scientific_sciegqa_question_empty');
  return {query, projectId: sciegqaRetrievalProject, documentId: question.paperId,
    limit: 20, embeddingConfigId: null};
}

export function evaluateSciegqaQuery(question, correspondence, source, structured, receipt, state) {
  const request = sciegqaSearchRequest(question);
  if (hash(receipt.request) !== hash(request) || receipt.questionId !== question.id
    || receipt.publishedQuery !== question.original.query
    || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0) {
    throw new Error('scientific_sciegqa_query_receipt_changed');
  }
  const mapping = mapSciegqaRegions(question, correspondence, source, structured);
  if (receipt.failure === null) {
    if (!receipt.result || hash(receipt.result) !== receipt.resultHash) {
      throw new Error('scientific_sciegqa_query_result_changed');
    }
    const {ranking} = receipt.result;
    if (ranking?.candidateLimit !== sciegqaRetrievalConfig.candidateLimit
      || ranking.limit !== request.limit || ranking.route?.documentId !== request.documentId
      || ranking.embedding !== null || ranking.coverage?.vector !== 'not_searched'
      || ranking.reranker?.status !== 'not_requested'
      || receipt.result.vectorCount !== 0 || receipt.result.embeddingModel !== null
      || ranking.candidates.some(c => c.vectorRank !== null || c.rerankScore !== null)) {
      throw new Error('scientific_sciegqa_query_configuration_changed');
    }
    verifyRagSearch(receipt.result, state, request, sciegqaRetrievalProject);
  } else if (typeof receipt.failure?.code !== 'string' || !receipt.failure.code
    || receipt.result !== null || receipt.resultHash !== null) {
    throw new Error('scientific_sciegqa_query_failure_invalid');
  }
  const score = scoreSciegqaRegionRetrieval(mapping, receipt.result ?? {hits: []}, state, question.paperId);
  return {id: question.id, paperId: question.paperId, mapping,
    retrievalStatus: receipt.failure ? 'failed' : 'verified',
    productionParseStatus: source ? 'parsed' : 'failed',
    failureCode: receipt.failure?.code ?? null,
    rankingHash: receipt.result ? hash({query: receipt.result.query, hits: receipt.result.hits,
      ranking: receipt.result.ranking}) : null, ...score};
}

export function summarizeSciegqaRetrieval(rows) {
  const candidates = rows.filter(r => r.metrics !== null);
  return {queries: rows.length, sourceCandidateQueries: candidates.length,
    unqualifiedSourceQueries: rows.length - candidates.length,
    verifiedSearches: rows.filter(r => r.retrievalStatus === 'verified').length,
    failedSearches: rows.filter(r => r.retrievalStatus === 'failed').length,
    failedParseQueries: rows.filter(r => r.productionParseStatus === 'failed').length,
    candidateRegions: candidates.reduce((n, r) => n + r.regions, 0),
    mappedCandidateRegions: candidates.reduce((n, r) => n + r.mappedRegions, 0),
    ...Object.fromEntries([5, 10, 20].map(k => {
      const key = `candidateRegionBlockRecallAt${k}`;
      return [key, candidates.length ? candidates.reduce((n, r) => n + r.metrics[key], 0) / candidates.length : null];
    }))};
}

export function verifySciegqaRetrievalHeader(report, inputs, source) {
  const identities = source.sources.map(({parsed, ...identity}) => identity);
  if (report.schemaVersion !== 1 || report.kind !== 'scientific-sciegqa-production-pdf-bm25-component-baseline'
    || report.status !== 'measured-region-observations' || report.queries !== 225 || report.papers !== 45
    || report.parsedPapers !== source.sources.length || report.failedPapers !== source.verifiedPdf.failedPapers
    || report.parsedPapers + report.failedPapers !== 45
    || report.providerCalls !== 0 || report.storedEmbeddings !== 0 || report.embeddingCost !== null
    || report.qualityMetrics !== null || report.scientificBaselineReady !== false
    || report.nodeVersion !== inputs.nodeVersion
    || report.sourceLockHash !== source.cohort.sourceLockHash
    || report.cohortHash !== hash(source.cohort) || hash(inputs.contract) !== hash(sciegqaRegionRetrievalContract)
    || hash(inputs.config) !== hash(sciegqaRetrievalConfig) || hash(report.config) !== hash(inputs.config)
    || inputs.pdfVerificationHash !== hash(source.verifiedPdf)
    || inputs.correspondenceManifestHash !== source.correspondence.manifestHash
    || inputs.correspondenceInventoryHash !== source.correspondence.inventoryHash
    || hash(inputs.sourceIdentities) !== hash(identities)
    || hash(report.codeHashes) !== hash(inputs.codeHashes)) {
    throw new Error('scientific_sciegqa_retrieval_run_unqualified');
  }
}

export async function verifySciegqaRetrievalRun(root) {
  root = resolve(root);
  const inputs = readJson(publicPdfArtifactPath(root, 'inputs.json'));
  const report = readJson(publicPdfArtifactPath(root, 'report.json'));
  const source = await loadSciegqaRetrievalInputs(inputs.pdfRoot, inputs.correspondenceRoot);
  verifySciegqaRetrievalHeader(report, inputs, source);
  verifySciegqaExecutionArtifacts(root, inputs);
  const state = readSciegqaIndex(publicPdfArtifactPath(root, 'research.sqlite'),
    source.sources, sciegqaRetrievalProject);
  const storedIndex = readJson(publicPdfArtifactPath(root, 'index.json'));
  if (hash(state) !== storedIndex.indexHash || hash(storedIndex.state) !== hash(state)
    || report.indexHash !== hash(state) || !report.indexUnchanged) {
    throw new Error('scientific_sciegqa_retrieval_index_changed');
  }
  const rows = [];
  const correspondenceById = new Map(source.correspondence.alignment.map(q => [q.id, q]));
  const sourceById = new Map(source.sources.map(s => [s.id, s]));
  const latencies = [];
  for (const [i, q] of source.questions.entries()) {
    const receipt = readJson(publicPdfArtifactPath(root, `query-${i}.json`));
    rows.push(evaluateSciegqaQuery(q, correspondenceById.get(q.id), sourceById.get(q.paperId) ?? null,
      source.structures.get(q.paperId) ?? null, receipt, state));
    latencies.push(receipt.elapsedMs);
  }
  latencies.sort((a, b) => a - b);
  const measured = report.performance;
  if (!measured || measured.querySamples !== rows.length
    || measured.queryP50Ms !== latencies[Math.ceil(latencies.length * .5) - 1]
    || measured.queryP95Ms !== latencies[Math.ceil(latencies.length * .95) - 1]
    || !Number.isFinite(measured.indexMs) || measured.indexMs < 0
    || !Number.isFinite(measured.totalMs) || measured.totalMs < measured.indexMs
    || !Number.isFinite(measured.sampledPeakRssBytes) || measured.sampledPeakRssBytes <= 0) {
    throw new Error('scientific_sciegqa_retrieval_performance_changed');
  }
  if (hash(rows) !== report.deterministicScoreHash
    || hash(rows) !== hash(readJson(publicPdfArtifactPath(root, 'scores.json')))
    || hash(summarizeSciegqaRetrieval(rows)) !== hash(report.metrics)) {
    throw new Error('scientific_sciegqa_retrieval_scores_changed');
  }
  return {schemaVersion: 1, status: 'verified-region-observations', root, reportHash: hash(report),
    queries: rows.length, indexHash: hash(state), deterministicScoreHash: hash(rows),
    metrics: summarizeSciegqaRetrieval(rows), performance: measured, scientificBaselineReady: false};
}
