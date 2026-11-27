import { notifyResearchTaskChanged } from './task-notifications';
import { registerLiteratureImportCapabilities } from './literature-import-capabilities';
import type { RocPluginContext } from '../../kernel/types';
import type { ZoteroAdapter } from './zotero-adapter';
import { zoteroCapabilities, registerZoteroCapabilities } from './zotero-capabilities';
import { pickZoteroAttachment } from './zotero-attachment-dialog';
import { ResearchDocumentService } from './document-service';
import { registerResearchDocumentCapabilities, researchDocumentCapabilities } from './document-capabilities';
import { registerResearchSystematicReviewCapabilities, researchSystematicReviewCapabilities } from './systematic-review-capabilities';
import { ResearchReviewSearchService } from './review-search-service';
import { registerResearchReviewSearchCapabilities, registerResearchOwnedReviewSearchCapabilities } from './review-search-capabilities';
import { ResearchReviewCorpusRepository } from './review-corpus-repository';
import { registerResearchReviewCorpusCapabilities, researchReviewCorpusCapabilities } from './review-corpus-capabilities';
import { ResearchReviewDeduplicationRepository } from './review-deduplication-repository';
import { registerResearchReviewDeduplicationCapabilities, researchReviewDeduplicationCapabilities } from './review-deduplication-capabilities';
import { ResearchReviewScreeningRepository } from './review-screening-repository';
import { ResearchReviewScreeningDecisions } from './review-screening-decisions';
import { ResearchReviewScreeningArbitration } from './review-screening-arbitration';
import { ResearchReviewScreeningFreeze } from './review-screening-freeze';
import { ResearchReviewFullTextRepository } from './review-fulltext-repository';
import { registerResearchReviewFullTextCapabilities, researchReviewFullTextCapabilities } from './review-fulltext-capabilities';
import { ResearchReviewFullTextScreening } from './review-fulltext-screening';
import { ResearchReviewFullTextArbitration } from './review-fulltext-arbitration';
import { ResearchReviewFullTextFreeze } from './review-fulltext-freeze';
import { ResearchReviewExtractionRepository } from './review-extraction-repository';
import { registerResearchReviewExtractionCapabilities, researchReviewExtractionCapabilities } from './review-extraction-capabilities';
import { ResearchReviewQualityPlanRepository } from './review-quality-plan-repository';
import { ResearchReviewQualityAssessmentRepository } from './review-quality-assessment-repository';
import { ResearchReviewStudiesRepository } from './review-studies-repository';
import { researchReviewStudiesCapabilities, registerResearchReviewStudiesCapabilities } from './review-studies-capabilities';
import { ResearchReviewReportService } from './review-report-service';
import { researchReviewReportCapability, registerResearchReviewReportCapability } from './review-report-capability';
import { registerResearchReviewQualityCapabilities, researchReviewQualityCapabilities } from './review-quality-capabilities';
import { registerResearchReviewFullTextScreeningCapabilities, researchReviewFullTextScreeningCapabilities } from './review-fulltext-screening-capabilities';
import { registerResearchReviewScreeningCapabilities, researchReviewScreeningCapabilities } from './review-screening-capabilities';
import type { ResearchPluginOptions } from './research-plugin-options';
import type { ResearchPluginLifecycle } from './research-plugin-lifecycle';
import type { ResearchProductionServices } from './research-plugin-production';
import type { ResearchLiteratureServices } from './research-plugin-literature';
import {createPaperSemanticGenerator} from './paper-semantic-service';
import {ResearchReviewExtractionPilot} from './review-extraction-pilot';
import {researchReviewPilotCapability,registerResearchReviewPilotCapability} from './review-pilot-capability';

export function registerResearchReview(
  context: RocPluginContext, options: ResearchPluginOptions,
  lifecycle: ResearchPluginLifecycle, production: ResearchProductionServices,
  literature: ResearchLiteratureServices, zotero: ZoteroAdapter
): ResearchReviewSearchService {
  const { db, researchRepository, toolchain } = production;
  const { literatureImports } = literature;
  const researchImports = literatureImports;
  let documents: ResearchDocumentService | null = null;
  const reviewSearches = new ResearchReviewSearchService(db, researchRepository, literatureImports,
    error => context.logger.error('Systematic review search persistence failed.', {error: error instanceof Error ? error.message : String(error)}),
    (taskId, projectId) => notifyResearchTaskChanged(context, taskId, projectId));
  lifecycle.own('reviewSearch', reviewSearches);
  reviewSearches.recover();
  registerResearchReviewSearchCapabilities(context, reviewSearches);
  registerResearchOwnedReviewSearchCapabilities(context, reviewSearches, options.executionGrantBroker);
  registerLiteratureImportCapabilities(context, literatureImports);
  // Recover durable parser state even when no renderer ever opens a document.
  researchRepository.documents.recover();
  const interruptedDocuments = production.scientificLibraryIndex.recover();
  const documentProvider = lifecycle.provide(context, 'documents', [...researchDocumentCapabilities, ...zoteroCapabilities], child => {
    documents = new ResearchDocumentService(researchRepository, toolchain, options.libraryRoot ?? null,
      createPaperSemanticGenerator(options.modelFactory), options.scholarlyParser, production.scientificLibraryIndex);
    registerZoteroCapabilities(child, zotero, researchImports, pickZoteroAttachment, documents);
    registerResearchDocumentCapabilities(child, researchRepository.documents, documents);
    return documents;
  }, async () => {
    try { await documents?.shutdown(); } finally { documents = null; }
  });
  literature.configureDocumentPipeline(() => documentProvider.get(), () => documents);
  if (interruptedDocuments.length) {
    void documentProvider.get().then(async service => {
      await service.parseMany({documentIds: interruptedDocuments, tier: null});
    }).catch(error => context.logger.error('Interrupted library index recovery failed.', {
      error: error instanceof Error ? error.message : String(error)
    }));
  }
  lifecycle.provide(context, 'systematic-review', [
    ...researchSystematicReviewCapabilities, ...researchReviewCorpusCapabilities, ...researchReviewDeduplicationCapabilities,
    ...researchReviewScreeningCapabilities, ...researchReviewFullTextCapabilities, ...researchReviewFullTextScreeningCapabilities,
    ...researchReviewExtractionCapabilities, ...researchReviewQualityCapabilities, ...researchReviewStudiesCapabilities,
    researchReviewReportCapability, researchReviewPilotCapability
  ], async (child, signal) => {
    const researchDocuments = await documentProvider.get();
    signal.throwIfAborted();
    const reviewCorpora = new ResearchReviewCorpusRepository(db, researchRepository, reviewSearches, () => new Date().toISOString());
    registerResearchReviewCorpusCapabilities(child, reviewCorpora);
    const reviewDeduplication = new ResearchReviewDeduplicationRepository(db, researchRepository, reviewCorpora, () => new Date().toISOString());
    registerResearchReviewDeduplicationCapabilities(child, reviewDeduplication);
    const reviewScreening = new ResearchReviewScreeningRepository(db, researchRepository, reviewCorpora, reviewDeduplication, () => new Date().toISOString());
    const reviewScreeningDecisions = new ResearchReviewScreeningDecisions(db, researchRepository, reviewCorpora, reviewDeduplication, reviewScreening, () => new Date().toISOString());
    const reviewScreeningArbitration = new ResearchReviewScreeningArbitration(db, researchRepository, reviewScreeningDecisions, () => new Date().toISOString());
    const reviewScreeningFreeze = new ResearchReviewScreeningFreeze(db, researchRepository, reviewScreeningArbitration, () => new Date().toISOString());
    registerResearchReviewScreeningCapabilities(child, reviewScreening, reviewScreeningDecisions, reviewScreeningArbitration, reviewScreeningFreeze);
    const reviewFullTexts = new ResearchReviewFullTextRepository(db, researchRepository, reviewCorpora, reviewScreeningFreeze, researchDocuments, () => new Date().toISOString());
    registerResearchReviewFullTextCapabilities(child, reviewFullTexts);
    const reviewFullTextScreening = new ResearchReviewFullTextScreening(db, researchRepository, reviewScreeningFreeze, reviewFullTexts, () => new Date().toISOString());
    const reviewFullTextArbitration = new ResearchReviewFullTextArbitration(db, researchRepository, reviewFullTextScreening, reviewFullTexts, () => new Date().toISOString());
    const reviewFullTextFreeze = new ResearchReviewFullTextFreeze(db, researchRepository, reviewFullTextArbitration, reviewFullTexts, () => new Date().toISOString());
    registerResearchReviewFullTextScreeningCapabilities(child, reviewFullTextScreening, reviewFullTextArbitration, reviewFullTextFreeze);
    const reviewExtractions = new ResearchReviewExtractionRepository(db, researchRepository, reviewFullTextFreeze, reviewFullTexts, researchDocuments, () => new Date().toISOString());
    registerResearchReviewExtractionCapabilities(child, reviewExtractions);
    registerResearchReviewPilotCapability(child, new ResearchReviewExtractionPilot(researchRepository, reviewFullTextFreeze, reviewFullTexts, reviewExtractions));
    const reviewQualityPlans = new ResearchReviewQualityPlanRepository(db, researchRepository, reviewExtractions, reviewFullTextFreeze, () => new Date().toISOString());
    const reviewQualityAssessments = new ResearchReviewQualityAssessmentRepository(db, researchRepository, reviewQualityPlans, reviewExtractions, reviewFullTextFreeze, () => new Date().toISOString());
    registerResearchReviewQualityCapabilities(child, reviewQualityPlans, reviewQualityAssessments);
    const reviewStudies = new ResearchReviewStudiesRepository(db, researchRepository, reviewFullTextFreeze, reviewFullTexts, () => new Date().toISOString());
    registerResearchReviewStudiesCapabilities(child, reviewStudies);
    registerResearchReviewReportCapability(child, new ResearchReviewReportService(db, researchRepository, reviewCorpora, reviewSearches,
      reviewDeduplication, reviewScreeningFreeze, reviewFullTextFreeze, reviewStudies, reviewExtractions, reviewQualityPlans, reviewQualityAssessments));
    registerResearchSystematicReviewCapabilities(child, researchRepository.systematicReviews);
  });
  return reviewSearches;
}
