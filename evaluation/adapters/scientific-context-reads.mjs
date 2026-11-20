import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { resolveScientificEvidenceRun } from './scientific-evidence-resolution.mjs';
import { publicPdfArtifactPath } from './scientific-public/pdf.mjs';
import { scientificContextReadPolicy, scientificContextRequests, scientificRetrievalSourceIndex,
  observeScientificRetrievalEvidence } from '../lib/scientific-retrieval-observations.mjs';

export function scientificContextRepository(db, Repository) {
  return new Repository(db, id => {
    if (!db.prepare('SELECT id FROM research_projects WHERE id=?').get(id)) {
      throw new Error('research_project_not_found');
    }
  }, () => new Date().toISOString());
}

/** Capture new, explicit calls to the production repository over the SAVED,
 * read-only DB. No search/ingestion/model replay or historical context claim. */
export async function captureScientificContextReads(runRoot) {
  const root = resolve(runRoot), source = await resolveScientificEvidenceRun({ runRoot: root });
  const dbPath = publicPdfArtifactPath(root, 'research.sqlite'), dbBytes = readFileSync(dbPath);
  const state = readJson(publicPdfArtifactPath(root, 'index.json')).state;
  if (hash(state) !== source.verification.indexHash) throw new Error('scientific_context_index_changed');
  const sourceIndex = scientificRetrievalSourceIndex(state, source.observations);
  const packages = readJson(join(ROOT, 'package.json')), entry = 'src/main/plugins/research/knowledge-repository.ts';
  const compiled = await build({ absWorkingDir: ROOT, entryPoints: [entry], bundle: true,
    outfile: 'scientific-context-in-memory.mjs', format: 'esm', platform: 'node', target: 'node22',
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
    write: false, metafile: true, logLevel: 'silent' });
  const codePaths = [...new Set([...Object.keys(compiled.metafile.inputs), 'package.json', 'pnpm-lock.yaml',
    'evaluation/adapters/scientific-context-reads.mjs', 'evaluation/lib/scientific-retrieval-observations.mjs',
    'evaluation/lib/scientific-evidence-scoring.mjs', 'evaluation/lib/scientific-evidence-resolution.mjs',
    'scripts/capture-scientific-context-reads.mjs', 'evaluation/lib/common.mjs'])].sort();
  const codeHashes = Object.fromEntries(codePaths.map(p => [p, sha256(readFileSync(join(ROOT, p)))]));
  const temporaryDir = join(ROOT, 'evaluation/.runtime/imports');
  mkdirSync(temporaryDir, { recursive: true });
  const temporary = join(temporaryDir, `scientific-context-${randomUUID()}.mjs`);
  writeFileSync(temporary, compiled.outputFiles[0].contents, { flag: 'wx', mode: 0o600 });
  const rows = [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const { ResearchKnowledgeRepository } = await import(pathToFileURL(temporary).href);
    const repository = scientificContextRepository(db, ResearchKnowledgeRepository);
    const sqlParents = db.prepare(`SELECT c.id,c.document_id AS documentId,c.chunk_index AS 'index'
      FROM research_knowledge_chunks c JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
      WHERE s.parent_chunk_id IS NULL ORDER BY c.document_id,c.chunk_index`).all();
    for (let i = 0; i < source.verification.queries; i++) {
      const receipt = readJson(publicPdfArtifactPath(root, `query-${i}.json`));
      const reads = scientificContextRequests(receipt, state).map(request => {
        const startedAt = new Date().toISOString(), started = performance.now();
        let result = null, failure = null;
        try { result = repository.readContext(request); }
        catch (error) { failure = { code: error instanceof Error ? error.message : 'unknown-context-failure' }; }
        return { request, startedAt, completedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
          result, resultHash: result ? hash(result) : null, failure };
      });
      const observation = observeScientificRetrievalEvidence(receipt, sourceIndex, sqlParents, reads);
      rows.push({ queryId: receipt.questionId, publishedQuery: receipt.publishedQuery, request: receipt.request,
        savedReceiptHash: hash(receipt), reads, observation,
        deterministicHash: hash({ queryId: receipt.questionId, request: receipt.request,
          reads: reads.map(({ startedAt, completedAt, elapsedMs, ...r }) => r), observation }) });
    }
  } finally {
    try { db?.close(); } finally { rmSync(temporary); }
  }
  if (!readFileSync(dbPath).equals(dbBytes)) throw new Error('scientific_context_database_changed');
  for (const [p, h] of Object.entries(codeHashes)) {
    if (sha256(readFileSync(join(ROOT, p))) !== h) throw new Error('scientific_context_code_changed');
  }
  return { schemaVersion: 1, kind: 'scientific-saved-ranking-new-production-context-reads',
    status: rows.some(r => r.reads.some(read => read.failure !== null))
      ? 'captured-with-context-failures' : 'verified-new-context-observations',
    root, measuredAt: new Date().toISOString(),
    policy: scientificContextReadPolicy, sourceObservationHash: source.deterministicObservationHash,
    savedRunVerification: source.verification, sourceResolverCodeHashes: source.codeHashes,
    codeHashes, nodeVersion: process.version, compiledHash: sha256(compiled.outputFiles[0].contents),
    databaseByteHash: sha256(dbBytes), databaseUnchanged: true, rows,
    deterministicObservationHash: hash(rows.map(r => r.deterministicHash)),
    counts: { queries: rows.length, reads: rows.reduce((n, r) => n + r.reads.length, 0),
      failedReads: rows.flatMap(r => r.reads).filter(r => r.failure !== null).length,
      rankedItems: rows.reduce((n, r) => n + r.observation.ranking.items.length, 0),
      contextItems: rows.reduce((n, r) => n + r.observation.context.items.length, 0),
      invalidLocators: rows.flatMap(r => [...r.observation.ranking.items, ...r.observation.context.items])
        .flatMap(i => i.locators).filter(l => l.status === 'invalid').length },
    scientificBaselineReady: false,
    limitations: ['New production repository reads selected by fixed policy; no historical or agent-assembled context.',
      'Original published query IDs only; no alias/binding to a newly supplied gold query.',
      'No scientific gold/spans/categories, answer judgment, full-span quality score or qualified baseline.',
      'Saved BM25/no-rerank ranking only; no new search, provider call, ingestion or model inference.',
      'Context is a set of separately read items; duplicate neighbors retained, no generated prompt or synthesis.'] };
}
