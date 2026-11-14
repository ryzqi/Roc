import Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { hash, sha256 } from '../../lib/common.mjs';

const descriptor = Object.freeze({
  version: 1, runtime: 'roc-research-repository-embedding-service',
  sourceMapping: 'source-version-sha256-parser-utf16-v1',
  toolBoundary: 'checkpoint-tool-message-bound-to-host-capability-receipt-v1',
  verification: 'sqlite-source-ranking-context-transport-v1'
});
export const ragContract = Object.freeze({ ...descriptor, hash: hash(descriptor) });
const retrievalDescriptor = Object.freeze({
  ...descriptor, toolBoundary: 'host-component-request-bound-to-capability-receipt-v1'
});
export const ragRetrievalContract = Object.freeze({ ...retrievalDescriptor, hash: hash(retrievalDescriptor) });

// Independent SQL verifier: no repository, embedding, ranking or production
// verification helper imports. The database is evaluated as persisted evidence.
export function readRagState(path, sources) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('rag_database_not_regular');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('rag_database_corrupt');
    const documents = db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all();
    const chunks = db.prepare(`SELECT c.*,s.parent_chunk_id,s.start_utf16,s.end_utf16,s.section,m.metadata_json AS semantic_json
      FROM research_knowledge_chunks c LEFT JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
      LEFT JOIN research_knowledge_chunk_semantics m ON m.chunk_id=c.id ORDER BY c.id`).all();
    const byId = new Map(chunks.map(c => [c.id, c])), sourceById = new Map(sources.map(s => [s.id, s]));
    const versionDocuments = new Map();
    for (const document of documents) {
      const source = sourceById.get(document.id), metadata = JSON.parse(document.metadata_json);
      if (!source?.current || document.source_id !== source.sourceId || document.project_id !== source.projectId
        || document.title !== source.title || document.source_type !== source.sourceType
        || document.content !== source.content || document.content_hash !== source.contentSha256
        || sha256(document.content) !== document.content_hash || metadata.sourceVersion !== source.sourceVersion
        || metadata.sourceHash !== source.contentSha256 || metadata.parserVersion !== source.parserVersion) throw new Error('rag_index_source_mismatch');
      versionDocuments.set(document.id, { document_hash: document.content_hash, document_project: document.project_id,
        title: document.title, source_type: document.source_type, source_id: document.source_id, metadata_json: document.metadata_json });
    }
    if (documents.length !== sources.filter(s => s.current).length) throw new Error('rag_index_document_missing');
    const mapped = chunks.map(chunk => {
      const source = sourceById.get(chunk.document_id), parent = chunk.parent_chunk_id ? byId.get(chunk.parent_chunk_id) : chunk;
      if (!source || !parent || parent.document_id !== chunk.document_id || parent.parent_chunk_id !== null) throw new Error('rag_index_parent_invalid');
      const locator = /^utf16:(\d+)-(\d+)$/u.exec(parent.locator ?? '');
      if (!locator) throw new Error('rag_index_locator_invalid');
      const parentStart = Number(locator[1]), parentEnd = Number(locator[2]);
      if (source.content.slice(parentStart, parentEnd) !== parent.content || !source.blocks.some(b => b.startOffset === parentStart && b.endOffset === parentEnd)
        || chunk.content_hash !== sha256(chunk.content) || parent.content.slice(chunk.start_utf16, chunk.end_utf16) !== chunk.content
        || chunk.project_id !== source.projectId || chunk.start_utf16 < 0 || chunk.end_utf16 > parent.content.length
        || chunk.end_utf16 <= chunk.start_utf16) throw new Error('rag_index_span_invalid');
      const semantic = JSON.parse(chunk.semantic_json);
      if (semantic.sourceHash !== source.contentSha256 || semantic.parseId !== source.parserVersion) throw new Error('rag_index_semantics_invalid');
      const fields = { document_id: chunk.document_id, content_hash: chunk.content_hash, locator: chunk.locator, project_id: chunk.project_id };
      const indexedVersion = sha256(JSON.stringify({ ...fields, ...versionDocuments.get(chunk.document_id), semantic }));
      return { chunkId: chunk.id, parentChunkId: parent.id, documentId: source.id, projectId: source.projectId,
        paperId: semantic.paperId,
        sourceId: source.sourceId, sourceVersion: source.sourceVersion, sourceSha256: source.contentSha256,
        parserVersion: source.parserVersion, locator: chunk.locator, section: chunk.section,
        startOffset: parentStart + chunk.start_utf16, endOffset: parentStart + chunk.end_utf16,
        contentChars: chunk.content.length, chunkHash: chunk.content_hash, indexedVersion,
        retrieved: !chunks.some(c => c.parent_chunk_id === chunk.id) };
    });
    const embeddings = db.prepare('SELECT chunk_id,space_key,dimensions,vector_blob FROM research_knowledge_embeddings ORDER BY chunk_id,space_key')
      .all().map(row => ({ chunkId: row.chunk_id, spaceKey: row.space_key, dimensions: row.dimensions, vectorHash: sha256(row.vector_blob) }));
    return { schemaVersion: 1, documents: documents.map(d => ({ id: d.id, projectId: d.project_id, sourceId: d.source_id,
      sourceHash: d.content_hash, metadataHash: sha256(d.metadata_json) })), chunks: mapped, embeddings };
  } finally { db.close(); }
}
export function artifactValue(path, expectedHash) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('rag_artifact_not_regular');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (hash(value) !== expectedHash) throw new Error('rag_artifact_changed');
  return value;
}
export function verifyRagSearch(result, state, request, projectId) {
  const byId = new Map(state.chunks.map(c => [c.chunkId, c]));
  const { inputHash, ranker, coverage, ...snapshot } = result.ranking;
  if (inputHash !== sha256(JSON.stringify({ query: result.query, ...snapshot })) || result.query !== request.query
    || snapshot.projectId !== projectId || ranker !== 'rrf-v1-k60'
    || result.hits.length > snapshot.limit || new Set(result.hits.map(h => h.chunkId)).size !== result.hits.length
    || new Set(snapshot.candidates.map(c => c.chunkId)).size !== snapshot.candidates.length) throw new Error('rag_ranking_invalid');
  for (const candidate of snapshot.candidates) {
    const chunk = byId.get(candidate.chunkId);
    if (!chunk?.retrieved || chunk.indexedVersion !== candidate.indexedVersion || chunk.chunkHash !== candidate.chunkHash
      || chunk.documentId !== candidate.documentId || chunk.locator !== candidate.locator
      || (projectId !== null && chunk.projectId !== null && chunk.projectId !== projectId)
      || (request.documentId && chunk.documentId !== request.documentId)) throw new Error('rag_candidate_source_invalid');
  }
  const selected = [], paperCounts = new Map();
  for (const candidate of snapshot.candidates) {
    const chunk = byId.get(candidate.chunkId), paperId = chunk.paperId ?? chunk.documentId;
    if (snapshot.route.diversify && (paperCounts.get(paperId) ?? 0) >= 2) continue;
    if (selected.length === snapshot.limit) break;
    selected.push(candidate);
    paperCounts.set(paperId, (paperCounts.get(paperId) ?? 0) + 1);
  }
  if (selected.length < snapshot.limit) {
    selected.push(...snapshot.candidates.filter(candidate => !selected.includes(candidate))
      .slice(0, snapshot.limit - selected.length));
  }
  if (hash(result.hits.map(hit => hit.chunkId)) !== hash(selected.map(candidate => candidate.chunkId))
    || snapshot.candidates.some(candidate => candidate.outputRank !==
      (selected.includes(candidate) ? selected.indexOf(candidate) + 1 : null))) throw new Error('rag_hit_selection_invalid');
  for (const [i, hit] of result.hits.entries()) {
    const chunk = byId.get(hit.chunkId), candidate = snapshot.candidates.find(c => c.chunkId === hit.chunkId);
    if (!chunk || !candidate || candidate.outputRank !== i + 1 || hit.documentId !== chunk.documentId
      || sha256(hit.content) !== chunk.chunkHash || hit.locator !== chunk.locator || hit.sourceId !== chunk.sourceId) throw new Error('rag_hit_invalid');
  }
  return true;
}
export function verifyRagContext(result, state, sources, request, projectId) {
  const byId = new Map(state.chunks.map(c => [c.chunkId, c]));
  const selected = byId.get(request.chunkId);
  if (!selected || selected.indexedVersion !== request.expectedIndexedVersion
    || (selected.projectId !== null && selected.projectId !== projectId) || result.derived !== false
    || result.context.chunkId !== request.chunkId || result.neighbors.length > (request.neighbors === false ? 0 : 2)) throw new Error('rag_context_request_invalid');
  let chars = 0;
  for (const item of [result.context, ...result.neighbors]) {
    const chunk = byId.get(item.chunkId), parent = byId.get(item.parentChunkId), source = sources.find(d => d.id === parent?.documentId);
    if (!chunk || !parent || !source || parent.parentChunkId !== parent.chunkId || chunk.documentId !== parent.documentId
      || parent.indexedVersion !== item.indexedVersion || item.locator !== parent.locator || item.start < 0 || item.end > parent.contentChars
      || item.totalChars !== parent.contentChars || item.content !== source.content.slice(parent.startOffset + item.start, parent.startOffset + item.end)
      || item.content.length !== item.end - item.start || parent.documentId !== selected.documentId) throw new Error('rag_context_source_invalid');
    chars += item.content.length;
  }
  if (chars > request.maxChars) throw new Error('rag_context_budget_invalid');
  return true;
}
