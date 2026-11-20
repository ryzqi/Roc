import {VisualIndexService} from './visual-index-service';
import {VisualIndexRepository} from './visual-index-repository';
import {PythonVisualRetrievalAdapter} from './visual-python-adapter';
import {registerResearchVisualCapabilities} from './visual-capabilities';
import {FigureUnderstandingService} from './figure-understanding-service';
import {createFigureUnderstandingSessionFactory} from './figure-understanding-model';
import {registerFigureUnderstandingCapability} from './figure-understanding-capabilities';
import { ResearchRerankerService } from './reranker-service';
import { rerankerSaveSchema } from '../../../shared/schemas/research-reranker';
import { ResearchStorageUsageService, registerResearchStorageCapability } from './storage-usage';
import { ZenodoPublicationService } from './zenodo-publication';
import { ZenodoOperationRepository } from './zenodo-operation-repository';
import { ZenodoTransport } from './zenodo-transport';
import { registerResearchZenodoPublicationCapabilities } from './zenodo-publication-capabilities';
import { ZenodoPreparationService } from './zenodo-preparation';
import { registerResearchZenodoCapabilities } from './zenodo-capabilities';
import { loadResearchVectorExtension } from './research-vector-extension';
import { ResearchReadonlySearchService } from './readonly-search-service';
import type { RocPluginContext } from '../../kernel/types';
import type { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { ResearchEmbeddingService } from './embedding-service';
import {ScientificLibraryIndexService} from './scientific-library-index';
import {ScientificRetrievalRouter} from './scientific-retrieval-router';
import {ScientificShadowRetrieval} from './scientific-shadow-retrieval';
import {ScientificGenerationService} from './scientific-generation-service';
import {ScientificExtractionService} from './scientific-extraction-service';
import {createScientificExtractionSessionFactory} from './scientific-extraction-model';
import {createScientificQueryGenerator} from './scientific-query-planner';
import {ScholarlyRelationsRepository} from './scholarly-relations-repository';
import { ResearchRepository } from './repository';
import {ResearchProcessingObserver} from './processing-trace';
import { ResearchTemplateService } from './template-service';
import type { ResearchToolchain } from './toolchain';
import { registerResearchProductionCapabilities } from './production-capabilities';
import { ResearchFigureConsistencyService } from './figure-consistency-service';
import { registerResearchFigureConsistencyCapabilities } from './figure-consistency-capabilities';
import { ResearchIndexService } from './index-service';
import {createPaperSemanticGenerator} from './paper-semantic-service';
import { registerResearchIndexCapabilities } from './index-capabilities';
import { ResearchExperimentEnvironmentService } from './experiment-environment';
import { ResearchPythonEnvironmentService } from './python-environment-service';
import { registerResearchPythonEnvironmentCapabilities } from './python-environment-capabilities';
import { registerResearchNotebookCapabilities } from './notebook-capabilities';
import { ResearchExperimentService } from './experiment-service';
import { ResearchExperimentResultService } from './experiment-result-service';
import { ResearchIdeaOutcomeService } from './idea-outcome-service';
import { registerResearchIdeaOutcomeCapabilities } from './idea-outcome-capabilities';
import { registerResearchExperimentResultCapabilities } from './experiment-result-capabilities';
import { registerResearchExperimentCapabilities } from './experiment-capabilities';
import { ResearchFigureService } from './figure-service';
import { registerResearchFigureCapabilities } from './figure-capabilities';
import { registerResearchExportCapabilities } from './export-capabilities';
import { ResearchExportService } from './export-service';
import { ResearchExportSourceService } from './export-sources';
import { ResearchProductionInputService } from './production-input-service';
import { registerResearchProductionInputCapabilities } from './production-input-capabilities';
import { workspacePathStructureChangedEventType, type WorkspacePathStructureChangeNotifier } from '../../services/workspace-path-structure-event';
import { createResearchProductionJob } from './research-production-job';
import { pluginId, knowledgeCapabilities } from './research-plugin-contract';
import type { ResearchPluginOptions } from './research-plugin-options';
import type { ResearchPluginLifecycle } from './research-plugin-lifecycle';

export type ResearchProductionServices = {
  db: ReturnType<RocPluginContext['database']['getConnection']>;
  toolchain: ResearchToolchain;
  researchRepository: ResearchRepository;
  researchEmbeddings: ResearchEmbeddingService;
  scientificLibraryIndex: ScientificLibraryIndexService;
  scientificRetrieval: ScientificRetrievalRouter;
  shadowRetrieval: ScientificShadowRetrieval;
  scientificGenerations: ScientificGenerationService;
  scientificExtraction: ScientificExtractionService;
  visual: VisualIndexService;
  figureUnderstanding: FigureUnderstandingService;
  researchIndexer: ResearchIndexService;
  researchPythonEnvironments: ResearchPythonEnvironmentService;
  researchExperiments: ResearchExperimentService;
  researchResults: ResearchExperimentResultService;
  researchFigures: ResearchFigureService;
  researchTemplates: ResearchTemplateService;
  researchExports: ResearchExportService;
  zenodoPublication: ZenodoPublicationService;
  productionJob: ReturnType<typeof createResearchProductionJob>;
  notifyWorkspacePathStructureChanged: WorkspacePathStructureChangeNotifier;
};

export function registerResearchProduction(
  context: RocPluginContext,
  options: ResearchPluginOptions,
  lifecycle: ResearchPluginLifecycle,
  toolchain: ResearchToolchain,
  embeddingClient: OpenAICompatibleEmbeddingClient
): ResearchProductionServices {
  // 模型选择存在 `plugin_config` 里：存储构造时还没有 context，必须在这里接上，
  // 否则用户选的解析配置每次重启都会丢。
  toolchain.attachModelConfig(context.config);
  const db = context.database.getConnection();
  loadResearchVectorExtension(db);
  const researchRepository = new ResearchRepository(db, options.tasks, undefined, new ResearchProcessingObserver(context.logger));
  registerResearchStorageCapability(context, new ResearchStorageUsageService(db, researchRepository, {
    library: options.libraryRoot ?? null, index: options.indexRoot ?? null, experiment: options.experimentRoot ?? null,
    export: options.exportRoot ?? null, model: options.modelsRoot ?? null, resource: options.resourceRoot
  }));
  const reranker = new ResearchRerankerService(context);
  context.capabilities.register(pluginId, knowledgeCapabilities.readReranker, () => reranker.readConfig());
  context.capabilities.register(pluginId, knowledgeCapabilities.saveReranker, input => reranker.saveConfig(rerankerSaveSchema.parse(input)));
  const readonlyQueries = new ResearchReadonlySearchService(db, researchRepository.knowledge, {
    workerUrl: new URL('./research-query-worker.js', import.meta.url),
    onEvent: event => {
      if (event.type === 'spawn' || event.type === 'cancel' || event.type === 'exit') {
        context.logger.info('Research readonly query Worker lifecycle.', { ...event });
      }
    }
  });
  const researchEmbeddings = new ResearchEmbeddingService(researchRepository.knowledge, embeddingClient, context, reranker, readonlyQueries);
  lifecycle.own('embeddings', researchEmbeddings);
  researchRepository.wiki.configureSearch(researchEmbeddings);
  const scientificLibraryIndex = new ScientificLibraryIndexService(researchRepository, researchEmbeddings, options.libraryRoot ?? null);
  const scientificRetrieval = new ScientificRetrievalRouter(researchRepository, researchEmbeddings,
    {library: options.libraryRoot ?? null, index: options.indexRoot ?? null},
    new ScholarlyRelationsRepository(db, researchRepository), createScientificQueryGenerator(options.modelFactory), reranker);
  const shadowRetrieval = new ScientificShadowRetrieval(researchEmbeddings, scientificRetrieval,
    () => context.config.get<unknown>('research.shadowRetrieval'),
    event => context.logger.info('research_shadow_retrieval', event));
  const scientificGenerations = new ScientificGenerationService(researchRepository, researchEmbeddings, scientificRetrieval.snapshots);
  const scientificExtraction = new ScientificExtractionService(researchRepository,
    {library: options.libraryRoot ?? null, index: options.indexRoot ?? null},
    createScientificExtractionSessionFactory(options.modelFactory), () => options.modelFactory.defaultChatModelStamp(),
    {logger: context.logger});
  researchRepository.paperCards.configureKnowledge((request, signal) => scientificExtraction.readPaperCard(request, signal));
  researchRepository.wiki.configureKnowledge({
    state: (projectId, documentId) => scientificExtraction.wikiKnowledgeState(projectId, documentId),
    read: (projectId, source, signal) => scientificExtraction.readPaperCard({...source, projectId}, signal)
  });
  lifecycle.ownBackgroundServices([shadowRetrieval, scientificExtraction, researchRepository.paperCards,
    researchRepository.wiki, researchRepository.knowledgeJobs]);
  scientificExtraction.start();
  researchRepository.knowledgeJobs.start((id, signal, requireCurrent) => id.startsWith('document:')
    ? scientificLibraryIndex.rebuild(id, signal, requireCurrent) : researchEmbeddings.embedDocument(id, null, signal));
  const researchIndexer = new ResearchIndexService(researchRepository, toolchain, researchEmbeddings, options.indexRoot ?? null,
    context.logger, options.indexWatch, undefined, createPaperSemanticGenerator(options.modelFactory), options.scholarlyParser);
  lifecycle.own('indexer', researchIndexer);
  registerResearchIndexCapabilities(context, researchRepository.indexing, researchIndexer);
  const researchPythonEnvironments = new ResearchPythonEnvironmentService(researchRepository);
  lifecycle.own('pythonEnvironments', researchPythonEnvironments);
  registerResearchPythonEnvironmentCapabilities(context, researchRepository.pythonEnvironments, researchPythonEnvironments);
  const visual = new VisualIndexService(researchRepository,
    {library: options.libraryRoot ?? null, index: options.indexRoot ?? null},
    new VisualIndexRepository(options.indexRoot ?? null), new PythonVisualRetrievalAdapter(researchPythonEnvironments), context.config);
  lifecycle.ownBackgroundServices([shadowRetrieval, scientificExtraction, researchRepository.paperCards,
    researchRepository.wiki, researchRepository.knowledgeJobs, visual]);
  registerResearchVisualCapabilities(context, visual);
  const figureUnderstanding = new FigureUnderstandingService(researchRepository,
    {library: options.libraryRoot ?? null, index: options.indexRoot ?? null},
    createFigureUnderstandingSessionFactory(options.modelFactory), () => options.modelFactory.defaultChatModelStamp());
  lifecycle.ownBackgroundServices([scientificExtraction, researchRepository.paperCards,
    researchRepository.wiki, researchRepository.knowledgeJobs, visual, figureUnderstanding]);
  registerFigureUnderstandingCapability(context, figureUnderstanding);
  registerResearchNotebookCapabilities(context, researchRepository.notebooks);
  const researchExperiments = new ResearchExperimentService(researchRepository, new ResearchExperimentEnvironmentService(toolchain, researchPythonEnvironments), options.experimentRoot ?? null, context.logger);
  lifecycle.own('experiments', researchExperiments);
  registerResearchExperimentCapabilities(context, researchRepository.experiments, researchExperiments);
  const researchResults = new ResearchExperimentResultService(researchRepository, researchExperiments);
  registerResearchExperimentResultCapabilities(context, researchRepository.experimentResults, researchResults);
  registerResearchIdeaOutcomeCapabilities(context, researchRepository.ideaOutcomes,
    new ResearchIdeaOutcomeService(researchRepository, researchResults));
  const researchFigures = new ResearchFigureService(researchRepository, toolchain, options.experimentRoot ?? null, context.logger);
  lifecycle.own('figures', researchFigures);
  registerResearchFigureCapabilities(context, researchRepository.figures, researchFigures);
  registerResearchFigureConsistencyCapabilities(context,
    new ResearchFigureConsistencyService(researchRepository, researchFigures, researchResults), researchRepository.figureConsistency);
  researchRepository.runs.reconcileTaskLinks();
  researchRepository.runs.flushTaskEvents();
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
  lifecycle.own('templates', researchTemplates);
  registerResearchProductionCapabilities(context, researchTemplates, toolchain);
  const researchExports = new ResearchExportService(researchRepository,
    new ResearchExportSourceService(researchRepository, researchFigures, researchExperiments, researchTemplates), toolchain, options.exportRoot ?? null, context.logger);
  lifecycle.own('exports', researchExports);
  registerResearchExportCapabilities(context, researchRepository.exports, researchExports);
  const zenodoPreparations = new ZenodoPreparationService(db, researchRepository, researchExports);
  registerResearchZenodoCapabilities(context, zenodoPreparations);
  const zenodoOperations = new ZenodoOperationRepository(db, researchRepository, zenodoPreparations);
  const zenodoPublication = new ZenodoPublicationService(researchRepository, zenodoPreparations, zenodoOperations,
    new ZenodoTransport(context.secrets), context.secrets, researchExports.uploadPublicationFile.bind(researchExports));
  lifecycle.own('zenodo', zenodoPublication);
  zenodoPublication.recover();
  registerResearchZenodoPublicationCapabilities(context, zenodoPublication, zenodoOperations);
  const productionJob = createResearchProductionJob({
    repository: researchRepository,
    experiments: researchExperiments,
    figures: researchFigures,
    exports: researchExports
  });
  productionJob.recover();
  const productionInputs = new ResearchProductionInputService(researchRepository, researchExperiments, researchFigures, researchExports);
  lifecycle.own('productionInputs', productionInputs);
  registerResearchProductionInputCapabilities(context, productionInputs);
  return { db, toolchain, visual, figureUnderstanding, researchRepository, researchEmbeddings, scientificLibraryIndex, scientificRetrieval, shadowRetrieval, scientificGenerations, scientificExtraction, researchIndexer, researchPythonEnvironments,
    researchExperiments, researchResults, researchFigures, researchTemplates, researchExports, zenodoPublication,
    productionJob, notifyWorkspacePathStructureChanged };
}
