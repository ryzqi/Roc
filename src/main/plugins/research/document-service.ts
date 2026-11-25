import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { z } from 'zod';
import type {
  researchDocumentAssetRequestSchema, researchDocumentImportRequestSchema, researchDocumentParseSchema, researchDocumentSourceRequestSchema
} from '../../../shared/schemas/research-documents';import type { ResearchBibliographyEntry, ResearchLiterature } from '../../../shared/types';
import type { ResearchParseTier } from '../../../shared/schemas/research-production';
import type {ResearchDocumentPreview, ResearchDocumentPreviewRequest} from '../../../shared/schemas/research-document-preview';
import type {
  ResearchDocumentAnnotationCreateRequest, ResearchDocumentAnnotationCaptureRequest, ResearchDocumentAnnotationInspection
} from '../../../shared/schemas/research-document-annotations';
import type {ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import { collectDocumentContent, documentMediaTypes, documentStorageRoot, maximumDocumentBytes, maximumArtifactBytes } from './document-files';
import type { ResearchDocument, StoredDocumentContent } from './document-repository';
import {normalizeResearchDoi} from './literature-identity';
import {enrichPaperSemantics, type PaperSemanticGenerator} from './paper-semantic-service';
import {enrichScholarlyFields, type ScholarlyParserAdapter} from './scholarly-parser-adapter';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath, researchWorkspace } from './research-files';
import {documentSourceRequest} from './document-source-request';
import {documentSourceRange, VerifiedDocumentSources, verifyDocumentSource} from './verified-document-source';
import {PaperIRRepository} from './paper-ir-repository';
import {hasUnprovenResearchProcessExit} from './process-exit-state';
import type {ScientificLibraryIndexService, PreparedLibraryIndex} from './scientific-library-index';

type DocumentTools = Pick<ResearchToolchain, 'parseDocument' | 'normalizeBibliography' | 'defaultParseOptions'>;
type ImportTask = { controller: AbortController; promise: Promise<ResearchDocument> };
type ParseTask = ImportTask & { parseId: string };
type AcquisitionParse = {signal: AbortSignal; requireCurrent: () => void};

export class ResearchDocumentService {
  private readonly tasks = new Set<ImportTask>();
  private readonly parses = new Map<string, ParseTask>();
  private closed = false;
  private sources: VerifiedDocumentSources | null = null;

  constructor(private readonly repository: ResearchRepository, private readonly tools: DocumentTools, private readonly rootPath: string | null,
    private readonly semanticGenerator: PaperSemanticGenerator | null = null,
    private readonly scholarlyParser: ScholarlyParserAdapter | null = null,
    private readonly scientificIndex: ScientificLibraryIndexService | null = null) {}

  async import(request: z.infer<typeof researchDocumentImportRequestSchema>): Promise<ResearchDocument> {
    this.requireOpen();
    this.repository.library.validateDestination(request.projectId);
    if (request.target === 'library-item' && this.repository.library.get(request.libraryItemId).archived) throw new Error('research_library_item_archived');
    const controller = new AbortController();
    const task: ImportTask = { controller, promise: this.importFile(request, controller.signal) };
    this.tasks.add(task);
    try { return await task.promise; }
    finally { this.tasks.delete(task); }
  }

  /** Main-process prepared input: its caller already validated the explicit single-file grant. */
  async importPrepared(request: Extract<z.infer<typeof researchDocumentImportRequestSchema>, {target: 'library-item'}>,
    bytes: Buffer, record: (document: ResearchDocument) => void, parentSignal: AbortSignal): Promise<ResearchDocument> {
    this.requireOpen();
    this.repository.library.validateDestination(request.projectId);
    if (this.repository.library.get(request.libraryItemId).archived) throw new Error('research_library_item_archived');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, parentSignal]);
    const task: ImportTask = {controller, promise: this.persistFile(request, bytes, record, signal)};
    this.tasks.add(task);
    try {return await task.promise;}
    finally {this.tasks.delete(task);}
  }

  async parse(documentId: string, tier: ResearchParseTier | null = null): Promise<ResearchDocument> {
    return await this.startParse(documentId, tier);
  }

  /** Persist parser artifacts first; the durable knowledge outbox owns embeddings and retries. */
  async parseForAcquisition(documentId: string, signal: AbortSignal, requireCurrent: () => void): Promise<ResearchDocument> {
    return await this.startParse(documentId, null, {signal, requireCurrent});
  }

  private async startParse(documentId: string, tier: ResearchParseTier | null, acquisition?: AcquisitionParse): Promise<ResearchDocument> {
    this.requireOpen();
    const active = this.parses.get(documentId);
    if (active !== undefined) return await active.promise;
    acquisition?.requireCurrent();
    const parseId = `parse_${randomUUID()}`;
    const controller = new AbortController();
    const signal = acquisition ? AbortSignal.any([controller.signal, acquisition.signal]) : controller.signal;
    const task: ParseTask = { parseId, controller, promise: this.parseFile(documentId, parseId, signal, tier, acquisition) };
    this.parses.set(documentId, task);
    this.tasks.add(task);
    try { return await task.promise; }
    finally { this.tasks.delete(task); if (this.parses.get(documentId) === task) this.parses.delete(documentId); }
  }

  /**
   * 批量重解析串行提交，共享计算协调器执行全局解析准入。
   * 单个文档失败不影响其余文档，失败项连同错误码一起回给调用方。
   */
  async parseMany(input: { documentIds: string[] | null; tier: ResearchParseTier | null }): Promise<{ documents: ResearchDocument[]; failed: Array<{ documentId: string; error: string }> }> {
    this.requireOpen();
    const targets = input.documentIds === null
      ? this.repository.documents.needsReparse().map((document) => document.id)
      : input.documentIds;
    const documents: ResearchDocument[] = [];
    const failed: Array<{ documentId: string; error: string }> = [];
    for (const documentId of targets) {
      if (this.closed) throw new Error('research_documents_closed');
      try { documents.push(await this.parse(documentId, input.tier)); }
      catch (error) { failed.push({ documentId, error: failureCode(error) }); }
    }
    return { documents, failed };
  }

  cancel(documentId: string, parseId: string): ResearchDocument {
    const document = this.repository.documents.get(documentId);
    if (document.activeParseId !== parseId) throw new Error('research_document_parse_stale');
    this.repository.documents.fail(documentId, parseId, 'research_document_parse_cancelled', true);
    const task = this.parses.get(documentId);
    if (task?.parseId === parseId) { this.parses.delete(documentId); task.controller.abort(); }
    return this.repository.documents.get(documentId);
  }

  parsed(documentId: string, parseId: string): z.infer<typeof researchDocumentParseSchema> {
    const { run, data } = this.repository.documents.parsed(documentId, parseId);
    return { run, content: data.content };
  }

  async paperIR(documentId: string, parseId: string) {
    const {data} = this.repository.documents.parsed(documentId, parseId);
    if (!data.paperIR) throw new Error('research_paper_ir_artifact_missing');
    return await new PaperIRRepository(await documentStorageRoot(this.rootPath)).read(data.paperIR, {documentId, parseId});
  }

  resolveParse(projectId: string, parseId: string): ResearchDocument {
    return this.requireProjectDocument(projectId, this.repository.documents.getForParse(parseId).id);
  }

  content(request: ResearchDocumentPreviewRequest): z.infer<typeof researchDocumentParseSchema> {
    const {run, data} = this.requireVersionedParse(request);
    return {run, content: data.content};
  }

  async createAnnotation(request: ResearchDocumentAnnotationCreateRequest, actor: ResearchRelationReviewer): Promise<ResearchDocumentAnnotationInspection> {
    this.repository.documentAnnotations.requireTarget(request.target);
    await this.preview(request.target);
    return this.repository.documentAnnotations.create(request, actor);
  }

  async captureAnnotation(request: ResearchDocumentAnnotationCaptureRequest, actor: ResearchRelationReviewer): Promise<ResearchDocumentAnnotationInspection> {
    const inspection = this.repository.documentAnnotations.get({projectId: request.projectId, annotationId: request.annotationId});
    await this.preview(inspection.annotation.request.target);
    return this.repository.documentAnnotations.capture(request, actor);
  }

  listAnnotations(request: {projectId: string; documentId: string; parseId: string}): ResearchDocumentAnnotationInspection[] {
    return this.repository.documentAnnotations.list(request);
  }

  getAnnotation(request: {projectId: string; annotationId: string}): ResearchDocumentAnnotationInspection {
    return this.repository.documentAnnotations.get(request);
  }

  private requireVersionedParse(request: ResearchDocumentPreviewRequest) {
    const document = this.requireProjectDocument(request.projectId, request.documentId);
    if (document.sourceHash !== request.sourceHash) throw new Error('research_document_source_changed');
    const {run, data} = this.repository.documents.parsed(document.id, request.parseId);
    const parseHash = researchContentHash(JSON.stringify(data.content));
    if (data.content.sourceHash !== document.sourceHash ||
        (request.parseHash !== null && request.parseHash !== parseHash)) throw new Error('research_document_preview_parse_changed');
    return {document, run, data, parseHash};
  }

  async source(request: z.infer<typeof researchDocumentSourceRequestSchema>): Promise<{ bytes: Buffer; mediaType: string; filename: string }> {
    const document = this.requireProjectDocument(request.projectId, request.documentId);
    if (document.sourceHash !== request.sourceHash) throw new Error('research_document_source_changed');
    const bytes = await this.sourceBytes(await documentStorageRoot(this.rootPath), document);
    const current = this.requireProjectDocument(request.projectId, document.id);
    if (current.sourceHash !== document.sourceHash || current.size !== document.size) throw new Error('research_document_source_changed');
    return { bytes, mediaType: document.mediaType, filename: document.filename };
  }

  /** Trusted background caller supplies its own project/library eligibility and generation fence. */
  async acquisitionSource(documentId: string, signal: AbortSignal): Promise<Buffer> {
    this.requireOpen();
    signal.throwIfAborted();
    const document = this.repository.documents.get(documentId);
    if (this.repository.library.get(document.libraryItemId).archived) throw new Error('research_library_item_archived');
    const bytes = await this.sourceBytes(await documentStorageRoot(this.rootPath), document);
    signal.throwIfAborted();
    return bytes;
  }

  async sourceResponse(request: z.infer<typeof researchDocumentSourceRequestSchema>): Promise<Response> {
    this.requireOpen();
    if (process.env.ROC_PERF_PDF_RANGE_READER === '0') {
      const resource = await this.source(request);
      return new Response(new Uint8Array(resource.bytes), {headers: this.sourceHeaders(resource)});
    }
    const document = this.requireSource(request);
    const native = documentSourceRequest();
    const method = native?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, {status: 405, headers: {allow: 'GET, HEAD'}});
    const signal = native?.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const store = this.sourceStore(), key = this.sourceKey(request.projectId, document);
    let session = native?.session ?? null;
    if (native?.release) {
      if (session === null) return new Response(null, {status: 400});
      await store.release(session, key);
      return new Response(null, {status: 204});
    }
    if (session !== null && !store.has(session, key)) return new Response(null, {status: 410});
    const headers = this.sourceHeaders(document);
    headers['content-length'] = String(document.size);
    if (document.mediaType === 'application/pdf') headers['accept-ranges'] = 'bytes';
    const range = method === 'GET' && native?.range != null ? documentSourceRange(native.range, document.size) : null;
    if (method === 'GET' && native?.range != null && (range === null || document.mediaType !== 'application/pdf')) {
      return new Response(null, {status: 416, headers: {...headers, 'content-length': '0', 'content-range': `bytes */${document.size}`}});
    }
    if (session === null) {
      session = await store.acquire(await documentStorageRoot(this.rootPath), this.repository.documents.sourcePath(document.id),
        {key, size: document.size, sha256: document.sourceHash}, signal);
    }
    const authorize = (): void => {
      const current = this.requireSource(request);
      if (current.size !== document.size || current.mediaType !== document.mediaType) throw new Error('research_document_source_changed');
    };
    try {authorize(); signal.throwIfAborted();}
    catch (error) {if (native?.session == null) await store.release(session, key); throw error;}
    headers['x-roc-preview-session'] = session;
    if (method === 'HEAD') return new Response(null, {headers});
    const [begin, end] = range ?? [0, document.size];
    if (range !== null) {
      headers['content-range'] = `bytes ${begin}-${end - 1}/${document.size}`;
      headers['content-length'] = String(end - begin);
    }
    try {
      return new Response(store.stream(session, key, begin, end, signal, authorize, native?.session == null),
        {status: range === null ? 200 : 206, headers});
    } catch (error) {
      if (native?.session == null) await store.release(session, key);
      throw error;
    }
  }

  sourceMetrics(): Readonly<Record<string, number>> {
    return this.sources?.metrics() ?? {sessions: 0, creating: 0, snapshotBytes: 0, streams: 0, hashBytes: 0, streamBytes: 0};
  }

  private sourceHeaders(resource: {mediaType: string; filename: string}): Record<string, string> {
    const html = resource.mediaType === 'text/html';
    return {'content-type': html ? 'application/octet-stream' : resource.mediaType,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${html ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(resource.filename)}`};
  }

  private requireSource(request: z.infer<typeof researchDocumentSourceRequestSchema>): ResearchDocument {
    this.requireOpen();
    const document = this.requireProjectDocument(request.projectId, request.documentId);
    if (document.sourceHash !== request.sourceHash) throw new Error('research_document_source_changed');
    if (document.size > maximumDocumentBytes) throw new Error('research_file_size_invalid');
    return document;
  }

  private sourceKey(projectId: string, document: ResearchDocument): string {
    return JSON.stringify([projectId, document.id, document.sourceHash, document.size]);
  }

  private sourceStore(): VerifiedDocumentSources {
    return this.sources ??= new VerifiedDocumentSources();
  }

  async asset(request: z.infer<typeof researchDocumentAssetRequestSchema>): Promise<Buffer> {
    this.requireProjectDocument(request.projectId, request.documentId);
    const { data } = this.repository.documents.parsed(request.documentId, request.parseId);
    const asset = data.content.assets.find((entry) => entry.id === request.assetId);
    const path = data.files[request.assetId];
    if (asset === undefined || path === undefined || asset.sha256 !== request.sha256) throw new Error('research_document_asset_not_found');
    const root = await documentStorageRoot(this.rootPath);
    const output = await researchPath(root, data.outputPath);
    const bytes = await readResearchFile(output, path, 64 * 1024 * 1024);
    if (researchContentHash(bytes) !== asset.sha256 || bytes.length !== asset.size) throw new Error('research_document_asset_changed');
    this.requireProjectDocument(request.projectId, request.documentId);
    const current = this.repository.documents.parsed(request.documentId, request.parseId).data.content.assets.find(entry => entry.id === request.assetId);
    if (current?.sha256 !== asset.sha256 || current.size !== asset.size) throw new Error('research_document_asset_changed');
    return bytes;
  }

  async preview(request: ResearchDocumentPreviewRequest, leaseSource = false): Promise<ResearchDocumentPreview> {
    this.requireOpen();
    const {document, data, parseHash} = this.requireVersionedParse(request);
    if (document.size > maximumDocumentBytes) throw new Error('research_file_size_invalid');
    const coordinates = this.repository.documents.coordinates(document.id, request.parseId);
    const root = await documentStorageRoot(this.rootPath);
    let session: string | null = null;
    try {
    if (leaseSource && document.mediaType === 'application/pdf' && process.env.ROC_PERF_PDF_RANGE_READER !== '0') {
      session = await this.sourceStore().acquire(root, this.repository.documents.sourcePath(document.id),
        {key: this.sourceKey(request.projectId, document), size: document.size, sha256: document.sourceHash}, new AbortController().signal);
    } else await this.verifySource(root, document);
    if (coordinates !== null) {
      const output = await researchPath(root, data.outputPath);
      const bytes = await readResearchFile(output, coordinates.snapshot.artifact.path, maximumArtifactBytes);
      if (bytes.length !== coordinates.snapshot.artifact.size ||
          researchContentHash(bytes) !== coordinates.snapshot.artifact.sha256) throw new Error('research_document_coordinate_artifact_changed');
    }
    // Revalidate scope and immutable metadata after asynchronous filesystem reads.
    const current = this.requireProjectDocument(request.projectId, document.id);
    const currentCoordinates = this.repository.documents.coordinates(document.id, request.parseId);
    if (current.sourceHash !== document.sourceHash || current.size !== document.size ||
        researchContentHash(JSON.stringify(this.repository.documents.parsed(document.id, request.parseId).data.content)) !== parseHash ||
        (currentCoordinates === null ? null : currentCoordinates.snapshotHash) !== (coordinates === null ? null : coordinates.snapshotHash)) {
      throw new Error('research_document_preview_parse_changed');
    }
    const base = `roc-preview://research/projects/${encodeURIComponent(request.projectId)}/documents/${encodeURIComponent(document.id)}`;
    return {
      projectId: request.projectId, documentId: document.id, parseId: request.parseId, sourceHash: document.sourceHash, parseHash,
      filename: document.filename, mediaType: document.mediaType, size: document.size, pageCount: data.content.pageCount,
      sourceUrl: `${base}/source/${document.sourceHash}${session === null ? '' : `?session=${session}`}`,
      assets: data.content.assets.map(asset => ({...asset,
        resourceUrl: `${base}/parses/${encodeURIComponent(request.parseId)}/${encodeURIComponent(asset.id)}/${asset.sha256}.png`})),
      coordinates: coordinates === null ? null : {snapshotHash: coordinates.snapshotHash, pages: coordinates.snapshot.pages}
    };
    } catch (error) {
      if (session !== null) await this.sourceStore().release(session, this.sourceKey(request.projectId, document));
      throw error;
    }
  }

  private requireProjectDocument(projectId: string, documentId: string): ResearchDocument {
    this.repository.getProject(projectId);
    const document = this.repository.documents.get(documentId);
    if (!this.repository.library.get(document.libraryItemId).projectIds.includes(projectId)) {
      throw new Error('research_document_project_mismatch');
    }
    return document;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const tasks = [...this.tasks];
    for (const task of tasks) task.controller.abort();
    await Promise.all([Promise.allSettled(tasks.map(task => task.promise)), this.sources?.shutdown()]);
  }

  private async importFile(request: z.infer<typeof researchDocumentImportRequestSchema>, signal: AbortSignal): Promise<ResearchDocument> {
    if (!isAbsolute(request.sourcePath)) throw new Error('research_absolute_path_required');
    const info = await lstat(request.sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('research_document_source_invalid');
    const extension = extname(request.sourcePath).toLowerCase();
    const mediaType = documentMediaTypes[extension];
    if (mediaType === undefined) throw new Error('research_source_format_unsupported');
    const bytes = await readResearchFile(await researchWorkspace(dirname(request.sourcePath)), basename(request.sourcePath), maximumDocumentBytes);
    return this.persistFile(request, bytes, null, signal);
  }

  private async persistFile(request: z.infer<typeof researchDocumentImportRequestSchema>, bytes: Buffer,
    record: ((document: ResearchDocument) => void) | null, signal: AbortSignal): Promise<ResearchDocument> {
    this.requireActive(signal);
    const extension = extname(request.sourcePath).toLowerCase();
    const mediaType = documentMediaTypes[extension];
    if (mediaType === undefined || bytes.length > maximumDocumentBytes) throw new Error('research_source_format_unsupported');
    const sourceHash = researchContentHash(bytes);
    const root = await documentStorageRoot(this.rootPath);
    const documentsRoot = await createResearchDirectory(root, 'documents');
    const id = `document_${randomUUID()}`;
    const directory = join(documentsRoot, id);
    await mkdir(directory, { mode: 0o700 });
    let persisted = false;
    try {
      this.requireActive(signal);
      const sourcePath = join(directory, `source${extension}`);
      await writeFile(sourcePath, bytes, { mode: 0o600, flag: 'wx' });
      let entry: { metadata: ResearchLiterature; bibliography: ResearchBibliographyEntry } | null = null;
      if (request.target === 'new-item') {
        const now = new Date().toISOString();
        const metadata: ResearchLiterature = { id: `local:document:${sourceHash}`, source: 'local', externalId: `document:${sourceHash}`, doi: null,
          title: request.title, authors: [], abstract: null, publishedYear: null, citationCount: null, url: null, openAccessUrl: null, importedAt: now, updatedAt: now };
        const job = await createResearchDirectory(directory, 'metadata');
        const json = join(job, 'source.json');
        await writeFile(json, JSON.stringify([{ metadata, citationKey: request.citationKey }]), { mode: 0o600, flag: 'wx' });
        const entries = await this.tools.normalizeBibliography({ projectRoot: root, sourcePath: json, outputDir: join(job, 'output'), jobDir: job, signal,
          admission: { projectId: request.projectId, priority: 'user' } });
        if (entries.length !== 1) throw new Error('research_bibliography_response_count_invalid');
        entry = { metadata: { ...metadata, title: entries[0].title, authors: entries[0].authors }, bibliography: entries[0] };
      }
      this.requireActive(signal);
      const input = { id, libraryItemId: request.target === 'library-item' ? request.libraryItemId : null, entry,
        projectId: request.projectId, filename: basename(request.sourcePath), mediaType, sourcePath: researchRelativePath(relative(root, sourcePath)), sourceHash, size: bytes.length };
      const result = record === null ? this.repository.documents.import(input, true) : this.repository.documents.importWithReceipt(input, record);
      persisted = result.created;
      return result.document;
    } finally { if (!persisted) await rm(directory, { recursive: true, force: true }); }
  }

  private async parseFile(documentId: string, parseId: string, signal: AbortSignal, tier: ResearchParseTier | null,
    acquisition?: AcquisitionParse): Promise<ResearchDocument> {
    const document = this.repository.documents.get(documentId);
    this.repository.documents.begin(documentId, parseId);
    const trace = this.repository.processing.trace({trace_id: `document:${parseId}`, paper_id: document.libraryItemId,
      document_id: documentId, parse_id: parseId, source_hash: document.sourceHash});
    const span = trace.start('document_processing');
    let directory: string | null = null;
    let published = false;
    let retained = false;
    let prepared: PreparedLibraryIndex | null = null;
    try {
      const root = await documentStorageRoot(this.rootPath);
      await trace.run('source_read', async () => await this.verifySource(root, document, signal),
        {inputCount: document.size, unit: 'bytes'}, () => document.size);
      this.requireActive(signal);
      const runs = await createResearchDirectory(root, `documents/${documentId}/runs`);
      const job = join(runs, parseId);
      await mkdir(job, { mode: 0o700 });
      directory = job;
      const output = join(job, 'output');
      const sourcePath = await researchPath(root, this.repository.documents.sourcePath(documentId));
      const options = this.tools.defaultParseOptions(document.mediaType);
      const result = await trace.run('document_parse', async () => await this.tools.parseDocument({ projectRoot: root, sourcePath, outputDir: output, jobDir: job, signal, trace,
        admission: { projectId: null, priority: 'user' },
        options: tier === null ? options : { ...options, tier } }), {unit: 'blocks'}, result => result.blocks.length);
      trace.bind({parser_fingerprint: result.parserFingerprint});
      this.requireActive(signal);
      const {data, coordinates} = await collectDocumentContent(root, output, result, signal);
      if (this.semanticGenerator) data.semanticEnrichment = await enrichPaperSemantics(data.content.blocks,
        data.content.structure, this.semanticGenerator, signal, trace);
      if (document.mediaType === 'application/pdf') data.scholarlyEnrichment = await enrichScholarlyFields(
        await readResearchFile(root, this.repository.documents.sourcePath(documentId), maximumDocumentBytes),
        document.sourceHash, data.content.blocks, this.scholarlyParser, signal, trace);
      if (acquisition) this.validateAcquiredContent(document, data);
      if (data.content.quality) {
        data.paperIR = await new PaperIRRepository(root).publish(
          this.repository.documents.buildPaperIR(documentId, parseId, data));
        data.paperIRVersion = data.paperIR.version;
        retained = true;
      }
      if (this.scientificIndex && !acquisition) prepared = await this.scientificIndex.prepare(documentId, parseId, data, signal);
      await this.verifySource(root, document, signal);
      this.requireActive(signal);
      acquisition?.requireCurrent();
      trace.sync('index_publish', () => {
        const publish = () => this.repository.documents.complete(documentId, parseId, data, coordinates, trace, prepared?.staged.generic);
        if (prepared) this.scientificIndex!.publish(prepared, publish, () => this.requireActive(signal));
        else publish();
      },
        {inputCount: result.blocks.length, unit: 'blocks'}, () => result.blocks.length);
      published = true;
      span.finish();
      return this.repository.documents.get(documentId);
    } catch (error) {
      retained ||= hasUnprovenResearchProcessExit(error);
      span.fail(error);
      const cancelled = signal.aborted || this.closed;
      if (prepared) this.scientificIndex!.fail(prepared, signal);
      this.repository.documents.fail(documentId, parseId, cancelled ? 'research_document_parse_cancelled' : failureCode(error), cancelled);
      return this.repository.documents.get(documentId);
    } finally { if (!published && !retained && directory !== null) await rm(directory, { recursive: true, force: true }); }
  }

  private validateAcquiredContent(document: ResearchDocument, data: StoredDocumentContent): void {
    if (!data.content.content.trim() || !data.content.blocks.some(block =>
      ['paragraph', 'table', 'formula'].includes(block.kind) && block.text.trim()) || data.content.quality?.status === 'failed') {
      throw new Error('research_document_body_empty_or_invalid');
    }
    const metadata = this.repository.library.get(document.libraryItemId).metadata;
    const extracted = data.scholarlyEnrichment?.fields?.metadata;
    if (metadata.doi && extracted?.doi && normalizeResearchDoi(metadata.doi) !== normalizeResearchDoi(extracted.doi)) {
      throw new Error('research_document_source_mismatch');
    }
  }

  private async sourceBytes(root: string, document: ResearchDocument): Promise<Buffer> {
    const bytes = await readResearchFile(root, this.repository.documents.sourcePath(document.id), maximumDocumentBytes);
    if (bytes.length !== document.size || researchContentHash(bytes) !== document.sourceHash) throw new Error('research_document_source_changed');
    return bytes;
  }

  private async verifySource(root: string, document: ResearchDocument, signal?: AbortSignal): Promise<void> {
    if (document.size > maximumDocumentBytes) throw new Error('research_file_size_invalid');
    await verifyDocumentSource(root, this.repository.documents.sourcePath(document.id), document.size, document.sourceHash, signal);
  }

  private requireOpen(): void { if (this.closed) throw new Error('research_documents_closed'); }
  private requireActive(signal: AbortSignal): void { if (signal.aborted || this.closed) throw new Error('research_document_parse_cancelled'); }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = message.split(':', 1)[0];
  return /^research_[a-z_]+$/u.test(code) ? code : 'research_document_parse_failed';
}
