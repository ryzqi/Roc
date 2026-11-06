import { randomUUID } from 'node:crypto';
import type { ExecutionGrantBroker } from '../../services/deep-agent/execution-grant-broker';
import type { ResearchTaskRepository } from './research-task-repository';
import { ResearchTaskController } from './task-controller';
import { researchTaskCapabilities, registerResearchTaskCapabilities } from './task-capabilities';
import { researchProjectBudgetCapabilities, registerResearchProjectBudgetCapabilities } from './project-budget-capabilities';
import { ResearchTaskDiagnosticsService } from './task-diagnostics';
import type { RunBudgetLedger } from '../../services/deep-agent/run-budget-ledger';
import { notifyResearchTaskChanged } from './task-notifications';
import { LiteratureImportService } from './literature-import-service';
import { literatureImportCapabilities, registerLiteratureImportCapabilities } from './literature-import-capabilities';
import { z } from 'zod';
import * as sqliteVec from 'sqlite-vec';
import type { Database } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';

import {
  researchArtifactCreateRequestSchema,
  researchArtifactIdRequestSchema,
  researchArtifactListRequestSchema,
  researchArtifactSchema,
  researchArtifactUpdateRequestSchema,
  researchProjectCreateRequestSchema,
  researchProjectIdRequestSchema,
  researchProjectListRequestSchema,
  researchProjectSchema,
  researchProjectUpdateRequestSchema,
  researchEmbeddingConfigSaveRequestSchema,
  researchEmbeddingConfigSchema,
  researchKnowledgeDocumentSchema,
  researchKnowledgeDocumentUpsertRequestSchema,
  researchKnowledgeSearchRequestSchema,
  researchKnowledgeSearchResultSchema,
  researchStageRoleProfileSchema,
  researchStageRoleRequestSchema,
  researchStageSchema,
  researchProvenanceCreateRequestSchema,
  researchProvenanceSchema,
  researchProvenanceListRequestSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowEventSchema,
  researchWorkflowEventsRequestSchema,
  researchWorkflowTransitionRequestSchema
} from '../../../shared/schemas/research';
import type {
  ResearchEmbeddingConfigSaveRequest,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest,
  ResearchStageRoleRequest,
  ResearchProvenanceCreateRequest,
  ResearchProvenanceListRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { ResearchEmbeddingService } from './embedding-service';
import { LiteratureSearchService } from './literature-service';
import {ZoteroAdapter} from './zotero-adapter';
import {zoteroCapabilities, registerZoteroCapabilities} from './zotero-capabilities';
import {pickZoteroAttachment} from './zotero-attachment-dialog';
import { ResearchRepository } from './repository';
import { getResearchStageRoleProfile } from './role-profiles';
import { ResearchTemplateService } from './template-service';
import { ResearchToolchain } from './toolchain';
import { registerResearchProductionCapabilities, researchProductionCapabilities } from './production-capabilities';
import { researchDerivationGenerationVersion } from '../../../shared/schemas/research-production';
import { ResearchProseLintService } from './prose-lint-service';
import { registerResearchProseCapabilities, researchProseCapabilities } from './prose-lint-capabilities';
import {ResearchCitationCoverageService} from './citation-coverage-service';
import {registerResearchCitationCoverageCapability, researchCitationCoverageCapability} from './citation-coverage-capability';
import {registerResearchCitationReviewCapabilities, researchCitationReviewCapabilities} from './citation-review-capabilities';
import {ResearchConsistencyService} from './consistency-service';
import {registerResearchConsistencyCapabilities, researchConsistencyCapabilities} from './consistency-capabilities';
import {ResearchJournalComplianceService} from './journal-compliance-service';
import {registerResearchJournalComplianceCapabilities, researchJournalComplianceCapabilities} from './journal-compliance-capabilities';
import {registerResearchResponseMatrixCapabilities, researchResponseMatrixCapabilities} from './response-matrix-capabilities';
import {ResearchFigureConsistencyService} from './figure-consistency-service';
import {registerResearchFigureConsistencyCapabilities, researchFigureConsistencyCapabilities} from './figure-consistency-capabilities';
import { ResearchLibraryService } from './library-service';
import { registerResearchLibraryCapabilities, researchLibraryCapabilities } from './library-capabilities';
import {ScholarlyRelationsRepository} from './scholarly-relations-repository';
import {ScholarlyRelationsService} from './scholarly-relations-service';
import {registerResearchScholarlyCapabilities, researchScholarlyCapabilities} from './scholarly-relations-capabilities';
import {OpenReviewRepository} from './openreview-repository';
import {OpenReviewService} from './openreview-service';
import {registerResearchOpenReviewCapabilities, researchOpenReviewCapabilities} from './openreview-capabilities';
import {HuggingFaceRepository} from './huggingface-repository';
import {HuggingFaceService} from './huggingface-service';
import {registerResearchHuggingFaceCapabilities, researchHuggingFaceCapabilities} from './huggingface-capabilities';
import {HuggingFaceDownloadRepository} from './huggingface-download-repository';
import {HuggingFaceDownloadService} from './huggingface-download-service';
import {HuggingFaceDownloader} from './huggingface-downloader';
import {registerResearchHuggingFaceDownloadCapabilities, researchHuggingFaceDownloadCapabilities} from './huggingface-download-capabilities';
import {createLiteratureProviderGovernor} from './literature-provider-governor';
import {ResearchResourceRepository} from './resource-repository';
import {ResearchResourceService} from './resource-service';
import {registerResearchResourceCapabilities, researchResourceCapabilities} from './resource-capabilities';
import {ResearchResourceAssociationRepository} from './resource-association-repository';
import {registerResearchResourceAssociationCapabilities, researchResourceAssociationCapabilities} from './resource-association-capabilities';
import { ResearchDocumentService } from './document-service';
import { registerResearchDocumentCapabilities, researchDocumentCapabilities } from './document-capabilities';
import {registerResearchSystematicReviewCapabilities, researchSystematicReviewCapabilities} from './systematic-review-capabilities';
import {ResearchReviewSearchService} from './review-search-service';
import {registerResearchReviewSearchCapabilities, researchReviewSearchCapabilities,
  registerResearchOwnedReviewSearchCapabilities, researchOwnedReviewSearchCapabilities} from './review-search-capabilities';
import {ResearchReviewCorpusRepository} from './review-corpus-repository';
import {registerResearchReviewCorpusCapabilities, researchReviewCorpusCapabilities} from './review-corpus-capabilities';
import {ResearchReviewDeduplicationRepository} from './review-deduplication-repository';
import {registerResearchReviewDeduplicationCapabilities, researchReviewDeduplicationCapabilities} from './review-deduplication-capabilities';
import {ResearchReviewScreeningRepository} from './review-screening-repository';
import {ResearchReviewScreeningDecisions} from './review-screening-decisions';
import {ResearchReviewScreeningArbitration} from './review-screening-arbitration';
import {ResearchReviewScreeningFreeze} from './review-screening-freeze';
import {ResearchReviewFullTextRepository} from './review-fulltext-repository';
import {registerResearchReviewFullTextCapabilities,researchReviewFullTextCapabilities} from './review-fulltext-capabilities';
import {ResearchReviewFullTextScreening} from './review-fulltext-screening';
import {ResearchReviewFullTextArbitration} from './review-fulltext-arbitration';
import {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
import {ResearchReviewExtractionRepository} from './review-extraction-repository';
import {registerResearchReviewExtractionCapabilities,researchReviewExtractionCapabilities} from './review-extraction-capabilities';
import {ResearchReviewQualityPlanRepository} from './review-quality-plan-repository';
import {ResearchReviewQualityAssessmentRepository} from './review-quality-assessment-repository';
import {ResearchReviewStudiesRepository} from './review-studies-repository';
import {researchReviewStudiesCapabilities,registerResearchReviewStudiesCapabilities} from './review-studies-capabilities';
import {ResearchReviewReportService} from './review-report-service';
import {researchReviewReportCapability,registerResearchReviewReportCapability} from './review-report-capability';
import {registerResearchReviewQualityCapabilities,researchReviewQualityCapabilities} from './review-quality-capabilities';
import {registerResearchReviewFullTextScreeningCapabilities,researchReviewFullTextScreeningCapabilities} from './review-fulltext-screening-capabilities';
import {registerResearchReviewScreeningCapabilities, researchReviewScreeningCapabilities} from './review-screening-capabilities';
import { ResearchIndexService, type ResearchIndexWatch } from './index-service';
import { registerResearchIndexCapabilities, researchIndexCapabilities } from './index-capabilities';
import { ResearchExperimentEnvironmentService } from './experiment-environment';
import { ResearchPythonEnvironmentService } from './python-environment-service';
import { researchPythonEnvironmentCapabilities, registerResearchPythonEnvironmentCapabilities } from './python-environment-capabilities';
import { researchNotebookCapabilities, registerResearchNotebookCapabilities } from './notebook-capabilities';
import { ResearchExperimentService } from './experiment-service';
import {ResearchExperimentResultService} from './experiment-result-service';
import {ResearchIdeaOutcomeService} from './idea-outcome-service';
import {registerResearchIdeaOutcomeCapabilities, researchIdeaOutcomeCapabilities} from './idea-outcome-capabilities';
import {researchExperimentResultCapabilities,registerResearchExperimentResultCapabilities} from './experiment-result-capabilities';
import { registerResearchExperimentCapabilities, researchExperimentCapabilities } from './experiment-capabilities';
import { ResearchFigureService } from './figure-service';
import { registerResearchFigureCapabilities, researchFigureCapabilities } from './figure-capabilities';
import { registerResearchExportCapabilities, researchExportCapabilities } from './export-capabilities';
import { ResearchExportService } from './export-service';
import { ResearchExportSourceService } from './export-sources';
import { ResearchProductionInputService } from './production-input-service';
import { registerResearchProductionInputCapabilities, researchProductionInputCapabilities } from './production-input-capabilities';
import { ResearchProductionEffectService } from './production-effects';
import { ResearchWorkspaceFileService } from './workspace-files';
import {
  workspacePathStructureChangedEventType,
  type WorkspacePathStructureChangeNotifier
} from '../../services/workspace-path-structure-event';
import { registerResearchEvidenceCapabilities, researchEvidenceCapabilities } from './evidence-capabilities';
import { registerResearchManuscriptCapabilities, researchManuscriptCapabilities } from './manuscript-capabilities';
import { registerResearchIdeaCapabilities, researchIdeaCapabilities } from './idea-capabilities';
import {registerResearchIdeaPlanCapabilities, researchIdeaPlanCapabilities} from './idea-plan-capabilities';
import { registerResearchRunCapabilities, researchRunCapabilities } from './run-capabilities';
import {registerResearchArtifactInspectorCapability, researchArtifactInspectorCapability, researchGateReviewCapability} from './artifact-inspector-capability';
import type { ResearchRoleExecutor } from './role-executor';
import { ResearchStageRuntime } from './stage-runtime';
import { createResearchHumanGate } from './human-gate';
import {ResearchArtifactScientificReviewService} from './artifact-scientific-reviews';
import { applyResearchWorkflowTransition, shutdownResearchPlugin } from './research-plugin-lifecycle';
import { createResearchProductionJob } from './research-production-job';
import { researchContentHash } from './research-files';

const pluginId = '@roc/plugin-research';
const capabilityVersion = '1.0.0';
const emptyInputSchema = z.object({}).strict();

const workbenchCapabilities = {
  listProjects: descriptor('research.projects.list', researchProjectListRequestSchema, researchProjectSchema.array()),
  getProject: descriptor('research.projects.get', researchProjectIdRequestSchema, researchProjectSchema),
  createProject: descriptor('research.projects.create', researchProjectCreateRequestSchema, researchProjectSchema),
  updateProject: descriptor('research.projects.update', researchProjectUpdateRequestSchema, researchProjectSchema),
  deleteProject: descriptor('research.projects.delete', researchProjectIdRequestSchema, z.object({ id: z.string(), deleted: z.literal(true) }).strict()),
  getWorkflow: descriptor('research.workflow.get', researchProjectIdRequestSchema, researchWorkflowSnapshotSchema),
  transitionWorkflow: descriptor('research.workflow.transition', researchWorkflowTransitionRequestSchema, researchWorkflowSnapshotSchema),
  verifyStageArtifacts: descriptor(
    'research.workflow.verifyStageArtifacts',
    z.object({ projectId: z.string().min(1), stage: researchStageSchema }).strict(),
    z.object({ passed: z.boolean(), detail: z.string(), refs: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()) }).strict()
  ),
  stageRole: descriptor('research.workflow.role', researchStageRoleRequestSchema, researchStageRoleProfileSchema)
};
const knowledgeCapabilities = {
  listEmbedding: descriptor('research.embedding.list', emptyInputSchema, researchEmbeddingConfigSchema.array()),
  saveEmbedding: descriptor('research.embedding.save', researchEmbeddingConfigSaveRequestSchema, researchEmbeddingConfigSchema),
  upsertDocument: descriptor('research.knowledge.upsert', researchKnowledgeDocumentUpsertRequestSchema, researchKnowledgeDocumentSchema),
  search: descriptor('research.knowledge.search', researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema)
};
const provenanceCapabilities = {
  add: descriptor('research.provenance.add', researchProvenanceCreateRequestSchema, researchProvenanceSchema),
  list: descriptor('research.provenance.list', researchProvenanceListRequestSchema, researchProvenanceSchema.array())
};
const researchCapabilityDescriptors = [
  ...Object.values(workbenchCapabilities),
  ...literatureImportCapabilities,
  ...zoteroCapabilities,
  ...Object.values(knowledgeCapabilities),
  ...Object.values(provenanceCapabilities)
];

const lifecycleCapabilities = {
  createArtifact: descriptor('research.artifacts.create', researchArtifactCreateRequestSchema, researchArtifactSchema),
  getArtifact: descriptor('research.artifacts.get', researchArtifactIdRequestSchema, researchArtifactSchema),
  listArtifacts: descriptor('research.artifacts.list', researchArtifactListRequestSchema, researchArtifactSchema.array()),
  updateArtifact: descriptor('research.artifacts.update', researchArtifactUpdateRequestSchema, researchArtifactSchema),
  events: descriptor('research.workflow.events', researchWorkflowEventsRequestSchema, researchWorkflowEventSchema.array())
};

export type ResearchPluginOptions = {
  resourceRoot: string;
  executionGrantBroker: ExecutionGrantBroker;
  tasks: ResearchTaskRepository;
  budgetLedger: RunBudgetLedger;
  experimentRoot?: string;
  exportRoot?: string;
  indexRoot?: string;
  indexWatch?: ResearchIndexWatch;
  libraryRoot?: string;
  /** 文稿检查的私有 job 根目录：投影文件与 Vale 的 HOME/缓存都写在里面，跑完即删。 */
  proseRoot?: string;
  libraryFetch?: ConstructorParameters<typeof ResearchLibraryService>[3];
  toolchainRoot?: string;
  modelsRoot?: string;
  roleExecutor?: ResearchRoleExecutor;
  literatureFetch?: ConstructorParameters<typeof LiteratureSearchService>[0];
  zoteroFetch?: ConstructorParameters<typeof ZoteroAdapter>[0];
  embeddingFetch?: ConstructorParameters<typeof OpenAICompatibleEmbeddingClient>[0];
};

export function createResearchPlugin(options: ResearchPluginOptions): RocPlugin {
  let repository: ResearchRepository | null = null;
  let stageRuntime: ResearchStageRuntime | null = null;
  let templates: ResearchTemplateService | null = null;
  let library: ResearchLibraryService | null = null;
  let scholarly: ScholarlyRelationsService | null = null;
  let resources: ResearchResourceService | null = null;
  let openreview: OpenReviewService | null = null;
  let huggingface: HuggingFaceService | null = null;
  let huggingfaceDownloads: HuggingFaceDownloadService | null = null;
  let documents: ResearchDocumentService | null = null;
  let embeddings: ResearchEmbeddingService | null = null;
  let indexer: ResearchIndexService | null = null;
  let experiments: ResearchExperimentService | null = null;
  let pythonEnvironments: ResearchPythonEnvironmentService | null = null;
  let figures: ResearchFigureService | null = null;
  let exports: ResearchExportService | null = null;
  let productionInputs: ResearchProductionInputService | null = null;
  let prose: ResearchProseLintService | null = null;
  const toolchain = new ResearchToolchain(options.toolchainRoot ?? null, options.modelsRoot ?? null);
  let literatureImports: LiteratureImportService | null = null;
  let reviewSearch: ResearchReviewSearchService | null = null;
  const providerGovernor = createLiteratureProviderGovernor();
  const literatureService = new LiteratureSearchService(options.literatureFetch, providerGovernor);
  const zotero = new ZoteroAdapter(options.zoteroFetch);
  const embeddingClient = new OpenAICompatibleEmbeddingClient(options.embeddingFetch);
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Research Workbench',
      description: '科研项目、阶段流程和 Provenance 基础能力。',
      required: true,
      order: 55,
      dependencies: ['@roc/plugin-agent', '@roc/plugin-workspace'],
      capabilities: [researchArtifactInspectorCapability, researchGateReviewCapability, ...researchProjectBudgetCapabilities, ...researchTaskCapabilities, ...researchCapabilityDescriptors, ...Object.values(lifecycleCapabilities), ...researchEvidenceCapabilities, ...researchManuscriptCapabilities, ...researchIdeaCapabilities, ...researchIdeaPlanCapabilities, ...researchIdeaOutcomeCapabilities, ...researchRunCapabilities, ...researchProductionCapabilities, ...researchLibraryCapabilities, ...researchScholarlyCapabilities, ...researchResourceCapabilities, ...researchOpenReviewCapabilities, ...researchHuggingFaceCapabilities, ...researchHuggingFaceDownloadCapabilities, ...researchResourceAssociationCapabilities, ...researchDocumentCapabilities, ...researchSystematicReviewCapabilities, ...researchReviewSearchCapabilities, ...researchOwnedReviewSearchCapabilities, ...researchReviewCorpusCapabilities, ...researchReviewDeduplicationCapabilities, ...researchReviewScreeningCapabilities, ...researchReviewFullTextCapabilities, ...researchReviewFullTextScreeningCapabilities, ...researchReviewExtractionCapabilities, ...researchReviewQualityCapabilities, ...researchReviewStudiesCapabilities, researchReviewReportCapability, ...researchIndexCapabilities, ...researchExperimentCapabilities, ...researchPythonEnvironmentCapabilities, ...researchNotebookCapabilities, ...researchExperimentResultCapabilities, ...researchFigureCapabilities, ...researchExportCapabilities, ...researchProductionInputCapabilities, ...researchProseCapabilities, researchCitationCoverageCapability, ...researchCitationReviewCapabilities, ...researchConsistencyCapabilities, ...researchFigureConsistencyCapabilities, ...researchResponseMatrixCapabilities, ...researchJournalComplianceCapabilities]
    },
    initialize: async (context: RocPluginContext) => {
      // 模型选择存在 `plugin_config` 里：存储构造时还没有 context，必须在这里接上，
      // 否则用户选的解析配置每次重启都会丢。
      toolchain.attachModelConfig(context.config);
      const db = context.database.getConnection();
      loadResearchVectorExtension(db);
      repository = new ResearchRepository(db, options.tasks);
      const researchRepository = repository;
      const researchEmbeddings = new ResearchEmbeddingService(researchRepository.knowledge, embeddingClient, context);
      embeddings = researchEmbeddings;
      researchRepository.setKnowledgeWriter((input, sourceMetadata = {}) => researchEmbeddings.upsertFromSource(input, sourceMetadata));
      const researchIndexer = new ResearchIndexService(researchRepository, toolchain, researchEmbeddings, options.indexRoot ?? null, context.logger, options.indexWatch);
      indexer = researchIndexer;
      registerResearchIndexCapabilities(context, researchRepository.indexing, researchIndexer);
      const researchPythonEnvironments = new ResearchPythonEnvironmentService(researchRepository);
      pythonEnvironments = researchPythonEnvironments;
      registerResearchPythonEnvironmentCapabilities(context, researchRepository.pythonEnvironments, researchPythonEnvironments);
      registerResearchNotebookCapabilities(context, researchRepository.notebooks);
      const researchExperiments = new ResearchExperimentService(researchRepository, new ResearchExperimentEnvironmentService(toolchain, researchPythonEnvironments), options.experimentRoot ?? null, context.logger);
      experiments = researchExperiments;
      registerResearchExperimentCapabilities(context, researchRepository.experiments, researchExperiments);
      const researchResults = new ResearchExperimentResultService(researchRepository, researchExperiments);
      registerResearchExperimentResultCapabilities(context, researchRepository.experimentResults, researchResults);
      registerResearchIdeaOutcomeCapabilities(context, researchRepository.ideaOutcomes,
        new ResearchIdeaOutcomeService(researchRepository, researchResults));
      const researchFigures = new ResearchFigureService(researchRepository, toolchain, options.experimentRoot ?? null, context.logger);
      figures = researchFigures;
      registerResearchFigureCapabilities(context, researchRepository.figures, researchFigures);
      registerResearchFigureConsistencyCapabilities(context,
        new ResearchFigureConsistencyService(researchRepository, researchFigures, researchResults), researchRepository.figureConsistency);
      researchRepository.runs.reconcileTaskLinks();
      researchRepository.runs.recoverInterrupted();
      researchRepository.recoverTemplateCompiles();
      const notifyWorkspacePathStructureChanged: WorkspacePathStructureChangeNotifier = (workspacePath, reason) => {
        void context.eventBus.publish({
          type: workspacePathStructureChangedEventType,
          source: pluginId,
          payload: { workspacePath, reason },
          createdAt: new Date().toISOString()
        }).catch((error: unknown) => {
          context.logger.warn('Research workspace path structure event publish failed.', {
            workspacePath,
            reason,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      };
      const researchTemplates = new ResearchTemplateService(researchRepository, toolchain, notifyWorkspacePathStructureChanged);
      templates = researchTemplates;
      registerResearchProductionCapabilities(context, researchTemplates, toolchain);
      const researchExports = new ResearchExportService(researchRepository,
        new ResearchExportSourceService(researchRepository, researchFigures, researchExperiments, researchTemplates), toolchain, options.exportRoot ?? null, context.logger);
      exports = researchExports;
      registerResearchExportCapabilities(context, researchRepository.exports, researchExports);
      const productionJob = createResearchProductionJob({
        repository: researchRepository,
        experiments: researchExperiments,
        figures: researchFigures,
        exports: researchExports
      });
      productionJob.recover();
      productionInputs = new ResearchProductionInputService(researchRepository, researchExperiments, researchFigures, researchExports);
      registerResearchProductionInputCapabilities(context, productionInputs);
      const researchProse = new ResearchProseLintService(researchRepository, toolchain, options.proseRoot ?? null);
      prose = researchProse;
      registerResearchProseCapabilities(context, researchProse);
      registerResearchCitationCoverageCapability(context, new ResearchCitationCoverageService(researchRepository));
      registerResearchCitationReviewCapabilities(context, researchRepository.citationReviews);
      registerResearchJournalComplianceCapabilities(context,
        new ResearchJournalComplianceService(researchRepository, researchFigures), researchRepository.journalCompliance);
      registerResearchResponseMatrixCapabilities(context, researchRepository.responseMatrix);
      registerResearchConsistencyCapabilities(context, new ResearchConsistencyService(researchRepository, researchResults), researchRepository.consistency);
      library = new ResearchLibraryService(researchRepository.library, toolchain, options.libraryRoot ?? null, options.libraryFetch);
      registerResearchLibraryCapabilities(context, researchRepository.library, library);
      const scholarlyRepository = new ScholarlyRelationsRepository(db, researchRepository);
      scholarly = new ScholarlyRelationsService(scholarlyRepository, literatureService);
      registerResearchScholarlyCapabilities(context, scholarly, scholarlyRepository);
      const openReviewRepository = new OpenReviewRepository(db, researchRepository);
      openreview = new OpenReviewService(openReviewRepository, literatureService);
      registerResearchOpenReviewCapabilities(context, openreview, openReviewRepository);
      const hfRepository = new HuggingFaceRepository(db, researchRepository);
      huggingface = new HuggingFaceService(hfRepository, literatureService);
      registerResearchHuggingFaceCapabilities(context, huggingface, hfRepository);
      huggingfaceDownloads = new HuggingFaceDownloadService(new HuggingFaceDownloadRepository(db, hfRepository),
        hfRepository, new HuggingFaceDownloader(providerGovernor, options.literatureFetch), options.resourceRoot);
      await huggingfaceDownloads.initialize();
      registerResearchHuggingFaceDownloadCapabilities(context, huggingfaceDownloads);
      const resourceRepository = new ResearchResourceRepository(db, researchRepository);
      resources = new ResearchResourceService(resourceRepository, literatureService);
      registerResearchResourceCapabilities(context, resources, resourceRepository);
      registerResearchResourceAssociationCapabilities(context,
        new ResearchResourceAssociationRepository(db, researchRepository, resourceRepository));
      const publishLibraryChange = async (items: Array<{ id: string; projectIds: string[] }>, changeKind: 'import' | 'link' | 'archive' | 'citation_key', operationId: string | null = null) => {
        await context.eventBus.publish({ type: 'research.library.changed', source: pluginId, createdAt: new Date().toISOString(),
          payload: { eventId: randomUUID(), operationId, affectedItemIds: items.map((item) => item.id),
            affectedProjectIds: [...new Set(items.flatMap((item) => item.projectIds))], changeKind, occurredAt: new Date().toISOString() } });
      };
      researchRepository.library.onChanged = (items, kind) => {
        void publishLibraryChange(items, kind).catch(() => context.logger.warn('research_library_change_publish_failed'));
      };
      literatureImports = new LiteratureImportService(db, researchRepository.library, literatureService, library, async (result) => {
        const items = result.items.flatMap((item) => item.libraryItemId === null ? [] : [researchRepository.library.get(item.libraryItemId)]);
        await publishLibraryChange(items, 'import', result.operationId);
      });
      literatureImports.recover();
      const reviewSearches = new ResearchReviewSearchService(db, researchRepository, literatureImports,
        error => context.logger.error('Systematic review search persistence failed.', {error: error instanceof Error ? error.message : String(error)}),
        (taskId, projectId) => notifyResearchTaskChanged(context, taskId, projectId));
      reviewSearch = reviewSearches;
      reviewSearches.recover();
      registerResearchReviewSearchCapabilities(context, reviewSearches);
      registerResearchOwnedReviewSearchCapabilities(context, reviewSearches, options.executionGrantBroker);
      const reviewCorpora = new ResearchReviewCorpusRepository(db, researchRepository, reviewSearches, () => new Date().toISOString());
      registerResearchReviewCorpusCapabilities(context, reviewCorpora);
      const reviewDeduplication = new ResearchReviewDeduplicationRepository(db, researchRepository, reviewCorpora, () => new Date().toISOString());
      registerResearchReviewDeduplicationCapabilities(context, reviewDeduplication);
      const reviewScreening = new ResearchReviewScreeningRepository(db, researchRepository, reviewCorpora, reviewDeduplication, () => new Date().toISOString());
      const reviewScreeningDecisions = new ResearchReviewScreeningDecisions(db, researchRepository, reviewCorpora, reviewDeduplication, reviewScreening, () => new Date().toISOString());
      const reviewScreeningArbitration = new ResearchReviewScreeningArbitration(db, researchRepository, reviewScreeningDecisions, () => new Date().toISOString());
      const reviewScreeningFreeze = new ResearchReviewScreeningFreeze(db, researchRepository, reviewScreeningArbitration, () => new Date().toISOString());
      registerResearchReviewScreeningCapabilities(context, reviewScreening, reviewScreeningDecisions, reviewScreeningArbitration, reviewScreeningFreeze);
      registerLiteratureImportCapabilities(context, literatureImports);
      researchRepository.documents.recover();
      // Only text/locator derivation changes advance this index generation; artifact-only contracts keep old parses active.
      if (researchRepository.documents.switchDerivationGeneration(researchDerivationGenerationVersion)) {
        context.logger.info('research_derivation_generation_switched', { generationVersion: researchDerivationGenerationVersion });
      }
      documents = new ResearchDocumentService(researchRepository, toolchain, options.libraryRoot ?? null);
      registerZoteroCapabilities(context, zotero, literatureImports, pickZoteroAttachment, documents);
      registerResearchDocumentCapabilities(context, researchRepository.documents, documents);
      const reviewFullTexts=new ResearchReviewFullTextRepository(db,researchRepository,reviewCorpora,reviewScreeningFreeze,documents,()=>new Date().toISOString());
      registerResearchReviewFullTextCapabilities(context,reviewFullTexts);
      const reviewFullTextScreening=new ResearchReviewFullTextScreening(db,researchRepository,reviewScreeningFreeze,reviewFullTexts,()=>new Date().toISOString());
      const reviewFullTextArbitration=new ResearchReviewFullTextArbitration(db,researchRepository,reviewFullTextScreening,reviewFullTexts,()=>new Date().toISOString());
      const reviewFullTextFreeze=new ResearchReviewFullTextFreeze(db,researchRepository,reviewFullTextArbitration,reviewFullTexts,()=>new Date().toISOString());
      registerResearchReviewFullTextScreeningCapabilities(context,reviewFullTextScreening,reviewFullTextArbitration,reviewFullTextFreeze);
      const reviewExtractions=new ResearchReviewExtractionRepository(db,researchRepository,reviewFullTextFreeze,reviewFullTexts,documents,()=>new Date().toISOString());
      registerResearchReviewExtractionCapabilities(context,reviewExtractions);
      const reviewQualityPlans=new ResearchReviewQualityPlanRepository(db,researchRepository,reviewExtractions,reviewFullTextFreeze,()=>new Date().toISOString());
      const reviewQualityAssessments=new ResearchReviewQualityAssessmentRepository(db,researchRepository,reviewQualityPlans,reviewExtractions,reviewFullTextFreeze,()=>new Date().toISOString());
      registerResearchReviewQualityCapabilities(context,reviewQualityPlans,reviewQualityAssessments);
      const reviewStudies=new ResearchReviewStudiesRepository(db,researchRepository,reviewFullTextFreeze,reviewFullTexts,()=>new Date().toISOString());
      registerResearchReviewStudiesCapabilities(context,reviewStudies);
      registerResearchReviewReportCapability(context,new ResearchReviewReportService(db,researchRepository,reviewCorpora,reviewSearches,
        reviewDeduplication,reviewScreeningFreeze,reviewFullTextFreeze,reviewStudies,reviewExtractions,reviewQualityPlans,reviewQualityAssessments));
      registerResearchSystematicReviewCapabilities(context, researchRepository.systematicReviews);
      const effects = new ResearchProductionEffectService(researchRepository,
        new ResearchWorkspaceFileService(db, researchRepository, () => new Date().toISOString(), notifyWorkspacePathStructureChanged),
        researchExperiments, researchFigures, researchTemplates, researchExports);
      const scientificReviews = new ResearchArtifactScientificReviewService(researchRepository, researchResults, researchFigures);
      const humanGate = createResearchHumanGate({ repository: researchRepository, production: productionJob, scientificReviews });
      const runtime = new ResearchStageRuntime(researchRepository, context.capabilities, options.roleExecutor, humanGate, effects,
        (taskId, projectId) => notifyResearchTaskChanged(context, taskId, projectId));
      stageRuntime = runtime;
      const taskController = new ResearchTaskController(options.tasks, {
        stages: runtime,
        cancelChat: async runId => await context.capabilities.invoke('agent.run.cancel', { runId }),
        cancelJob: async (kind, projectId, executionId) => {
          switch (kind) {
            case 'experiment': return await researchExperiments.cancel(projectId, executionId);
            case 'figure': return await researchFigures.cancel(projectId, executionId);
            case 'export': return await researchExports.cancel(projectId, executionId);
            case 'review_search': return await reviewSearches.cancelTaskQuery(projectId, executionId);
          }
        }
      });
      registerResearchTaskCapabilities(context, options.tasks, taskController,
        new ResearchTaskDiagnosticsService(researchRepository, options.budgetLedger, reviewSearches));
      registerResearchProjectBudgetCapabilities(context, researchRepository);
      registerResearchRunCapabilities(context, researchRepository.runs, runtime, researchRepository.reviews, options.executionGrantBroker);
      registerResearchArtifactInspectorCapability(context, researchRepository);
      registerResearchEvidenceCapabilities(context, researchRepository.evidence);
      registerResearchManuscriptCapabilities(context, researchRepository.manuscripts);
      registerResearchIdeaCapabilities(context, researchRepository.ideas);
      registerResearchIdeaPlanCapabilities(context, researchRepository.ideaPlans);
      context.capabilities.register(pluginId, lifecycleCapabilities.createArtifact, async (input) =>
        researchRepository.createArtifact(researchArtifactCreateRequestSchema.parse(input)));
      context.capabilities.register(pluginId, lifecycleCapabilities.getArtifact, async (input) =>
        researchRepository.getArtifact(researchArtifactIdRequestSchema.parse(input).id));
      context.capabilities.register(pluginId, lifecycleCapabilities.listArtifacts, async (input) => {
        const request = researchArtifactListRequestSchema.parse(input);
        return researchRepository.listArtifacts(request.projectId, request.stage);
      });
      context.capabilities.register(pluginId, lifecycleCapabilities.updateArtifact, async (input) =>
        researchRepository.updateArtifact(researchArtifactUpdateRequestSchema.parse(input)));
      context.capabilities.register(pluginId, lifecycleCapabilities.events, async (input) =>
        researchRepository.listWorkflowEvents(researchWorkflowEventsRequestSchema.parse(input)));
      context.capabilities.register(pluginId, workbenchCapabilities.listProjects, async () => repository!.listProjects());
      context.capabilities.register(pluginId, workbenchCapabilities.getProject, async (input) => repository!.getProject((input as { id: string }).id));
      context.capabilities.register(pluginId, workbenchCapabilities.createProject, async (input) => {
        const project = researchRepository.createProject(researchProjectCreateRequestSchema.parse(input));
        researchIndexer.projectChanged(project.id);
        return project;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.updateProject, async (input) => {
        const project = researchRepository.updateProject(researchProjectUpdateRequestSchema.parse(input));
        researchIndexer.projectChanged(project.id);
        researchExperiments.projectChanged(project.id);
        researchFigures.projectChanged(project.id);
        researchExports.projectChanged(project.id);
        if (project.status === 'archived') {
          await reviewSearches.releaseProject(project.id);
          await researchPythonEnvironments.releaseProject(project.id);
        }
        return project;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.deleteProject, async (input) => {
        const request = researchProjectIdRequestSchema.parse(input);
        await reviewSearches.releaseProject(request.id);
        await researchPythonEnvironments.releaseProject(request.id);
        await huggingfaceDownloads!.releaseProject(request.id);
        const result = researchRepository.deleteProject(request.id);
        researchIndexer.releaseProject(request.id);
        researchExperiments.releaseProject(request.id);
        researchFigures.releaseProject(request.id);
        researchExports.releaseProject(request.id);
        runtime.releaseProject(request.id);
        return result;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.getWorkflow, async (input) => repository!.getWorkflow((input as { id: string }).id));
      context.capabilities.register(pluginId, workbenchCapabilities.verifyStageArtifacts, async (input) => {
        const request = z.object({ projectId: z.string().min(1), stage: researchStageSchema }).strict().parse(input);
        const proof = repository!.verifyStageForTaskAcceptance(request.projectId, request.stage);
        const refs = [...proof.refs];
        const stage = researchRepository.getWorkflow(request.projectId).stages.find((item) => item.stage === request.stage);
        if (stage === undefined) throw new Error('research_stage_not_found');
        await scientificReviews.verifyArtifacts(request.projectId, stage.artifactIds);
        if (request.stage === 'experiment') {
          for (const id of stage.artifactIds) {
            const artifact = researchRepository.getArtifact(id);
            const run = researchRepository.experiments.forArtifact(artifact);
            const verified = await researchExperiments.snapshot(request.projectId, run.id);
            const { artifactId: _artifactId, ...manifest } = verified;
            refs.push({ path: `research-experiment:${run.id}/manifest.json`, sha256: researchContentHash(JSON.stringify(manifest, null, 2)) });
            refs.push(...verified.files.map((file) => ({ path: `research-experiment:${run.id}/${file.area}/${file.path}`, sha256: file.sha256 })));
            refs.push({ path: `research-experiment:${run.id}/environment`, sha256: researchContentHash(JSON.stringify(run.environment)) });
          }
        } else if (request.stage === 'figure') {
          await researchFigures.verifyStage(request.projectId);
          for (const id of stage.artifactIds) {
            const artifact = researchRepository.getArtifact(id);
            const publication = researchRepository.figures.forArtifact(artifact);
            const run = researchRepository.figureRuns.get(request.projectId, publication.runId);
            refs.push({ path: `research-figure:${run.id}/figure-manifest.json`, sha256: publication.manifestHash });
            refs.push(...run.files.map((file) => ({ path: `research-figure:${run.id}/${file.area}/${file.path}`, sha256: file.sha256 })));
            refs.push({ path: `research-figure:${run.id}/environment`, sha256: researchContentHash(JSON.stringify(run.environment)) });
          }
        } else if (request.stage === 'export') {
          await researchExports.verifyStage(request.projectId);
          for (const id of stage.artifactIds) {
            const artifact = researchRepository.getArtifact(id);
            const record = researchRepository.exports.forArtifact(artifact);
            refs.push({ path: `research-export:${record.id}/sources`, sha256: record.sourceHash! });
            refs.push(...record.files.map((file) => ({ path: `research-export:${record.id}/bundle/${file.path}`, sha256: file.sha256 })));
            if (record.archive !== null) refs.push({ path: `research-export:${record.id}/${record.archive.path}`, sha256: record.archive.sha256 });
          }
        }
        const currentProof = researchRepository.verifyStageForTaskAcceptance(request.projectId, request.stage);
        if (JSON.stringify(currentProof) !== JSON.stringify(proof)) throw new Error('research_artifact_review_changed');
        const uniqueRefs = [...new Map(refs.map((ref) => [ref.path, ref])).values()];
        return { ...proof, detail: `${proof.detail} Full ${request.stage} verifier passed.`, refs: uniqueRefs };
      });
      context.capabilities.register(pluginId, workbenchCapabilities.transitionWorkflow, async input => {
        const request = researchWorkflowTransitionRequestSchema.parse(input);
        if (request.action === 'pause') {
          const workflow = researchRepository.getWorkflow(request.projectId);
          if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
          const runId = workflow.stages.find(stage => stage.stage === request.expectedStage)?.activeRunId;
          if (runId !== null && runId !== undefined) {
            const run = researchRepository.runs.get(runId, request.projectId);
            if (run.taskId === null) throw new Error('research_task_execution_unlinked');
            await taskController.pause({ taskId: run.taskId, projectId: request.projectId });
            notifyResearchTaskChanged(context, run.taskId, request.projectId);
            return researchRepository.getWorkflow(request.projectId);
          }
        }
        const snapshot = await applyResearchWorkflowTransition({ request, gate: humanGate, runtime, exports: researchExports });
        if (['complete', 'approve', 'reject'].includes(request.action)) {
          for (const taskId of researchRepository.runs.taskIdsForStage(request.projectId, request.expectedStage)) {
            runtime.synchronizeTaskState(taskId, request.projectId);
            notifyResearchTaskChanged(context, taskId, request.projectId);
          }
        }
        return snapshot;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.stageRole, async (input) =>
        getResearchStageRoleProfile((input as ResearchStageRoleRequest).stage)
      );
      context.capabilities.register(pluginId, knowledgeCapabilities.listEmbedding, async () => await researchEmbeddings.listConfigs());
      context.capabilities.register(pluginId, knowledgeCapabilities.saveEmbedding, async (input) => {
        const config = await researchEmbeddings.saveConfig(input as ResearchEmbeddingConfigSaveRequest);
        researchIndexer.configurationChanged();
        return config;
      });
      context.capabilities.register(pluginId, knowledgeCapabilities.upsertDocument, async (input) => await researchEmbeddings.upsertDocument(input as ResearchKnowledgeDocumentUpsertRequest));
      context.capabilities.register(pluginId, knowledgeCapabilities.search, async (input) => await researchEmbeddings.search(input as ResearchKnowledgeSearchRequest));
      context.capabilities.register(pluginId, provenanceCapabilities.add, async (input) => repository!.addProvenance(input as ResearchProvenanceCreateRequest));
      context.capabilities.register(pluginId, provenanceCapabilities.list, async (input) => repository!.listProvenance(input as ResearchProvenanceListRequest));
      researchIndexer.start();
    },
    shutdown: async () => {
      try {
        await shutdownResearchPlugin({ literature: literatureService, scholarly, resources, openreview, huggingface, huggingfaceDownloads, zotero, literatureImports, productionInputs, exports, figures, experiments, pythonEnvironments, indexer, embeddings, stageRuntime, reviewSearch, templates, documents, library, prose });
      } finally {
        reviewSearch = null;
        resources = null;
        openreview = null;
        productionInputs = null;
        exports = null;
        figures = null;
        experiments = null;
        pythonEnvironments = null;
        indexer = null;
        embeddings = null;
        documents = null;
        library = null;
        prose = null;
        templates = null;
        stageRuntime = null;
        literatureImports = null;
        repository = null;
      }
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: capabilityVersion, inputSchema, outputSchema };
}
function loadResearchVectorExtension(db: Database): void {
  const loadablePath = sqliteVec.getLoadablePath().replace(/\.dylib\.dylib$/u, '.dylib');
  const asarMarker = `${sep}app.asar${sep}`;
  if (!loadablePath.includes(asarMarker)) {
    sqliteVec.load(db);
    return;
  }

  const unpackedPath = loadablePath.replace(asarMarker, `${sep}app.asar.unpacked${sep}`);
  db.loadExtension(existsSync(unpackedPath) ? unpackedPath : loadablePath);
}
