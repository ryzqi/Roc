import type {
  FileWriteResult,
  ResearchBibliographyFormat,
  ResearchClaim,
  ResearchDocument,
  ResearchDocumentImportRequest,
  ResearchDocumentParse,
  ResearchDocumentRun,
  ResearchEmbeddingConfig,
  ResearchEvidence,
  ResearchIndexControlRequest,
  ResearchIndexJob,
  ResearchIndexStatus,
  ResearchIndexedFile,
  ResearchIndexedSource,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchResult,
  ResearchLibraryExport,
  ResearchLibraryImportResult,
  ResearchLibraryItem,
  ResearchLibraryListRequest,
  ResearchLiterature,
  ResearchLiteratureSearchRequest,
  ResearchModelsStatus,
  ResearchParseTier
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Literature data layer (P5/T5.1–T5.5).
 *
 * Thin, one function per IPC method, in the same shape as `workspace-store.ts`:
 * no caching, no derived state, no error swallowing. The contract corrections in
 * `findings.md` F16 are encoded here as types rather than as comments — e.g. the
 * bibliography import format union has no `ris`, because the backend has none.
 *
 * It is deliberately a **map of the whole contract**, so a few wrappers have no
 * caller yet (`getLibraryItem`, `listEmbeddingConfigs`, `getEvidenceIndexSource`).
 * Keep it that way: the alternative is components calling `client.api.research.*`
 * directly, which puts preload names (which differ from capability names) back into
 * views and lets two callers pass different shapes for the same method.
 *
 * Two rules that are easy to get wrong and are therefore called out per function:
 *
 *   1. **`expectedRevision` on every write.** Archive / citation-key / index
 *      control are optimistic-concurrency calls. A caller that reads an item and
 *      then writes must pass the revision it read; the UI must surface the
 *      conflict rather than retrying with a fresh revision (that would silently
 *      overwrite whoever won the race).
 *   2. **Literature search is server-side.** `library.list` takes `query`; the
 *      renderer must not re-filter a page of results, or matches outside the
 *      first `limit` items become unreachable.
 */

export function listLibrary(
  client: RocClient,
  request: ResearchLibraryListRequest
): Promise<IpcLikeResult<ResearchLibraryItem[]>> {
  return client.api.research.listLibrary(request);
}

export function getLibraryItem(client: RocClient, id: string): Promise<IpcLikeResult<ResearchLibraryItem>> {
  return client.api.research.getLibraryItem({ id });
}

export function importLibraryRecord(
  client: RocClient,
  input: { record: ResearchLiterature; citationKey: string; projectId: string | null }
): Promise<IpcLikeResult<ResearchLibraryImportResult>> {
  return client.api.research.importLibraryRecord(input);
}

export function importLibraryDoi(
  client: RocClient,
  input: { doi: string; projectId: string | null }
): Promise<IpcLikeResult<ResearchLibraryImportResult>> {
  return client.api.research.importLibraryDoi(input);
}

/**
 * The allowed `sources` for a literature search.
 *
 * Derived from the request type rather than re-declared, so it cannot drift from
 * the contract (the schema's union is not exported as its own type).
 */
export type LiteratureSearchSource = ResearchLiteratureSearchRequest['sources'][number];

/**
 * Imports a `.bib` / `.biblatex` / CSL-JSON file.
 *
 * `sourcePath` is an **absolute** path from `files.selectFromDialog` — unlike the
 * P3 file APIs, which are workspace-relative. There is deliberately no workspace
 * validation here: the user picked it in a native dialog, which is the whole
 * point of that method. Note the preload name (`importBibliography`) and the
 * capability name (`research.library.importFile`) differ; this wrapper is the
 * only place that has to know both.
 */
export function importBibliographyFile(
  client: RocClient,
  input: { sourcePath: string; format: ResearchBibliographyFormat; projectId: string | null }
): Promise<IpcLikeResult<ResearchLibraryImportResult>> {
  return client.api.research.importBibliography(input);
}

/** Returns the serialized bibliography; writing it somewhere is the caller's job. */
export function exportBibliography(
  client: RocClient,
  input: { ids: string[]; format: ResearchBibliographyFormat }
): Promise<IpcLikeResult<ResearchLibraryExport>> {
  return client.api.research.exportBibliography(input);
}

export function linkLibraryItem(
  client: RocClient,
  input: { id: string; projectId: string; linked: boolean }
): Promise<IpcLikeResult<ResearchLibraryItem>> {
  return client.api.research.linkLibraryItem(input);
}

export function archiveLibraryItem(
  client: RocClient,
  input: { id: string; expectedRevision: number; archived: boolean }
): Promise<IpcLikeResult<ResearchLibraryItem>> {
  return client.api.research.archiveLibraryItem(input);
}

export function setLibraryCitationKey(
  client: RocClient,
  input: { id: string; expectedRevision: number; citationKey: string }
): Promise<IpcLikeResult<ResearchLibraryItem>> {
  return client.api.research.setLibraryCitationKey(input);
}

export function searchLiterature(
  client: RocClient,
  input: { query: string; sources: LiteratureSearchSource[]; limit: number }
): Promise<IpcLikeResult<ResearchLiterature[]>> {
  return client.api.research.searchLiterature(input);
}

// ---- documents (T5.3) -------------------------------------------------------

/**
 * `target: 'new-item'` needs a title and citation key, so a PDF import always
 * collects them first; `target: 'library-item'` attaches to an existing record.
 */
export function importDocument(
  client: RocClient,
  input: ResearchDocumentImportRequest
): Promise<IpcLikeResult<ResearchDocument>> {
  return client.api.research.importDocument(input);
}

export function listDocuments(
  client: RocClient,
  libraryItemId: string
): Promise<IpcLikeResult<ResearchDocument[]>> {
  return client.api.research.listDocuments({ libraryItemId });
}

export function getDocument(client: RocClient, documentId: string): Promise<IpcLikeResult<ResearchDocument>> {
  return client.api.research.getDocument({ documentId });
}

export function parseDocument(
  client: RocClient,
  documentId: string,
  tier: ResearchParseTier | null = null
): Promise<IpcLikeResult<ResearchDocument>> {
  return client.api.research.parseDocument({ documentId, tier });
}

export function parseDocuments(
  client: RocClient,
  input: { documentIds: string[] | null; tier: ResearchParseTier | null },
): Promise<IpcLikeResult<{ documents: ResearchDocument[]; failed: Array<{ documentId: string; error: string }> }>> {
  return client.api.research.parseDocuments(input);
}

export function cancelDocumentParse(
  client: RocClient,
  input: { documentId: string; parseId: string }
): Promise<IpcLikeResult<ResearchDocument>> {
  return client.api.research.cancelDocumentParse(input);
}

/**
 * The only source of parse progress. There are **no stage names** in the
 * contract (F16), so the UI renders these real statuses and timestamps instead
 * of the legacy `MINERU_PIPELINE_STAGES` list.
 */
export function listDocumentParses(
  client: RocClient,
  documentId: string
): Promise<IpcLikeResult<ResearchDocumentRun[]>> {
  return client.api.research.listDocumentParses({ documentId });
}

export function getDocumentContent(
  client: RocClient,
  input: { documentId: string; parseId: string }
): Promise<IpcLikeResult<ResearchDocumentParse>> {
  return client.api.research.getDocumentContent(input);
}

export function getModelsStatus(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.getModelsStatus();
}

export function downloadModels(
  client: RocClient,
  input: { pack: ResearchModelsStatus['selectedPack']; source: ResearchModelsStatus['source'] }
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.downloadModels(input);
}

export function selectModels(
  client: RocClient,
  input: { pack: ResearchModelsStatus['selectedPack']; source?: ResearchModelsStatus['source'] }
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.selectModels(input);
}

export function importModels(client: RocClient, directory: string): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.importModels({ directory });
}

export function removeModels(
  client: RocClient,
  pack: ResearchModelsStatus['selectedPack']
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.removeModels({ pack });
}

// ---- index + retrieval (T5.5) ----------------------------------------------

export function getIndexStatus(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchIndexStatus>> {
  return client.api.research.getIndexStatus({ projectId });
}

export function controlIndex(
  client: RocClient,
  input: ResearchIndexControlRequest
): Promise<IpcLikeResult<ResearchIndexStatus>> {
  return client.api.research.controlIndex(input);
}

export function listIndexedFiles(
  client: RocClient,
  input: { projectId: string; query: string; includeMissing: boolean; limit: number }
): Promise<IpcLikeResult<ResearchIndexedFile[]>> {
  return client.api.research.listIndexedFiles(input);
}

export function listIndexJobs(
  client: RocClient,
  input: { projectId: string; limit: number }
): Promise<IpcLikeResult<ResearchIndexJob[]>> {
  return client.api.research.listIndexJobs(input);
}

/**
 * Resolves an evidence record's indexed source **file**.
 *
 * Note what this does *not* return: a position. For a literature chunk the
 * locator comes from `knowledge.search` and is aligned against the parsed
 * document's `blocks[].locator`; for a workspace file there is no line/anchor
 * concept in the contract, so the only honest jump is "open the source file".
 */
export function getEvidenceIndexSource(
  client: RocClient,
  input: { projectId: string; evidenceId: string }
): Promise<IpcLikeResult<ResearchIndexedSource | null>> {
  return client.api.research.getEvidenceIndexSource(input);
}

export function searchKnowledge(
  client: RocClient,
  input: { query: string; projectId: string | null; limit: number; embeddingConfigId: string | null }
): Promise<IpcLikeResult<ResearchKnowledgeSearchResult>> {
  return client.api.research.searchKnowledge(input);
}

export function listEmbeddingConfigs(client: RocClient): Promise<IpcLikeResult<ResearchEmbeddingConfig[]>> {
  return client.api.research.listEmbeddingConfigs();
}

// ---- evidence + claims (T5.4 / T5.6) ---------------------------------------

/**
 * Captures the chunk behind a retrieval hit as an evidence record.
 *
 * `chunkId` is required by the contract, which is why this is only reachable
 * from a RAG hit (or an existing evidence record) and not from arbitrary text:
 * paragraph-level capture has no interface (B15).
 */
export function captureEvidence(
  client: RocClient,
  input: { projectId: string; chunkId: string }
): Promise<IpcLikeResult<ResearchEvidence>> {
  return client.api.research.captureEvidence(input);
}

/**
 * Stores a knowledge document that is not derived from an indexed source.
 *
 * `chunks` is required and each chunk carries its own locator, so a note saved
 * this way is retrievable by `knowledge.search` on the same footing as an
 * indexed file — which is the point of having it at all.
 */
export function upsertKnowledgeDocument(
  client: RocClient,
  input: ResearchKnowledgeDocumentUpsertRequest
): Promise<IpcLikeResult<unknown>> {
  return client.api.research.upsertKnowledgeDocument(input);
}

/**
 * Writes text **into the bound workspace**.
 *
 * `research.library.export` returns `{format, filename, content}` and there is no
 * save-as dialog on that path (F16), so this is the only way an export can reach
 * disk. The caller must tell the user which relative path it used.
 */
export function writeWorkspaceText(
  client: RocClient,
  input: { relativePath: string; content: string; source: string }
): Promise<IpcLikeResult<FileWriteResult>> {
  return client.api.files.writeText(input);
}

export function listEvidence(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchEvidence[]>> {
  return client.api.research.listEvidence({ projectId });
}

export function listClaims(
  client: RocClient,
  input: { projectId: string; artifactId?: string }
): Promise<IpcLikeResult<ResearchClaim[]>> {
  return client.api.research.listClaims(input);
}
