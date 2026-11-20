import {lstat, realpath} from 'node:fs/promises';
import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ScientificGenerationReceipt} from '../../../shared/schemas/research-scientific-search';
import type {ResearchRepository} from './repository';
import type {ScientificGeneration} from './scientific-index-repository';
import type {ScientificChunk} from './scientific-chunks';
import type {ScientificQueryPaper} from './scientific-query-planner';
import {PaperIRRepository} from './paper-ir-repository';
import {researchContentHash, researchPath, researchRelativePath} from './research-files';
import {verifyDocumentSource} from './verified-document-source';
import {scientificVisualAssetReader} from './scientific-context-image';

export type ScientificSearchPaper = {
  generation: ScientificGeneration; receipt: ScientificGenerationReceipt;
  ir: PaperIRV2; chunks: ScientificChunk[]; libraryItemId: string | null;
};
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));

/** Only the source owner selects the IR artifact. A library's null storage scope is not project authorization. */
export class ScientificSearchSnapshots {
  constructor(private readonly repository: ResearchRepository,
    private readonly roots: {library: string | null; index: string | null}) {}

  readonly readVisualAsset = scientificVisualAssetReader(async (paper, objectId) => {
    const {generation} = paper, {identity} = paper.ir;
    const visual = paper.ir.figures.find(f => f.id === objectId)?.data ?? paper.ir.tables.find(t => t.id === objectId)?.visual;
    if (!visual) return null;
    const root = await this.root(generation);
    if (generation.snapshot.source.kind === 'library') {
      const data = this.repository.documents.parsed(identity.documentId, identity.parseId).data;
      if (digest(data.content) !== identity.parseHash) throw new Error('research_scientific_search_source_changed');
      const asset = data.content.assets.find(a => a.id === visual.assetId);
      if (!visual.assetId) return null;
      if (!asset) throw new Error('research_scientific_context_image_missing');
      const path = data.files[asset.id];
      if (!path) throw new Error('research_scientific_context_image_missing');
      await researchPath(root, data.outputPath);
      return {storage: 'library', root, path: researchRelativePath(`${data.outputPath}/${path}`),
        assetId: asset.id, sha256: asset.sha256, size: asset.size};
    }
    if (!visual.imagePath) return null;
    const payload = this.repository.indexing.cached(generation.snapshot.source.fileId).payload;
    if (!payload?.artifactPath || payload.parseArtifactId !== identity.parseId ||
      generation.snapshot.source.artifactId !== identity.parseId ||
      payload.parserFingerprint !== identity.parserFingerprint ||
      payload.artifactPath !== researchRelativePath(`artifacts/${identity.parseId}`)) {
      throw new Error('research_scientific_search_source_changed');
    }
    await researchPath(root, payload.artifactPath);
    return {storage: 'project', root, path: researchRelativePath(`${payload.artifactPath}/${visual.imagePath}`),
      assetId: null, sha256: null, size: null};
  });

  readonly readImage: import('./scientific-context-assembler').ScientificContextImageReader = async (...args) => {
    const result = await this.readVisualAsset(...args);
    return {image: result.asset?.image ?? null, reason: result.reason};
  };

  catalog(projectId: string | null, documentIds: readonly string[]): ScientificGeneration[] {
    this.requireProject(projectId);
    const generations = this.repository.scientificIndex.activeInScope(projectId, documentId => {
      const document = this.repository.documents.get(documentId);
      const item = this.repository.library.get(document.libraryItemId);
      return !item.archived && (projectId === null || item.projectIds.includes(projectId));
    });
    if (documentIds.some(id => !generations.some(g => g.snapshot.paperIR.identity.documentId === id))) {
      throw new Error('research_scientific_search_scope_invalid');
    }
    return generations;
  }

  papers(projectId: string | null, generations: readonly ScientificGeneration[]): ScientificQueryPaper[] {
    return generations.map(g => ({projectId, documentId: g.snapshot.paperIR.identity.documentId,
      paperId: g.snapshot.paperIR.identity.paperId, title: g.snapshot.paperIR.metadata.title ?? '',
      doi: g.snapshot.paperIR.metadata.doi}));
  }

  /** Check current storage ownership without claiming to have verified the original file bytes. */
  assertOwner(projectId: string, generation: ScientificGeneration): void {this.owner(projectId, generation);}

  /** Rollback validates retained source bytes without requiring the possibly damaged active index to be readable. */
  async guardRetainedSource(projectId: string, generation: ScientificGeneration, signal: AbortSignal): Promise<() => void> {
    this.requireProject(projectId);
    const owner = digest(this.owner(projectId, generation));
    const files = await this.guardFiles(projectId, [generation], signal);
    await new PaperIRRepository(await this.root(generation)).read(generation.snapshot.paperIR);
    await this.verifySource(projectId, generation, signal);
    const guard = (): void => {
      files(); this.requireProject(projectId);
      if (digest(this.owner(projectId, generation)) !== owner) throw new Error('research_scientific_search_source_changed');
    };
    guard();
    return guard;
  }

  assertReceiptCurrent(projectId: string, receipt: ScientificGenerationReceipt): void {
    const generation = this.repository.scientificIndex.get(receipt.generationId);
    if (generation.status !== 'active' || digest(this.owner(projectId, generation)) !== receipt.ownerHash ||
      this.repository.scientificIndex.active(generation.snapshot.projectId, generation.snapshot.paperIR.identity.documentId)?.id !== generation.id) {
      throw new Error('research_scientific_search_source_changed');
    }
    this.repository.scientificIndex.verify(generation.id);
  }

  /** Metadata fences surround byte-verified reads; checking every file synchronously closes later-paper races. */
  async guardFiles(projectId: string, generations: readonly ScientificGeneration[], signal: AbortSignal): Promise<() => void> {
    const guards: Array<() => void> = [];
    const failure = () => new Error('research_scientific_search_source_changed');
    const stamp = (path: string) => {
      const stat = lstatSync(path, {bigint: true});
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure();
      return {dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs};
    };
    for (const generation of generations) {
      signal.throwIfAborted(); this.owner(projectId, generation);
      const root = await this.root(generation), {snapshot} = generation;
      const original = snapshot.source.kind === 'library'
        ? {root, path: this.repository.documents.sourcePath(snapshot.paperIR.identity.documentId)}
        : {root: this.repository.indexing.scope(projectId).root_path!,
          path: this.repository.indexing.source(projectId, snapshot.source.fileId, snapshot.paperIR.identity.sourceHash).source.path};
      for (const file of [{root, path: snapshot.paperIR.path}, original]) {
        const path = await researchPath(file.root, file.path), before = stamp(path);
        guards.push(() => {
          try {
            let ancestor = file.root;
            if (lstatSync(ancestor).isSymbolicLink() || realpathSync(ancestor) !== ancestor) throw failure();
            for (const part of file.path.split('/')) {
              ancestor = join(ancestor, part);
              if (lstatSync(ancestor).isSymbolicLink()) throw failure();
            }
            if (realpathSync(ancestor) !== path || !isDeepStrictEqual(stamp(path), before)) throw failure();
          } catch {throw failure();}
        });
      }
    }
    return () => {signal.throwIfAborted(); for (const guard of guards) guard();};
  }

  /** Select history through a persisted publication, then reauthorize after the file read. */
  async readExtractionIR(projectId: string, extractionId: string, signal: AbortSignal): Promise<PaperIRV2> {
    signal.throwIfAborted();
    const store = this.repository.scientificExtraction, job = store.get(extractionId, projectId);
    const source = job.snapshot.source, documentId = source.paperIR.identity.documentId;
    store.authorizeDocument(projectId, documentId);
    if (job.status !== 'published') throw new Error('research_scientific_extraction_result_invalid');
    const generation = this.repository.scientificIndex.get(source.generationId);
    if (!isDeepStrictEqual(generation.snapshot.paperIR, source.paperIR) ||
      generation.snapshot.projectId !== source.storageProjectId ||
      source.storageProjectId !== null && source.storageProjectId !== projectId ||
      generation.chunksHash !== source.chunksHash || generation.relationsHash !== source.relationsHash) {
      throw new Error('research_scientific_extraction_source_invalid');
    }
    this.repository.scientificIndex.verify(generation.id);
    const ir = await new PaperIRRepository(await this.root(generation)).read(source.paperIR, {documentId});
    signal.throwIfAborted();
    store.authorizeDocument(projectId, documentId);
    store.bundle(job.id, projectId, ir);
    return ir;
  }

  async capture(projectId: string | null, generations: readonly ScientificGeneration[],
    signal: AbortSignal): Promise<ScientificSearchPaper[]> {
    const result: ScientificSearchPaper[] = [];
    let bytes = 0, chunks = 0;
    for (const generation of generations) {
      signal.throwIfAborted();
      bytes += generation.snapshot.paperIR.size; chunks += generation.chunkCount;
      if (bytes > 256 * 1024 * 1024 || chunks > 100_000) throw new Error('research_scientific_snapshot_budget_exceeded');
      const owner = this.owner(projectId, generation);
      const receipt: ScientificGenerationReceipt = {generationId: generation.id,
        storageProjectId: generation.snapshot.projectId, paperIR: generation.snapshot.paperIR,
        embedding: generation.snapshot.embedding, chunksHash: generation.chunksHash,
        relationsHash: generation.relationsHash, ownerHash: digest(owner)};
      this.repository.scientificIndex.verify(generation.id);
      const ir = await new PaperIRRepository(await this.root(generation)).read(receipt.paperIR);
      signal.throwIfAborted();
      result.push({generation, receipt, ir, libraryItemId: owner.libraryItemId,
        chunks: this.repository.scientificIndex.chunks(generation.id, generation.snapshot.projectId)});
    }
    await this.assertCurrent(projectId, result.map(p => p.receipt), signal);
    return result;
  }

  async assertCurrent(projectId: string | null, receipts: readonly ScientificGenerationReceipt[],
    signal: AbortSignal): Promise<void> {
    this.requireProject(projectId);
    for (const receipt of receipts) {
      signal.throwIfAborted();
      const g = this.repository.scientificIndex.get(receipt.generationId);
      if (g.status !== 'active' || this.repository.scientificIndex.active(g.snapshot.projectId,
        g.snapshot.paperIR.identity.documentId)?.id !== g.id ||
        digest({paperIR: g.snapshot.paperIR, embedding: g.snapshot.embedding,
          projectId: g.snapshot.projectId, chunksHash: g.chunksHash, relationsHash: g.relationsHash}) !==
        digest({paperIR: receipt.paperIR, embedding: receipt.embedding,
          projectId: receipt.storageProjectId, chunksHash: receipt.chunksHash, relationsHash: receipt.relationsHash}) ||
        digest(this.owner(projectId, g)) !== receipt.ownerHash) {
        throw new Error('research_scientific_search_source_changed');
      }
      this.repository.scientificIndex.verify(g.id);
      await new PaperIRRepository(await this.root(g)).read(receipt.paperIR);
      await this.verifySource(projectId, g, signal);
      signal.throwIfAborted();
      // File reads yield; recheck the owner after the last asynchronous operation.
      if (digest(this.owner(projectId, g)) !== receipt.ownerHash ||
        this.repository.scientificIndex.active(g.snapshot.projectId, g.snapshot.paperIR.identity.documentId)?.id !== g.id) {
        throw new Error('research_scientific_search_source_changed');
      }
    }
    this.requireProject(projectId);
    // An earlier paper can change while the last paper is read.
    for (const receipt of receipts) {
      const g = this.repository.scientificIndex.get(receipt.generationId);
      if (g.status !== 'active' || digest(this.owner(projectId, g)) !== receipt.ownerHash) {
        throw new Error('research_scientific_search_source_changed');
      }
    }
  }

  private requireProject(projectId: string | null): void {
    if (projectId !== null && this.repository.getProject(projectId).status === 'archived') {
      throw new Error('research_project_archived');
    }
  }

  private owner(projectId: string | null, generation: ScientificGeneration) {
    const {snapshot} = generation, receipt = snapshot.paperIR, identity = receipt.identity;
    if (snapshot.source.kind === 'library') {
      const document = this.repository.documents.get(identity.documentId);
      const item = this.repository.library.get(document.libraryItemId);
      if (item.archived || projectId !== null && !item.projectIds.includes(projectId)) {
        throw new Error('research_scientific_search_scope_invalid');
      }
      const data = this.repository.documents.parsed(document.id, identity.parseId).data;
      if (document.currentParseId !== identity.parseId || document.sourceHash !== identity.sourceHash ||
        digest(data.paperIR) !== digest(receipt) || digest(data.content) !== identity.parseHash) {
        throw new Error('research_scientific_search_source_changed');
      }
      return {libraryItemId: item.id, revision: item.revision, projectIds: item.projectIds,
        metadata: item.metadata, sourceHash: document.sourceHash, currentParseId: document.currentParseId,
        paperIR: receipt.sha256, outputPath: data.outputPath, filesHash: digest(data.files)};
    }
    if (projectId === null || snapshot.projectId !== projectId) throw new Error('research_scientific_search_scope_invalid');
    const scope = this.repository.indexing.scope(projectId), cached = this.repository.indexing.cached(snapshot.source.fileId);
    const source = this.repository.indexing.source(projectId, snapshot.source.fileId, identity.sourceHash).source;
    if (scope.archived || !scope.root_path || !cached.published || cached.payload?.sourceHash !== identity.sourceHash ||
      cached.payload.parseArtifactId !== identity.parseId || snapshot.source.artifactId !== identity.parseId ||
      cached.payload.parserFingerprint !== identity.parserFingerprint ||
      cached.payload.artifactPath !== researchRelativePath(`artifacts/${identity.parseId}`) ||
      digest(cached.payload.paperIR) !== digest(receipt)) throw new Error('research_scientific_search_source_changed');
    return {libraryItemId: null, projectId, root: scope.root_path, source,
      paperIR: receipt.sha256, artifactPath: cached.payload.artifactPath, embeddingKey: cached.embeddingKey};
  }

  private async root(generation: ScientificGeneration): Promise<string> {
    const kind = generation.snapshot.source.kind === 'library' ? 'library' : 'index', root = this.roots[kind];
    if (root === null || !isAbsolute(root)) throw new Error(`research_${kind}_storage_unavailable`);
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) throw new Error(`research_${kind}_storage_symlink`);
    if (!stat.isDirectory()) throw new Error(`research_${kind}_storage_invalid`);
    return await realpath(root);
  }

  private async verifySource(projectId: string | null, generation: ScientificGeneration, signal: AbortSignal): Promise<void> {
    const {snapshot} = generation, identity = snapshot.paperIR.identity;
    if (snapshot.source.kind === 'library') {
      const document = this.repository.documents.get(identity.documentId);
      await verifyDocumentSource(await this.root(generation), this.repository.documents.sourcePath(document.id),
        document.size, identity.sourceHash, signal);
    } else {
      const scope = this.repository.indexing.scope(projectId!);
      const {source} = this.repository.indexing.source(projectId!, snapshot.source.fileId, identity.sourceHash);
      await verifyDocumentSource(scope.root_path!, source.path, source.size, identity.sourceHash, signal);
    }
  }
}

export function scientificSnapshotId(receipts: readonly ScientificGenerationReceipt[]): string {
  return digest(receipts);
}
