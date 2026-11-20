import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { checkScientificRagCorpus, scientificManifestSchema } from '../lib/scientific-rag-corpus.mjs';
import { resolveScientificEvidenceGold, scientificEvidenceSourceSchema,
  scientificEvidenceResolutionContract } from '../lib/scientific-evidence-resolution.mjs';
import { observeScientificPdfStructure } from './scientific-pdf.mjs';
import { publicPdfArtifactPath } from './scientific-public/pdf.mjs';
import { loadSciegqaRetrievalInputs, sciegqaRetrievalProject,
  verifySciegqaRetrievalRun } from './scientific-public/sciegqa-retrieval-run.mjs';
import { readSciegqaIndex } from './scientific-public/sciegqa-retrieval.mjs';

const requireValue = (ok, code) => { if (!ok) throw new Error(`scientific_evidence_adapter_${code}`); };
const directory = path => {
  const root = resolve(path);
  requireValue(lstatSync(root).isDirectory() && realpathSync(root) === root, 'directory_invalid');
  return root;
};

/** Convert verified actual PDF predictions and independently reconstructed SQL
 * intervals into block observations; no human annotations are consulted. */
export function observeScientificEvidenceSources(source, state, pdfRun) {
  const byId = new Map(source.sources.map(s => [s.id, s]));
  const rows = pdfRun.rows.map(row => {
    const paperId = row.datasetPaperId, parsedSource = byId.get(paperId);
    const observation = observeScientificPdfStructure(row, source.structures.get(paperId) ?? null);
    if (row.status === 'failed') return scientificEvidenceSourceSchema.parse({
      projectId: sciegqaRetrievalProject, paperId, sourceHash: row.sourceHash,
      status: 'failed', failureCode: row.failure.code, parseRef: null, blocks: []
    });
    requireValue(parsedSource && parsedSource.sourceHash === row.sourceHash
      && hash(parsedSource.parsed) === parsedSource.resultHash, 'source_changed');
    const parseRef = { parseId: parsedSource.parseId, parseHash: parsedSource.resultHash,
      parserFingerprint: parsedSource.parsed.parserFingerprint };
    const chunks = state.chunks.filter(c => c.documentId === paperId);
    const blocks = observation.pages.flatMap(page => page.predictions.map(p => {
      const indexedRanges = chunks.filter(c => c.blockId === p.blockId).map(c => {
        requireValue(c.projectId === sciegqaRetrievalProject && c.paperId === paperId
          && c.sourceSha256 === row.sourceHash && c.parseId === parseRef.parseId
          && c.startOffset >= 0 && c.endOffset <= p.text.length
          && c.chunkHash === sha256(p.text.slice(c.startOffset, c.endOffset)), 'index_changed');
        return { chunkId: c.chunkId, range: { projectId: c.projectId, paperId, sourceHash: row.sourceHash,
          ...parseRef, blockId: p.blockId, page: page.page, start: c.startOffset, end: c.endOffset } };
      });
      return { id: p.id, blockId: p.blockId, page: page.page, kind: p.kind,
        bbox: p.bbox, text: p.text, indexedRanges };
    }));
    requireValue(blocks.flatMap(b => b.indexedRanges).length === chunks.length, 'index_block_unresolved');
    return scientificEvidenceSourceSchema.parse({ projectId: sciegqaRetrievalProject, paperId,
      sourceHash: row.sourceHash, status: 'parsed', failureCode: null, parseRef, blocks });
  });
  requireValue(new Set(rows.map(r => r.paperId)).size === rows.length
    && rows.filter(r => r.status === 'parsed').length === source.sources.length, 'source_cohort_changed');
  return rows;
}

/** Host entry point: full gold qualification precedes any gold-mode read.
 * Observation mode reuses saved real executions, never reruns inference. */
export async function resolveScientificEvidenceRun({ runRoot, manifestPath = null }) {
  let readiness = null, manifest = null, goldRoot = null;
  if (manifestPath) {
    readiness = await checkScientificRagCorpus(manifestPath);
    if (!readiness.corpusReady) return { schemaVersion: 1, kind: 'scientific-evidence-resolution-readiness',
      status: 'blocked', corpusReadiness: readiness, resolutions: null, scientificBaselineReady: false };
    goldRoot = directory(dirname(realpathSync(manifestPath)));
    manifest = scientificManifestSchema.parse(readJson(manifestPath));
  }
  const root = directory(runRoot);
  const verification = await verifySciegqaRetrievalRun(root);
  const inputs = readJson(publicPdfArtifactPath(root, 'inputs.json'));
  // Deliberately reconstruct raw sources again instead of trusting the prior
  // verifier's summary as a substitute for the objects used by this resolver.
  const source = await loadSciegqaRetrievalInputs(directory(inputs.pdfRoot), directory(inputs.correspondenceRoot));
  const state = readSciegqaIndex(publicPdfArtifactPath(root, 'research.sqlite'), source.sources, sciegqaRetrievalProject);
  requireValue(hash(state) === verification.indexHash, 'index_changed_during_resolution');
  const pdfRun = readJson(publicPdfArtifactPath(source.pdfRoot, 'run.json'));
  const observations = observeScientificEvidenceSources(source, state, pdfRun);
  const resolutions = [];
  if (manifest) {
    requireValue(hash(manifest.papers.map(p => [p.paperId, p.sourceHash]).sort())
      === hash(observations.map(p => [p.paperId, p.sourceHash]).sort()), 'gold_cohort_mismatch');
    const annotations = manifest.papers.map(p => {
      const bytes = readFileSync(publicPdfArtifactPath(goldRoot, p.annotationPath));
      requireValue(sha256(bytes) === p.annotationHash, 'gold_changed');
      return JSON.parse(bytes);
    });
    const queryBytes = readFileSync(publicPdfArtifactPath(goldRoot, manifest.queriesPath));
    requireValue(sha256(queryBytes) === manifest.queriesHash, 'queries_changed');
    for (const query of JSON.parse(queryBytes)) {
      resolutions.push(resolveScientificEvidenceGold(query, annotations, observations, sciegqaRetrievalProject));
    }
    const after = await checkScientificRagCorpus(manifestPath);
    requireValue(after.corpusReady && after.inputDigest === readiness.inputDigest, 'corpus_changed');
  }
  requireValue(hash(readSciegqaIndex(publicPdfArtifactPath(root, 'research.sqlite'),
    source.sources, sciegqaRetrievalProject)) === verification.indexHash, 'index_changed_during_resolution');
  return { schemaVersion: 1, kind: 'scientific-pdf-index-evidence-correspondence',
    status: manifest ? 'resolved-draft-correspondence' : 'verified-source-observations',
    contract: scientificEvidenceResolutionContract, root, verification, pdfVerification: source.verifiedPdf,
    corpusInputDigest: readiness?.inputDigest ?? null, observations, resolutions,
    deterministicObservationHash: hash(observations), deterministicResolutionHash: hash(resolutions),
    codeHashes: Object.fromEntries(['evaluation/lib/scientific-evidence-resolution.mjs',
      'evaluation/adapters/scientific-evidence-resolution.mjs', 'evaluation/adapters/scientific-pdf.mjs',
      'evaluation/adapters/scientific-public/sciegqa-retrieval.mjs',
      'evaluation/adapters/scientific-public/sciegqa-retrieval-run.mjs', 'scripts/resolve-scientific-evidence.mjs'
    ].map(p => [p, sha256(readFileSync(join(ROOT, p)))])),
    scientificBaselineReady: false,
    limitations: ['Saved SciEGQA BM25 runtime and source IDs only; no aliasing to a different gold paper ID.',
      'Exact one-to-one full block text/geometry only; OCR edits, ambiguous matches and split/merged blocks stay unresolved.',
      'Observation mode creates no gold, scientific span score or human-review assertion.',
      'No actual context reads are captured by this adapter; ranked hits do not prove assembled context.',
      'Resolved query mappings do not bind a new gold query to a historical search request.',
      'Complete gold, runtime/context receipts, scientific Wiki and reviewed contracts still gate Phase1.'] };
}
