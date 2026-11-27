import { ReadingDiscoveryService } from './reading-discovery';
import { ReadingRepository } from './reading-repository';
import { RadarService } from './radar-service';
import { ReadingTranslationService } from './reading-translation';
import { researchReadingCapabilities, registerResearchReadingCapabilities } from './reading-capabilities';
import { ResearchMonitorRepository } from './monitor-repository';
import { ResearchMonitorService } from './monitor-service';
import { registerResearchMonitorCapabilities, researchMonitorCapabilities } from './monitor-capabilities';
import { randomUUID } from 'node:crypto';
import { LiteratureImportService } from './literature-import-service';
import type { RocPluginContext } from '../../kernel/types';
import type { LiteratureSearchService } from './literature-service';
import { ResearchLibraryService } from './library-service';
import {LibraryDeletionRepository} from './library-deletion-repository';
import {LibraryDeletionService} from './library-deletion-service';
import { registerResearchLibraryCapabilities, registerResearchLibraryDeletion } from './library-capabilities';
import { referenceCheckCapability, registerReferenceCheckCapability } from './reference-check-capabilities';
import { ReferenceCheckService } from './reference-check-service';
import { ScholarlyRelationsRepository } from './scholarly-relations-repository';
import { ScholarlyRelationsService } from './scholarly-relations-service';
import { registerResearchScholarlyCapabilities, researchScholarlyCapabilities } from './scholarly-relations-capabilities';
import { OpenReviewRepository } from './openreview-repository';
import { OpenReviewService } from './openreview-service';
import { registerResearchOpenReviewCapabilities, researchOpenReviewCapabilities } from './openreview-capabilities';
import { HuggingFaceRepository } from './huggingface-repository';
import { HuggingFaceService } from './huggingface-service';
import { registerResearchHuggingFaceCapabilities, researchHuggingFaceCapabilities } from './huggingface-capabilities';
import { HuggingFaceDownloadRepository } from './huggingface-download-repository';
import { HuggingFaceDownloadService } from './huggingface-download-service';
import { HuggingFaceDownloader } from './huggingface-downloader';
import { registerResearchHuggingFaceDownloadCapabilities, researchHuggingFaceDownloadCapabilities } from './huggingface-download-capabilities';
import type { createLiteratureProviderGovernor } from './literature-provider-governor';
import { ResearchResourceRepository } from './resource-repository';
import { ResearchResourceService } from './resource-service';
import { registerResearchResourceCapabilities, researchResourceCapabilities } from './resource-capabilities';
import { ResearchResourceAssociationRepository } from './resource-association-repository';
import { registerResearchResourceAssociationCapabilities, researchResourceAssociationCapabilities } from './resource-association-capabilities';
import { shutdownResearchServices } from './research-plugin-lifecycle';
import { pluginId } from './research-plugin-contract';
import type { ResearchPluginOptions } from './research-plugin-options';
import type { ResearchPluginLifecycle } from './research-plugin-lifecycle';
import type { ResearchProductionServices } from './research-plugin-production';
import {LiteratureAcquisitionRepository} from './literature-acquisition-repository';
import {LiteratureAcquisitionService} from './literature-acquisition-service';
import {registerLiteratureAcquisitionCapabilities, readAcquisitionSettings} from './literature-acquisition-capabilities';
import {LiteraturePdfAcquisition} from './literature-pdf-acquisition';
import {PdfDownloadService} from './pdf-download-service';
import type {ResearchDocumentService} from './document-service';
import {ResearchLiteratureAcquisitionWiki} from './literature-acquisition-wiki';
import {LiteratureWikiAcquisition, reconcileAcquisitionReadiness} from './literature-wiki-acquisition';

export type ResearchLiteratureServices = {
  literatureImports: LiteratureImportService;
  releaseDownloads(projectId: string): Promise<void>;
  configureDocumentPipeline(getDocuments: () => Promise<ResearchDocumentService>, peekDocuments: () => ResearchDocumentService | null): void;
};

export async function registerResearchLiterature(
  context: RocPluginContext, options: ResearchPluginOptions,
  lifecycle: ResearchPluginLifecycle, production: ResearchProductionServices,
  literatureService: LiteratureSearchService,
  providerGovernor: ReturnType<typeof createLiteratureProviderGovernor>
): Promise<ResearchLiteratureServices> {
  const { db, researchRepository, researchEmbeddings, toolchain } = production;
  let radar: RadarService | null = null;
  let readingDiscovery: ReadingDiscoveryService | null = null;
  let readingTranslation: ReadingTranslationService | null = null;
  let scholarly: ScholarlyRelationsService | null = null;
  let openreview: OpenReviewService | null = null;
  let huggingface: HuggingFaceService | null = null;
  let huggingfaceDownloads: HuggingFaceDownloadService | null = null;
  let resources: ResearchResourceService | null = null;
  let monitors: ResearchMonitorService | null = null;
  const library = new ResearchLibraryService(researchRepository.library, toolchain, options.libraryRoot ?? null, options.libraryFetch);
  lifecycle.own('library', library);
  registerResearchLibraryCapabilities(context, researchRepository.library, library);
  const researchLibrary = library;
  const deletionRepository = new LibraryDeletionRepository(db, researchRepository);
  const acquisitionRepository = new LiteratureAcquisitionRepository(db);
  const acquisition = new LiteratureAcquisitionService(acquisitionRepository, () => {
    context.logger.error('Literature acquisition worker failed.');
  });
  registerLiteratureAcquisitionCapabilities(context, acquisition);
  const unsubscribeKnowledge = researchRepository.knowledgeJobs.subscribeChanges(() => acquisition.wake());
  const unsubscribeSources = researchRepository.subscribeKnowledgeSources(() => acquisition.wake());
  lifecycle.ownBackgroundServices([{shutdown: async () => {unsubscribeKnowledge(); unsubscribeSources();}}, acquisition]);
  const pdfAcquisition = new LiteraturePdfAcquisition(researchRepository, researchRepository.library,
    new PdfDownloadService(options.resourceRoot), production.notifyWorkspacePathStructureChanged, providerGovernor,
    {getSettings: () => readAcquisitionSettings(context),
      recordPublication: (job, file) => deletionRepository.recordPublication(job, file),
      onProviderError: provider => context.logger.warn('Literature PDF source provider failed.', {provider})});
  const acquisitionWiki = new ResearchLiteratureAcquisitionWiki(researchRepository.wiki, researchRepository.paperCards);
  pdfAcquisition.configureWikiPipeline(new LiteratureWikiAcquisition(acquisitionWiki, acquisitionRepository).process);
  acquisitionRepository.enqueueMissingRadarImports();
  acquisitionRepository.resumeBlockedWiki();
  acquisition.start(pdfAcquisition.process, () => reconcileAcquisitionReadiness(acquisitionRepository, researchRepository, acquisitionWiki));
  lifecycle.provide(context, 'reference-check', [referenceCheckCapability], child => {
    registerReferenceCheckCapability(child, new ReferenceCheckService(researchRepository, literatureService));
  });
  lifecycle.provide(context, 'reading', researchReadingCapabilities, child => {
    const reading = new ReadingRepository(db, researchRepository);
    radar = new RadarService(reading, researchEmbeddings, researchLibrary, acquisition);
    readingTranslation = new ReadingTranslationService(context);
    readingDiscovery = new ReadingDiscoveryService(reading, radar);
    registerResearchReadingCapabilities(child, reading, radar, readingTranslation, readingDiscovery);
  }, async () => {
    try { await shutdownResearchServices([readingDiscovery, radar, readingTranslation]); }
    finally { readingDiscovery = null; radar = null; readingTranslation = null; }
  });
  lifecycle.provide(context, 'scholarly', researchScholarlyCapabilities, child => {
    const scholarlyRepository = new ScholarlyRelationsRepository(db, researchRepository);
    scholarly = new ScholarlyRelationsService(scholarlyRepository, literatureService);
    registerResearchScholarlyCapabilities(child, scholarly, scholarlyRepository);
  }, async () => {
    try { await scholarly?.shutdown(); } finally { scholarly = null; }
  });
  lifecycle.provide(context, 'openreview', researchOpenReviewCapabilities, child => {
    const openReviewRepository = new OpenReviewRepository(db, researchRepository);
    openreview = new OpenReviewService(openReviewRepository, literatureService);
    registerResearchOpenReviewCapabilities(child, openreview, openReviewRepository);
  }, async () => {
    try { await openreview?.shutdown(); } finally { openreview = null; }
  });
  const hfProvider = lifecycle.provide(context, 'huggingface', researchHuggingFaceCapabilities, child => {
    const hfRepository = new HuggingFaceRepository(db, researchRepository);
    huggingface = new HuggingFaceService(hfRepository, literatureService);
    registerResearchHuggingFaceCapabilities(child, huggingface, hfRepository);
    return hfRepository;
  }, async () => {
    try { await huggingface?.shutdown(); } finally { huggingface = null; }
  });
  const downloadProvider = lifecycle.provide(context, 'huggingface-downloads', researchHuggingFaceDownloadCapabilities, async (child, signal) => {
    const hfRepository = await hfProvider.get();
    signal.throwIfAborted();
    huggingfaceDownloads = new HuggingFaceDownloadService(new HuggingFaceDownloadRepository(db, hfRepository),
      hfRepository, new HuggingFaceDownloader(providerGovernor, options.literatureFetch), options.resourceRoot);
    await huggingfaceDownloads.initialize();
    signal.throwIfAborted();
    registerResearchHuggingFaceDownloadCapabilities(child, huggingfaceDownloads);
    return huggingfaceDownloads;
  }, async () => {
    try { await huggingfaceDownloads?.shutdown(); } finally { huggingfaceDownloads = null; }
  });
  // Interrupted downloads require physical partial-file cleanup before their receipt is recovered.
  if (db.prepare("SELECT 1 FROM research_hf_downloads WHERE state='running' LIMIT 1").get() !== undefined) {
    await downloadProvider.get();
  }
  lifecycle.provide(context, 'resources', [...researchResourceCapabilities, ...researchResourceAssociationCapabilities], child => {
    const resourceRepository = new ResearchResourceRepository(db, researchRepository);
    resources = new ResearchResourceService(resourceRepository, literatureService);
    registerResearchResourceCapabilities(child, resources, resourceRepository);
    registerResearchResourceAssociationCapabilities(child,
      new ResearchResourceAssociationRepository(db, researchRepository, resourceRepository));
  }, async () => {
    try { await resources?.shutdown(); } finally { resources = null; }
  });
  const publishLibraryChange = async (items: Array<{ id: string; projectIds: string[] }>, changeKind: 'import' | 'link' | 'archive' | 'citation_key' | 'delete', operationId: string | null = null) => {
    await context.eventBus.publish({ type: 'research.library.changed', source: pluginId, createdAt: new Date().toISOString(),
      payload: { eventId: randomUUID(), operationId, affectedItemIds: items.map((item) => item.id),
        affectedProjectIds: [...new Set(items.flatMap((item) => item.projectIds))], changeKind, occurredAt: new Date().toISOString() } });
  };
  researchRepository.library.onChanged = (items, kind) => {
    void publishLibraryChange(items, kind).catch(() => context.logger.warn('research_library_change_publish_failed'));
  };
  const deletion = new LibraryDeletionService(deletionRepository, acquisition,
    {library: options.libraryRoot ?? null, index: options.indexRoot, resource: options.resourceRoot},
    item => {void publishLibraryChange([item], 'delete').catch(() => context.logger.warn('research_library_change_publish_failed'));},
    production.notifyWorkspacePathStructureChanged,
    documentIds => researchRepository.knowledgeJobs.releaseSources(documentIds),
    (projectId, action) => production.researchIndexer.withProjectReleased(projectId, action),
    async (projectId, documentIds) => {
      if (db.prepare('SELECT 1 FROM research_projects WHERE id=?').get(projectId)) {
        await production.visual.removeLibraryDocuments(projectId, documentIds);
      }
    }, itemId => context.logger.warn('Literature deletion has pending file cleanup.', {itemId}));
  lifecycle.ownBackgroundServices([deletion]);
  registerResearchLibraryDeletion(context, deletion);
  deletion.start();
  const literatureImports = new LiteratureImportService(db, researchRepository.library, literatureService, library, async (result) => {
    const items = result.items.flatMap((item) => item.libraryItemId === null || !db.prepare('SELECT 1 FROM research_library WHERE id=?').get(item.libraryItemId)
      ? [] : [researchRepository.library.get(item.libraryItemId)]);
    await publishLibraryChange(items, 'import', result.operationId);
  }, undefined, acquisition);
  lifecycle.own('literatureImports', literatureImports);
  literatureImports.recover();
  const researchImports = literatureImports;
  const monitorProvider = lifecycle.provide(context, 'monitors', researchMonitorCapabilities, child => {
    const monitorRepository = new ResearchMonitorRepository(db, researchRepository);
    monitors = new ResearchMonitorService(monitorRepository, researchImports, literatureService,
      error => context.logger.error('Literature monitor scheduler failed.', {error: error instanceof Error ? error.message : String(error)}));
    registerResearchMonitorCapabilities(child, monitors, monitorRepository);
    monitors.start();
  }, async () => {
    try { await monitors?.shutdown(); } finally { monitors = null; }
  });
  if (db.prepare("SELECT 1 FROM research_monitor_checks WHERE status='running' LIMIT 1").get() !== undefined ||
      db.prepare(`SELECT 1 FROM research_monitors m JOIN research_projects p ON p.id=m.project_id
        WHERE p.status!='archived' AND json_extract(m.snapshot_json,'$.status')='active' LIMIT 1`).get() !== undefined) {
    await monitorProvider.get();
  }
  return {
    literatureImports,
    releaseDownloads: async projectId => { await huggingfaceDownloads?.releaseProject(projectId); },
    configureDocumentPipeline: (getDocuments, peekDocuments) => {
      deletion.setDocumentService(peekDocuments);
      pdfAcquisition.configureDocumentPipeline(getDocuments);
      acquisition.resumeDocumentPipeline();
    }
  };
}
