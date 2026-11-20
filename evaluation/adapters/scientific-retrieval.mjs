import Database from 'better-sqlite3';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { checkScientificRagCorpus, scientificManifestSchema } from '../lib/scientific-rag-corpus.mjs';
import { bindScientificEvidenceQuery, validateScientificQuerySelections,
  summarizeScientificQueryBindings } from '../lib/scientific-query-binding.mjs';
import { scientificContextReadPolicy, scientificRetrievalSourceIndex,
  observeScientificRetrievalEvidence } from '../lib/scientific-retrieval-observations.mjs';
import { resolveScientificEvidenceRun } from './scientific-evidence-resolution.mjs';
import { publicPdfArtifactPath } from './scientific-public/pdf.mjs';

const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_retrieval_adapter_${code}`); };

/** Validate saved NEW context receipts without invoking readContext again.
 * Caller must first independently reconstruct sources and the saved run. */
export function readScientificSavedContext(path, source, state, receipts, sqlParents) {
  const sourceIndex = scientificRetrievalSourceIndex(state, source.observations);
  if (!path) return { reportHash: null, observations: receipts.map(r =>
    observeScientificRetrievalEvidence(r, sourceIndex, sqlParents)) };
  const bytes = readFileSync(path), report = JSON.parse(bytes);
  requireValue(report.schemaVersion === 1 && report.kind === 'scientific-saved-ranking-new-production-context-reads'
    && report.root === source.root && hash(report.savedRunVerification) === hash(source.verification)
    && report.sourceObservationHash === source.deterministicObservationHash
    && report.scientificBaselineReady === false && report.databaseUnchanged === true
    && report.nodeVersion === process.version && Number.isFinite(Date.parse(report.measuredAt))
    && report.databaseByteHash === sha256(readFileSync(publicPdfArtifactPath(source.root, 'research.sqlite')))
    && hash(report.policy) === hash(scientificContextReadPolicy), 'context_identity_changed');
  const packages = readJson(join(ROOT, 'package.json'));
  const compiled = buildSync({ absWorkingDir: ROOT,
    entryPoints: ['src/main/plugins/research/knowledge-repository.ts'], bundle: true,
    outfile: 'scientific-context-in-memory.mjs', format: 'esm', platform: 'node', target: 'node22',
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
    write: false, metafile: true, logLevel: 'silent' });
  const required = [...new Set([...Object.keys(compiled.metafile.inputs),
    'evaluation/adapters/scientific-context-reads.mjs',
    'evaluation/lib/scientific-retrieval-observations.mjs', 'evaluation/lib/common.mjs',
    'evaluation/lib/scientific-evidence-resolution.mjs', 'evaluation/lib/scientific-evidence-scoring.mjs',
    'scripts/capture-scientific-context-reads.mjs', 'package.json', 'pnpm-lock.yaml'])].sort();
  requireValue(hash(Object.keys(report.codeHashes ?? {}).sort()) === hash(required)
    && report.compiledHash === sha256(compiled.outputFiles[0].contents)
    && hash(report.sourceResolverCodeHashes) === hash(source.codeHashes), 'context_code_pins_missing');
  for (const [p, h] of Object.entries(report.codeHashes)) {
    // Code paths come from the original compiler input map, never arbitrary
    // filesystem reads or absolute paths supplied by a report.
    requireValue(!p.startsWith('/') && !p.split(/[\\/]/u).includes('..')
      && /^(src\/|evaluation\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/u.test(p), 'context_code_path_invalid');
    requireValue(sha256(readFileSync(join(ROOT, p))) === h, 'context_code_changed');
  }
  requireValue(Array.isArray(report.rows) && report.rows.length === receipts.length, 'context_cohort_changed');
  const observations = receipts.map((receipt, i) => {
    const row = report.rows[i];
    requireValue(row.queryId === receipt.questionId && row.publishedQuery === receipt.publishedQuery
      && hash(row.request) === hash(receipt.request) && row.savedReceiptHash === hash(receipt)
      && Array.isArray(row.reads), 'context_query_changed');
    const observation = observeScientificRetrievalEvidence(receipt, sourceIndex, sqlParents, row.reads);
    requireValue(hash(observation) === hash(row.observation), 'context_observation_changed');
    const deterministicHash = hash({ queryId: row.queryId, request: row.request,
      reads: row.reads.map(({ startedAt, completedAt, elapsedMs, ...r }) => r), observation });
    requireValue(deterministicHash === row.deterministicHash, 'context_result_changed');
    return observation;
  });
  requireValue(report.deterministicObservationHash === hash(report.rows.map(r => r.deterministicHash)),
    'context_summary_changed');
  const failedReads = report.rows.flatMap(r => r.reads).filter(r => r.failure !== null).length;
  const counts = { queries: receipts.length, reads: report.rows.reduce((n, r) => n + r.reads.length, 0),
    failedReads, rankedItems: observations.reduce((n, o) => n + o.ranking.items.length, 0),
    contextItems: observations.reduce((n, o) => n + o.context.items.length, 0),
    invalidLocators: observations.flatMap(o => [...o.ranking.items, ...o.context.items])
      .flatMap(i => i.locators).filter(l => l.status === 'invalid').length };
  requireValue(hash(report.counts) === hash(counts) && report.status === (failedReads > 0
    ? 'captured-with-context-failures' : 'verified-new-context-observations'), 'context_counts_changed');
  return { reportHash: sha256(bytes), observations };
}

/** Full corpus qualification precedes saved-run, binding or context access.
 * This does not rerun models/search/context or claim a qualified baseline. */
export async function scoreScientificRetrievalRun({ runRoot,
  manifestPath = `${ROOT}/evaluation/corpora/scientific-rag/manifest.json`, bindingsPath, contextPath = null }) {
  requireValue(typeof manifestPath === 'string' && manifestPath.length > 0, 'manifest_required');
  const codePaths = ['evaluation/adapters/scientific-retrieval.mjs', 'evaluation/lib/scientific-query-binding.mjs',
    'evaluation/lib/scientific-retrieval-observations.mjs', 'evaluation/lib/scientific-evidence-scoring.mjs',
    'evaluation/lib/scientific-rag-corpus.mjs', 'evaluation/lib/common.mjs', 'scripts/score-scientific-retrieval.mjs'];
  const codeHashes = Object.fromEntries(codePaths.map(p => [p, sha256(readFileSync(join(ROOT, p)))]));
  const source = await resolveScientificEvidenceRun({ runRoot, manifestPath });
  if (source.status === 'blocked') return { schemaVersion: 1, kind: 'scientific-retrieval-scoring-readiness',
    status: 'blocked', corpusReadiness: source.corpusReadiness, scores: null, scientificBaselineReady: false };
  const manifest = scientificManifestSchema.parse(readJson(manifestPath)), goldRoot = dirname(resolve(manifestPath));
  const queryBytes = readFileSync(publicPdfArtifactPath(goldRoot, manifest.queriesPath));
  requireValue(sha256(queryBytes) === manifest.queriesHash, 'gold_queries_changed');
  const queries = JSON.parse(queryBytes), indexPath = publicPdfArtifactPath(source.root, 'index.json');
  const indexBytes = readFileSync(indexPath), state = JSON.parse(indexBytes).state;
  requireValue(hash(state) === source.verification.indexHash, 'saved_index_changed');
  const receiptPaths = Array.from({ length: source.verification.queries }, (_, i) =>
    publicPdfArtifactPath(source.root, `query-${i}.json`));
  const receiptBytes = receiptPaths.map(p => readFileSync(p)), receipts = receiptBytes.map(b => JSON.parse(b));
  requireValue(new Set(receipts.map(r => r.questionId)).size === receipts.length, 'duplicate_saved_query');
  const dbPath = publicPdfArtifactPath(source.root, 'research.sqlite'), dbBytes = readFileSync(dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let sqlParents;
  try { sqlParents = db.prepare(`SELECT c.id,c.document_id AS documentId,c.chunk_index AS 'index'
    FROM research_knowledge_chunks c JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
    WHERE s.parent_chunk_id IS NULL ORDER BY c.document_id,c.chunk_index`).all(); }
  finally { db.close(); }
  const context = readScientificSavedContext(contextPath, source, state, receipts, sqlParents);
  const bindingBytes = readFileSync(bindingsPath), bindings = validateScientificQuerySelections(
    JSON.parse(bindingBytes), queries, source.corpusInputDigest, source.verification.indexHash, context.reportHash);
  requireValue(source.resolutions.length === queries.length, 'resolution_cohort_changed');
  const rows = queries.map((query, i) => {
    const entry = bindings.entries[i], at = entry.status === 'selected'
      ? receipts.findIndex(r => r.questionId === entry.publishedQueryId) : -1;
    requireValue(entry.status === 'unavailable' || at >= 0, 'selected_query_missing');
    return bindScientificEvidenceQuery({ query, resolution: source.resolutions[i], sources: source.observations,
      papers: manifest.papers, entry, receipt: at < 0 ? null : receipts[at],
      observation: at < 0 ? null : context.observations[at] });
  });
  const after = await checkScientificRagCorpus(manifestPath);
  requireValue(after.corpusReady && after.inputDigest === source.corpusInputDigest, 'gold_corpus_changed');
  requireValue(readFileSync(dbPath).equals(dbBytes) && readFileSync(indexPath).equals(indexBytes)
    && receiptPaths.every((p, i) => readFileSync(p).equals(receiptBytes[i]))
    && readFileSync(bindingsPath).equals(bindingBytes)
    && (!contextPath || sha256(readFileSync(contextPath)) === context.reportHash), 'saved_inputs_changed');
  requireValue(Object.entries(codeHashes).every(([p, h]) => sha256(readFileSync(join(ROOT, p))) === h),
    'scoring_code_changed');
  return { ...summarizeScientificQueryBindings(rows), corpusInputDigest: source.corpusInputDigest,
    bindingsByteHash: sha256(bindingBytes), contextReportHash: context.reportHash,
    savedRunVerification: source.verification, sourceObservationHash: source.deterministicObservationHash,
    codeHashes, sourceResolverCodeHashes: source.codeHashes,
    limitations: ['Only explicit same-text, same-source singleton saved requests can bind.',
      'Cross-paper or missing saved queries remain unbound/NA in the full gold denominator.',
      'New fixed-policy reads are distinct from historical/agent-assembled context; absent context stays unavailable.',
      'No inferred answer correctness, human gold, scientific Wiki judgment or full qualified repeatable baseline.'] };
}
