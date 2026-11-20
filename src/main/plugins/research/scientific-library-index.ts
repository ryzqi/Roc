import type {ResearchRepository} from './repository';
import type {ResearchEmbeddingService, ResearchEmbeddingReceipt} from './embedding-service';
import type {StoredDocumentContent} from './document-repository';
import type {StagedScientificIndex} from './scientific-index-builder';
import {ScientificIndexBuilder} from './scientific-index-builder';
import {PaperIRRepository} from './paper-ir-repository';
import {documentStorageRoot, maximumDocumentBytes} from './document-files';
import {verifyDocumentSource} from './verified-document-source';

export type PreparedLibraryIndex = {
  documentId: string; parseId: string; data: StoredDocumentContent; staged: StagedScientificIndex;
  sourcePlan: ReturnType<ResearchRepository['documents']['indexSource']>;
};

/** Library parses and configuration rebuilds use the same prepared, atomic publication boundary. */
export class ScientificLibraryIndexService {
  constructor(private readonly repository: ResearchRepository, private readonly embeddings: ResearchEmbeddingService,
    private readonly rootPath: string | null) {}

  async prepare(documentId: string, parseId: string, data: StoredDocumentContent, signal: AbortSignal): Promise<PreparedLibraryIndex> {
    const root = await documentStorageRoot(this.rootPath);
    const ir = data.paperIR ? await new PaperIRRepository(root).read(data.paperIR) : null;
    const sourcePlan = this.repository.documents.indexSource(documentId, parseId, data);
    const staged = await new ScientificIndexBuilder(this.repository, this.embeddings).stage({
      ir, paperIR: data.paperIR ?? null, source: {kind: 'library'}, generic: sourcePlan.input,
      metadata: sourcePlan.metadata, embedding: this.embeddings.selectedIdentity(null), signal});
    try {
      // Read the immutable IR first, then verify original source bytes after all provider work.
      if (data.paperIR) await new PaperIRRepository(root).read(data.paperIR);
      const document = this.repository.documents.get(documentId);
      if (document.size > maximumDocumentBytes) throw new Error('research_file_size_invalid');
      await verifyDocumentSource(root, this.repository.documents.sourcePath(documentId), document.size, document.sourceHash, signal);
      return {documentId, parseId, data, staged, sourcePlan};
    } catch (error) {
      this.fail({documentId, parseId, data, staged, sourcePlan}, signal);
      throw error;
    }
  }

  publish(prepared: PreparedLibraryIndex, consumer: () => void, requireCurrent: () => void = () => {}): void {
    const validate = (): void => {
      requireCurrent();
      const document = this.repository.documents.get(prepared.documentId);
      if (this.repository.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
      if (document.sourceHash !== prepared.data.content.sourceHash ||
        JSON.stringify(this.repository.documents.indexSource(prepared.documentId, prepared.parseId, prepared.data)) !==
        JSON.stringify(prepared.sourcePlan)) throw new Error('research_document_source_changed');
      if (JSON.stringify(this.embeddings.selectedIdentity(null)) !== JSON.stringify(prepared.staged.generic.identity)) {
        throw new Error('research_scientific_embedding_changed');
      }
    };
    const generation = prepared.staged.generation;
    if (generation) this.repository.scientificIndex.publish(generation.id, () => {
      validate();
      return {paperIR: generation.snapshot.paperIR, embedding: this.embeddings.selectedIdentity(null)};
    }, consumer);
    else {validate(); consumer();}
  }

  fail(prepared: PreparedLibraryIndex, signal: AbortSignal): void {
    if (prepared.staged.generation) this.repository.scientificIndex.fail(prepared.staged.generation.id,
      signal.aborted ? 'research_scientific_cancelled' : 'research_scientific_publication_failed', signal.aborted);
  }

  async rebuild(knowledgeDocumentId: string, signal: AbortSignal, requireCurrent: () => void): Promise<ResearchEmbeddingReceipt> {
    const parseId = knowledgeDocumentId.slice('document:'.length);
    const document = this.repository.documents.getForParse(parseId);
    if (document.currentParseId !== parseId || document.activeParseId !== null) throw new Error('research_document_parse_stale');
    const {data} = this.repository.documents.parsed(document.id, parseId);
    const prepared = await this.prepare(document.id, parseId, data, signal);
    try {
      this.publish(prepared, () => this.repository.documents.publishPreparedIndex(document.id, parseId,
        data, prepared.staged.generic, requireCurrent), requireCurrent);
      return prepared.staged.generic.identity;
    } catch (error) {this.fail(prepared, signal); throw error;}
  }

  /** Recover configuration jobs immediately; interrupted new parses require their original parser to run again. */
  recover(): string[] {
    const reparse = new Set<string>();
    for (const generation of this.repository.scientificIndex.recover('library')) {
      const document = this.repository.documents.get(generation.snapshot.paperIR.identity.documentId);
      if (this.repository.library.get(document.libraryItemId).archived) continue;
      if (document.currentParseId) {
        const parseId = document.currentParseId, {data} = this.repository.documents.parsed(document.id, parseId);
        this.repository.queueKnowledgeFromSource(this.repository.documents.indexSource(document.id, parseId, data).input);
      }
      const run = this.repository.documents.runs(document.id).find(run => run.id === generation.snapshot.paperIR.identity.parseId);
      if (run?.error === 'research_document_parse_interrupted') reparse.add(document.id);
    }
    this.repository.flushKnowledgeFromSource();
    return [...reparse];
  }
}
