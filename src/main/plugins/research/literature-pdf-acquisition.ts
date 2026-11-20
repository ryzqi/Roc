import {z} from 'zod';
import {paperAcquisitionFailureSchema, type LiteratureAcquisitionSettings} from '../../../shared/schemas/literature-acquisition';
import type {LiteratureProviderGovernor} from './literature-provider-governor';
import type {AcquisitionClaim, AcquisitionOutcome} from './literature-acquisition-repository';
import type {AcquisitionStep} from './literature-acquisition-service';
import type {ResearchRepository} from './repository';
import type {ResearchLibraryRepository} from './library-repository';
import type {WorkspacePathStructureChangeNotifier} from '../../services/workspace-path-structure-event';
import {normalizeResearchArxiv, normalizeResearchDoi, normalizeResearchPmid} from './literature-identity';
import {resolvePdfSources, type PdfResolverDependencies, type PdfSourceCandidate, type PdfSourceInput} from './pdf-source-resolver';
import {PdfDownloadService, pdfFailureRetryAfterMs} from './pdf-download-service';
import type {ResearchDocument} from './document-repository';
import type {ResearchDocumentService} from './document-service';
import {readResearchFile, researchAbsolutePath, researchContentHash, researchWorkspace} from './research-files';

const candidateSchema = z.object({url: z.string().url().max(4096), provider: z.enum(['arxiv', 'openalex', 'semantic_scholar', 'europe_pmc', 'openreview', 'acl', 'cvf', 'unpaywall']),
  version: z.string().nullable(), license: z.string().nullable(), doi: z.string().nullable(), arxivId: z.string().nullable(),
  openAlexId: z.string().nullable()}).strict();
const persistedSourcesSchema = z.object({version: z.literal(1), candidates: z.array(candidateSchema).max(100),
  doiFallbackComplete: z.boolean().optional(), lastFailure: paperAcquisitionFailureSchema.optional()}).strict();
const maximumAttempts = 3;

function normalized<T>(value: string | null | undefined, convert: (value: string) => T): T | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {return convert(value);} catch {return null;}
}

function externalIdentity(item: {metadata: {source: string; externalId: string}}): Partial<PdfSourceInput> {
  const {source, externalId} = item.metadata;
  if (source === 'arxiv') return {arxivId: normalized(externalId, value => normalizeResearchArxiv(value).id)};
  if (source === 'openalex') return {openAlexId: externalId};
  if (source === 'semantic_scholar') return {semanticScholarId: externalId};
  if (source === 'openreview') return {openReviewId: externalId};
  if (source === 'acl') return {aclId: externalId};
  if (source === 'cvf') return {cvfId: externalId};
  if (source === 'pubmed') return {pmid: normalized(externalId, normalizeResearchPmid)};
  if (source === 'europe_pmc') {
    const match = /^(?<namespace>[A-Z]+):(?<id>[^:\s]+)$/u.exec(externalId);
    if (match?.groups?.namespace === 'PMC') return {pmcid: match.groups.id};
    if (match?.groups?.namespace === 'MED') return {pmid: normalized(match.groups.id, normalizeResearchPmid)};
  }
  return {};
}

/** Rebuild provider lookup identity only from committed library metadata and observations. */
export function pdfSourceInputForLibraryItem(library: ResearchLibraryRepository, itemId: string): PdfSourceInput {
  const item = library.get(itemId);
  const input: PdfSourceInput = {doi: normalized(item.metadata.doi, normalizeResearchDoi), ...externalIdentity(item)};
  for (const source of item.sources) {
    if (source.providerRecord === null) continue;
    const provider = source.providerRecord;
    const identity = externalIdentity({metadata: provider});
    input.doi ??= normalized(provider.doi, normalizeResearchDoi);
    input.arxivId ??= identity.arxivId;
    input.openAlexId ??= identity.openAlexId;
    input.semanticScholarId ??= identity.semanticScholarId;
    input.pmid ??= identity.pmid;
    input.pmcid ??= identity.pmcid;
    if (identity.openReviewId) input.openReviewId ??= identity.openReviewId;
    if (identity.aclId) input.aclId ??= identity.aclId;
    if (identity.cvfId) input.cvfId ??= identity.cvfId;
  }
  for (let offset = 0; ; offset += 50) {
    const page = library.getIdentifiers({id: itemId, offset, limit: 50});
    for (const record of page.records) for (const observation of record.identifiers) {
      if (observation.kind === 'doi') input.doi ??= normalized(observation.value, normalizeResearchDoi);
      if (observation.kind === 'arxiv') input.arxivId ??= normalized(observation.value, value => normalizeResearchArxiv(value).id);
      if (observation.kind === 'pmid') input.pmid ??= normalized(observation.value, normalizeResearchPmid);
    }
    if (page.nextOffset === null) break;
  }
  return input;
}

function retryAt(attempt: number, now: number, random: () => number, retryAfterMs: number | null): string {
  const jitter = Math.max(0, Math.min(1, random()));
  const backoff = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(jitter * 5000);
  return new Date(now + Math.max(backoff, retryAfterMs ?? 0)).toISOString();
}

function downloadError(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{2,100}$/u.test(error.message)) return error.message;
  return 'research_pdf_transport_failed';
}

function documentError(error: unknown): string {
  if (error instanceof Error && /^research_[a-z][a-z0-9_]{2,100}$/u.test(error.message)) return error.message;
  return 'research_document_import_failed';
}

function parseError(document: ResearchDocument): string {
  return document.error !== null && /^research_[a-z][a-z0-9_]{2,100}$/u.test(document.error)
    ? document.error : 'research_document_parse_failed';
}

/** Durable resolve/download adapter; parsing remains owned by the following pipeline stage. */
export class LiteraturePdfAcquisition {
  private readonly resolverDependencies: PdfResolverDependencies;
  private initialization: Promise<void> | null = null;
  private documentService: (() => Promise<ResearchDocumentService>) | null = null;
  private wikiProcessor: AcquisitionStep | null = null;

  constructor(private readonly research: ResearchRepository, private readonly library: ResearchLibraryRepository,
    private readonly downloader: PdfDownloadService, private readonly notifyWorkspaceChanged: WorkspacePathStructureChangeNotifier,
    governor: LiteratureProviderGovernor, dependencies: {resolver?: PdfResolverDependencies;
      getSettings?: () => LiteratureAcquisitionSettings;
      onProviderError?: (provider: string, error: unknown) => void; now?: () => number; random?: () => number} = {}) {
    this.resolverDependencies = {...dependencies.resolver, governor,
      onProviderError: (provider, error) => dependencies.onProviderError?.(provider, error)};
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.getSettings = dependencies.getSettings;
  }

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly getSettings: (() => LiteratureAcquisitionSettings) | undefined;

  private resolverOptions(): PdfResolverDependencies {
    return {...this.resolverDependencies, ...this.getSettings?.()};
  }

  initialize(): Promise<void> {
    this.initialization ??= this.downloader.initialize().catch(() => {
      this.initialization = null;
      throw new Error('research_pdf_storage_unavailable');
    });
    return this.initialization;
  }

  configureDocumentPipeline(getDocuments: () => Promise<ResearchDocumentService>): void {
    if (this.documentService !== null) throw new Error('research_document_pipeline_already_configured');
    this.documentService = getDocuments;
  }

  configureWikiPipeline(processor: AcquisitionStep): void {
    this.wikiProcessor = processor;
  }

  readonly process: AcquisitionStep = async (job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void): Promise<AcquisitionOutcome> => {
    if (job.stage === 'import') {
      return await this.importPdf(job, signal, requireCurrent);
    }
    if (job.stage === 'parse') {
      return await this.parsePdf(job, signal, requireCurrent);
    }
    if (job.stage === 'index') {
      return await this.indexPdf(job, signal, requireCurrent);
    }
    if (job.stage === 'wiki') {
      // Index/configuration/source can change while the independently owned Wiki worker runs.
      const indexed = await this.indexPdf(job, signal, requireCurrent);
      if (indexed.stage !== 'wiki') return indexed;
      return this.wikiProcessor === null
        ? {stage: 'wiki', status: 'blocked', errorCode: 'research_literature_wiki_pipeline_not_configured', documentId: job.documentId}
        : await this.wikiProcessor(job, signal, requireCurrent);
    }
    let workspacePath: string;
    try {workspacePath = await this.workspacePath(job, signal, requireCurrent);}
    catch (error) {
      signal.throwIfAborted(); requireCurrent();
      return {stage: 'download', status: 'blocked', errorCode: documentError(error)};
    }
    const notifyWorkspaceChanged = job.projectId === null ? () => {} : this.notifyWorkspaceChanged;

    if (job.stage === 'resolve') {
      let providerFailed = false;
      let providerRetryAt = 0;
      try {
        const existing = this.documentService === null ? undefined : this.research.documents.list(job.libraryItemId)
          .filter(document => document.mediaType === 'application/pdf')
          .sort((a, b) => Number(b.id === job.documentId) - Number(a.id === job.documentId) ||
            Number(b.status === 'ready') - Number(a.status === 'ready') || b.createdAt.localeCompare(a.createdAt))[0];
        if (existing && this.documentService) {
          const documents = await this.documentService();
          const bytes = await documents.acquisitionSource(existing.id, signal);
          requireCurrent();
          const pdf = await this.downloader.publishExisting({jobId: job.id, generation: job.generation,
            libraryItemId: job.libraryItemId, title: job.title, year: this.library.get(job.libraryItemId).metadata.publishedYear,
            workspacePath, bytes, signal, requireCurrent, notifyWorkspaceChanged});
          requireCurrent();
          return {stage: 'import', status: 'queued', documentId: existing.id, receipt: pdf.receipt};
        }
        const identity = pdfSourceInputForLibraryItem(this.library, job.libraryItemId);
        const candidates = await resolvePdfSources(identity, signal, {...this.resolverOptions(),
          onProviderError: (provider, error) => {
            providerFailed = true;
            providerRetryAt = Math.max(providerRetryAt, this.now() + (pdfFailureRetryAfterMs(error) ?? 0));
            this.resolverDependencies.onProviderError?.(provider, error);
          }});
        requireCurrent();
        if (candidates.length === 0) {
          if (providerFailed) return this.transient('resolve', 'research_pdf_provider_unavailable', job, job.source,
            Math.max(0, providerRetryAt - this.now()));
          return {stage: 'download', status: 'unavailable', errorCode: 'research_pdf_sources_unavailable', source: {version: 1, candidates: []}};
        }
        return {stage: 'download', status: 'queued', source: {version: 1, candidates: candidates.slice(0, 100)}};
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        requireCurrent();
        if (providerFailed) return this.transient('resolve', 'research_pdf_provider_unavailable', job, job.source,
          Math.max(0, providerRetryAt - this.now()));
        const code = downloadError(error);
        return {stage: 'download', status: /(?:source_changed|existing_file_conflict)/u.test(code) ? 'blocked' : 'unavailable', errorCode: code};
      }
    }

    const parsed = persistedSourcesSchema.safeParse(job.source);
    if (!parsed.success || parsed.data.candidates.length === 0) {
      return {stage: 'resolve', status: 'queued', source: null, errorCode: 'research_pdf_candidates_missing'};
    }
    try {
      const pdf = await this.downloader.acquire({jobId: job.id, generation: job.generation, libraryItemId: job.libraryItemId,
        title: job.title, year: this.library.get(job.libraryItemId).metadata.publishedYear, workspacePath,
        candidates: parsed.data.candidates as PdfSourceCandidate[], signal, requireCurrent,
        notifyWorkspaceChanged});
      requireCurrent();
      return {stage: 'import', status: this.documentService === null ? 'blocked' : 'queued',
        ...(this.documentService === null ? {errorCode: 'research_document_import_not_configured'} : {}),
        receipt: pdf.receipt, source: parsed.data};
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      requireCurrent();
      const code = downloadError(error);
      if (typeof error === 'object' && error !== null && 'provider' in error && 'category' in error) {
        const failure = paperAcquisitionFailureSchema.safeParse({provider: error.provider, category: error.category,
          code, retryAfterMs: pdfFailureRetryAfterMs(error)});
        if (failure.success) parsed.data.lastFailure = failure.data;
      }
      // Exhaust normal candidates first. Persist completion so a restart cannot repeat
      // a successful DOI lookup indefinitely; transient lookup failures remain retryable.
      const options = this.resolverOptions();
      const canDiscoverAlternative = /^research_pdf_(?:unavailable|sources_unavailable|restricted|content_invalid|size_invalid|address_rejected|download_timeout|transport_failed|http_retryable|http_error)$/u.test(code);
      if (!parsed.data.doiFallbackComplete && options.unpaywallEmail && canDiscoverAlternative) {
        let failed = false, delay = 0;
        const identity = pdfSourceInputForLibraryItem(this.library, job.libraryItemId);
        if (identity.doi || identity.arxivId) {
          const fallback = await resolvePdfSources(identity, signal, {...options, onlyDoiFallback: true,
            onProviderError: (provider, failure) => {
              failed = true; delay = Math.max(delay, pdfFailureRetryAfterMs(failure) ?? 0);
              this.resolverDependencies.onProviderError?.(provider, failure);
            }});
          signal.throwIfAborted(); requireCurrent();
          if (failed) return this.transient('download', 'research_unpaywall_unavailable', job, parsed.data, delay);
          const seen = new Set(parsed.data.candidates.map(candidate => candidate.url));
          const additional = fallback.filter(candidate => !seen.has(candidate.url));
          const source = {...parsed.data, doiFallbackComplete: true};
          if (additional.length > 0) return {stage: 'download', status: 'queued',
            source: {...source, candidates: [...additional, ...source.candidates].slice(0, 100)}};
          parsed.data.doiFallbackComplete = true;
        }
      }
      if (code === 'research_pdf_restricted') return {status: 'blocked', errorCode: code, source: parsed.data};
      if (code === 'research_pdf_unavailable' || code === 'research_pdf_sources_unavailable' ||
          code === 'research_pdf_content_invalid' || code === 'research_pdf_size_invalid' || code === 'research_pdf_address_rejected') {
        return {status: 'unavailable', errorCode: code, source: parsed.data};
      }
      if (code === 'research_pdf_existing_file_conflict') return {status: 'blocked', errorCode: code, source: parsed.data};
      return this.transient('download', code, job, parsed.data, pdfFailureRetryAfterMs(error));
    }
  };

  private async importPdf(job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void): Promise<AcquisitionOutcome> {
    const getDocuments = this.documentService;
    if (getDocuments === null) return {stage: 'import', status: 'blocked', errorCode: 'research_document_import_not_configured'};
    const receipt = job.receipt;
    if (receipt === null || receipt.relativePath === null) {
      return {stage: 'import', status: 'failed', errorCode: 'research_pdf_receipt_missing'};
    }
    try {
      const workspacePath = await this.workspacePath(job, signal, requireCurrent);
      const document = await getDocuments().then(async documents => {
        requireCurrent();
        const workspace = await researchWorkspace(workspacePath);
        const sourcePath = researchAbsolutePath(workspace, receipt.relativePath!);
        const bytes = await readResearchFile(workspace, receipt.relativePath!, receipt.bytes);
        if (bytes.length !== receipt.bytes || researchContentHash(bytes) !== receipt.sha256) throw new Error('research_pdf_receipt_changed');
        requireCurrent();
        const existing = this.findDocument(job, receipt.sha256);
        if (existing !== null) return existing;
        return await documents.importPrepared({target: 'library-item', sourcePath, libraryItemId: job.libraryItemId,
          projectId: job.projectId}, bytes, () => requireCurrent(), signal);
      });
      requireCurrent();
      if (document.sourceHash !== receipt.sha256) {
        return {stage: 'import', status: 'blocked', errorCode: 'research_pdf_receipt_changed', documentId: document.id};
      }
      if (document.status === 'ready' && document.currentParseId !== null) {
        return {stage: 'index', status: 'queued', documentId: document.id};
      }
      return {stage: 'parse', status: 'queued', documentId: document.id};
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return {stage: 'import', status: 'blocked', errorCode: documentError(error), documentId: job.documentId};
    }
  }

  private async parsePdf(job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void): Promise<AcquisitionOutcome> {
    const getDocuments = this.documentService;
    if (getDocuments === null) return {stage: 'parse', status: 'blocked', errorCode: 'research_document_import_not_configured', documentId: job.documentId};
    const document = this.findDocument(job, job.receipt?.sha256 ?? null);
    if (document === null) return {stage: 'import', status: 'queued', documentId: null, errorCode: 'research_document_missing'};
    if (document.status === 'ready' && document.currentParseId !== null) {
      return {stage: 'index', status: 'queued', documentId: document.id};
    }
    try {
      const parsed = await getDocuments().then(async documents => {
        requireCurrent();
        return await documents.parseForAcquisition(document.id, signal, requireCurrent);
      });
      requireCurrent();
      if (parsed.status === 'ready' && parsed.currentParseId !== null) {
        return {stage: 'index', status: 'queued', documentId: parsed.id};
      }
      const errorCode = parseError(parsed);
      return {stage: 'parse', status: /(?:not_configured|unavailable|not_ready|dependency|model_missing)/u.test(errorCode) ? 'blocked' : 'failed',
        errorCode, documentId: parsed.id};
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return {stage: 'parse', status: 'blocked', errorCode: documentError(error), documentId: document.id};
    }
  }

  private async indexPdf(job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void): Promise<AcquisitionOutcome> {
    const document = this.findDocument(job, job.receipt?.sha256 ?? null);
    if (document === null) return {stage: 'parse', status: 'queued', documentId: null, errorCode: 'research_document_missing'};
    if (document.status !== 'ready' || document.currentParseId === null) {
      return {stage: 'parse', status: 'queued', documentId: document.id, errorCode: 'research_document_parse_not_ready'};
    }
    const pending = (errorCode?: string): AcquisitionOutcome => ({stage: 'index', status: 'queued',
      nextRetryAt: new Date(this.now() + 1000).toISOString(), documentId: document.id, ...(errorCode ? {errorCode} : {})});
    const knowledge = this.research.knowledgeJobs.get(`document:${document.currentParseId}`);
    if (knowledge?.status === 'blocked') {
      return {stage: 'index', status: 'blocked', errorCode: 'research_fulltext_index_blocked', documentId: document.id};
    }
    if (knowledge?.status === 'failed') {
      if (job.attempts >= 1) return {stage: 'index', status: 'failed', errorCode: 'research_fulltext_index_failed', documentId: document.id};
      this.research.knowledgeJobs.retry(knowledge.documentId, knowledge.generation);
      return pending('research_fulltext_index_retrying');
    }
    if (knowledge === null) {
      if (job.attempts >= 1) return {stage: 'index', status: 'failed', errorCode: 'research_fulltext_index_missing', documentId: document.id};
      this.research.documents.syncLibraryIndex(document.libraryItemId);
      return pending('research_fulltext_index_requeued');
    }
    if (knowledge.status !== 'ready') return pending();
    try {
      const documents = await this.documentService?.();
      if (documents === undefined) return {stage: 'index', status: 'blocked', errorCode: 'research_document_import_not_configured', documentId: document.id};
      const ir = await documents.paperIR(document.id, document.currentParseId);
      await documents.acquisitionSource(document.id, signal);
      if (job.receipt?.relativePath) {
        const bytes = await readResearchFile(await researchWorkspace(await this.workspacePath(job, signal, requireCurrent)), job.receipt.relativePath, job.receipt.bytes);
        if (bytes.length !== job.receipt.bytes || researchContentHash(bytes) !== job.receipt.sha256) throw new Error('research_pdf_receipt_changed');
      }
      signal.throwIfAborted();
      requireCurrent();
      const current = this.research.documents.get(document.id);
      if (current.status !== 'ready' || current.currentParseId !== document.currentParseId || current.sourceHash !== document.sourceHash) {
        return {stage: 'parse', status: 'queued', documentId: document.id, errorCode: 'research_document_parse_changed'};
      }
      const selected = this.research.knowledge.listEmbeddingConfigRows().find(row => row.enabled === 1);
      if (!selected) return {stage: 'index', status: 'blocked', errorCode: 'research_fulltext_index_blocked', documentId: document.id};
      const generation = this.research.scientificIndex.active(null, document.id);
      const embedding = generation?.snapshot.embedding;
      if (!generation || generation.snapshot.paperIR.identity.parseId !== document.currentParseId ||
        generation.snapshot.paperIR.identity.sourceHash !== document.sourceHash ||
        generation.snapshot.paperIR.sha256 !== this.research.documents.parsed(document.id, document.currentParseId).data.paperIR?.sha256 ||
        ir.identity.parseId !== document.currentParseId || !embedding || embedding.configId !== selected.id ||
        embedding.revision !== selected.revision || embedding.model !== selected.model || embedding.dimensions !== selected.dimensions ||
        !this.research.knowledge.hasDocumentEmbeddings(knowledge.documentId, selected.id, selected.revision)) {
        return {stage: 'index', status: 'failed', errorCode: 'research_fulltext_index_receipt_invalid', documentId: document.id};
      }
      this.research.scientificIndex.verify(generation.id);
      return {stage: 'wiki', status: 'queued', documentId: document.id};
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return {stage: 'index', status: 'failed', errorCode: documentError(error), documentId: document.id};
    }
  }

  private findDocument(job: AcquisitionClaim, sourceHash: string | null): ResearchDocument | null {
    if (job.documentId !== null) {
      try {
        const document = this.research.documents.get(job.documentId);
        if (document.libraryItemId === job.libraryItemId && (sourceHash === null || document.sourceHash === sourceHash)) return document;
      }
      catch (error) { if (!(error instanceof Error) || error.message !== 'research_document_not_found') throw error; }
    }
    if (sourceHash === null) return null;
    return this.research.documents.list(job.libraryItemId).find(document => document.sourceHash === sourceHash) ?? null;
  }

  private async workspacePath(job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void): Promise<string> {
    const checkCurrent = (): void => {signal.throwIfAborted(); requireCurrent();};
    checkCurrent();
    if (job.projectId === null) {
      await this.initialize();
      checkCurrent();
      const workspacePath = await this.downloader.libraryWorkspace();
      checkCurrent();
      return workspacePath;
    }
    let project;
    try {project = this.research.getProject(job.projectId);}
    catch {throw new Error('research_project_unavailable');}
    if (project.workspacePath === null) throw new Error('research_project_workspace_required');
    // Metadata-only resolution cannot publish an existing document or use download storage.
    if (job.stage !== 'resolve' || this.documentService !== null) {
      await this.initialize();
      checkCurrent();
    }
    return project.workspacePath;
  }

  private transient(stage: 'resolve' | 'download', errorCode: string, job: AcquisitionClaim, source: unknown,
    retryAfterMs: number | null = null): AcquisitionOutcome {
    const attempts = job.attempts + 1;
    if (attempts >= maximumAttempts) return {stage, status: 'failed', errorCode, source};
    return {stage, status: 'queued', errorCode, nextRetryAt: retryAt(attempts, this.now(), this.random, retryAfterMs), source};
  }
}
