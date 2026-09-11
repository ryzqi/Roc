import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { z } from 'zod';
import type {
  researchDocumentAssetRequestSchema, researchDocumentImportRequestSchema, researchDocumentParseSchema, researchDocumentSourceRequestSchema
} from '../../../shared/schemas/research-documents';
import type { ResearchBibliographyEntry, ResearchLiterature } from '../../../shared/types';
import { collectDocumentContent, documentMediaTypes, documentStorageRoot, maximumDocumentBytes } from './document-files';
import type { ResearchDocument } from './document-repository';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath, researchWorkspace } from './research-files';

type DocumentTools = Pick<ResearchToolchain, 'parseDocument' | 'normalizeBibliography'>;
type ImportTask = { controller: AbortController; promise: Promise<ResearchDocument> };
type ParseTask = ImportTask & { parseId: string };

export class ResearchDocumentService {
  private readonly tasks = new Set<ImportTask>();
  private readonly parses = new Map<string, ParseTask>();
  private closed = false;

  constructor(private readonly repository: ResearchRepository, private readonly tools: DocumentTools, private readonly rootPath: string | null) {}

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

  async parse(documentId: string): Promise<ResearchDocument> {
    this.requireOpen();
    const active = this.parses.get(documentId);
    if (active !== undefined) return await active.promise;
    const parseId = `parse_${randomUUID()}`;
    const controller = new AbortController();
    const task: ParseTask = { parseId, controller, promise: this.parseFile(documentId, parseId, controller.signal) };
    this.parses.set(documentId, task);
    this.tasks.add(task);
    try { return await task.promise; }
    finally { this.tasks.delete(task); if (this.parses.get(documentId) === task) this.parses.delete(documentId); }
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

  async source(request: z.infer<typeof researchDocumentSourceRequestSchema>): Promise<{ bytes: Buffer; mediaType: string; filename: string }> {
    const document = this.repository.documents.get(request.documentId);
    if (document.sourceHash !== request.sourceHash) throw new Error('research_document_source_changed');
    return { bytes: await this.sourceBytes(await documentStorageRoot(this.rootPath), document), mediaType: document.mediaType, filename: document.filename };
  }

  async asset(request: z.infer<typeof researchDocumentAssetRequestSchema>): Promise<Buffer> {
    const { data } = this.repository.documents.parsed(request.documentId, request.parseId);
    const asset = data.content.assets.find((entry) => entry.id === request.assetId);
    const path = data.files[request.assetId];
    if (asset === undefined || path === undefined || asset.sha256 !== request.sha256) throw new Error('research_document_asset_not_found');
    const root = await documentStorageRoot(this.rootPath);
    const output = await researchPath(root, data.outputPath);
    const bytes = await readResearchFile(output, path, 64 * 1024 * 1024);
    if (researchContentHash(bytes) !== asset.sha256 || bytes.length !== asset.size) throw new Error('research_document_asset_changed');
    return bytes;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const tasks = [...this.tasks];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.promise));
  }

  private async importFile(request: z.infer<typeof researchDocumentImportRequestSchema>, signal: AbortSignal): Promise<ResearchDocument> {
    if (!isAbsolute(request.sourcePath)) throw new Error('research_absolute_path_required');
    const info = await lstat(request.sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('research_document_source_invalid');
    const extension = extname(request.sourcePath).toLowerCase();
    const mediaType = documentMediaTypes[extension];
    if (mediaType === undefined) throw new Error('research_source_format_unsupported');
    const bytes = await readResearchFile(await researchWorkspace(dirname(request.sourcePath)), basename(request.sourcePath), maximumDocumentBytes);
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
        const entries = await this.tools.normalizeBibliography({ projectRoot: root, sourcePath: json, outputDir: join(job, 'output'), jobDir: job, signal });
        if (entries.length !== 1) throw new Error('research_bibliography_response_count_invalid');
        entry = { metadata: { ...metadata, title: entries[0].title, authors: entries[0].authors }, bibliography: entries[0] };
      }
      this.requireActive(signal);
      const result = this.repository.documents.import({ id, libraryItemId: request.target === 'library-item' ? request.libraryItemId : null, entry,
        projectId: request.projectId, filename: basename(request.sourcePath), mediaType, sourcePath: researchRelativePath(relative(root, sourcePath)), sourceHash, size: bytes.length });
      persisted = result.created;
      return result.document;
    } finally { if (!persisted) await rm(directory, { recursive: true, force: true }); }
  }

  private async parseFile(documentId: string, parseId: string, signal: AbortSignal): Promise<ResearchDocument> {
    const document = this.repository.documents.get(documentId);
    this.repository.documents.begin(documentId, parseId);
    let directory: string | null = null;
    let published = false;
    try {
      const root = await documentStorageRoot(this.rootPath);
      await this.sourceBytes(root, document);
      this.requireActive(signal);
      const runs = await createResearchDirectory(root, `documents/${documentId}/runs`);
      const job = join(runs, parseId);
      await mkdir(job, { mode: 0o700 });
      directory = job;
      const output = join(job, 'output');
      const sourcePath = await researchPath(root, this.repository.documents.sourcePath(documentId));
      const result = await this.tools.parseDocument({ projectRoot: root, sourcePath, outputDir: output, jobDir: job, signal });
      this.requireActive(signal);
      const data = await collectDocumentContent(root, output, result);
      await this.sourceBytes(root, document);
      this.requireActive(signal);
      this.repository.documents.complete(documentId, parseId, data);
      published = true;
      return this.repository.documents.get(documentId);
    } catch (error) {
      const cancelled = signal.aborted || this.closed;
      this.repository.documents.fail(documentId, parseId, cancelled ? 'research_document_parse_cancelled' : failureCode(error), cancelled);
      return this.repository.documents.get(documentId);
    } finally { if (!published && directory !== null) await rm(directory, { recursive: true, force: true }); }
  }

  private async sourceBytes(root: string, document: ResearchDocument): Promise<Buffer> {
    const bytes = await readResearchFile(root, this.repository.documents.sourcePath(document.id), maximumDocumentBytes);
    if (bytes.length !== document.size || researchContentHash(bytes) !== document.sourceHash) throw new Error('research_document_source_changed');
    return bytes;
  }

  private requireOpen(): void { if (this.closed) throw new Error('research_documents_closed'); }
  private requireActive(signal: AbortSignal): void { if (signal.aborted || this.closed) throw new Error('research_document_parse_cancelled'); }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = message.split(':', 1)[0];
  return /^research_[a-z_]+$/u.test(code) ? code : 'research_document_parse_failed';
}
