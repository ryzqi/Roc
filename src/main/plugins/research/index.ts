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
  researchLiteratureSchema,
  researchLiteratureSearchRequestSchema,
  researchStageRoleProfileSchema,
  researchStageRoleRequestSchema,
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
  ResearchLiteratureSearchRequest,
  ResearchStageRoleRequest,
  ResearchProvenanceCreateRequest,
  ResearchProvenanceListRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { ResearchEmbeddingService } from './embedding-service';
import { LiteratureSearchService } from './literature-service';
import { ResearchRepository } from './repository';
import { getResearchStageRoleProfile } from './role-profiles';
import { ResearchTemplateService } from './template-service';
import { ResearchToolchain } from './toolchain';
import { registerResearchProductionCapabilities, researchProductionCapabilities } from './production-capabilities';
import { ResearchProseLintService } from './prose-lint-service';
import { registerResearchProseCapabilities, researchProseCapabilities } from './prose-lint-capabilities';
import { ResearchLibraryService } from './library-service';
import { registerResearchLibraryCapabilities, researchLibraryCapabilities } from './library-capabilities';
import { ResearchDocumentService } from './document-service';
import { registerResearchDocumentCapabilities, researchDocumentCapabilities } from './document-capabilities';
import { ResearchIndexService, type ResearchIndexWatch } from './index-service';
import { registerResearchIndexCapabilities, researchIndexCapabilities } from './index-capabilities';
import { ResearchExperimentEnvironmentService } from './experiment-environment';
import { ResearchExperimentService } from './experiment-service';
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
import { registerResearchEvidenceCapabilities, researchEvidenceCapabilities } from './evidence-capabilities';
import { registerResearchManuscriptCapabilities, researchManuscriptCapabilities } from './manuscript-capabilities';
import { registerResearchIdeaCapabilities, researchIdeaCapabilities } from './idea-capabilities';
import { registerResearchRunCapabilities, researchRunCapabilities } from './run-capabilities';
import type { ResearchRoleExecutor } from './role-executor';
import { ResearchStageRuntime } from './stage-runtime';
import { createResearchHumanGate } from './human-gate';
import { applyResearchWorkflowTransition, shutdownResearchPlugin } from './research-plugin-lifecycle';
import { createResearchProductionJob } from './research-production-job';

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
  stageRole: descriptor('research.workflow.role', researchStageRoleRequestSchema, researchStageRoleProfileSchema)
};
const literatureCapabilities = {
  search: descriptor('research.literature.search', researchLiteratureSearchRequestSchema, researchLiteratureSchema.array())
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
  ...Object.values(literatureCapabilities),
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
  embeddingFetch?: ConstructorParameters<typeof OpenAICompatibleEmbeddingClient>[0];
};

export function createResearchPlugin(options: ResearchPluginOptions = {}): RocPlugin {
  let repository: ResearchRepository | null = null;
  let stageRuntime: ResearchStageRuntime | null = null;
  let templates: ResearchTemplateService | null = null;
  let library: ResearchLibraryService | null = null;
  let documents: ResearchDocumentService | null = null;
  let embeddings: ResearchEmbeddingService | null = null;
  let indexer: ResearchIndexService | null = null;
  let experiments: ResearchExperimentService | null = null;
  let figures: ResearchFigureService | null = null;
  let exports: ResearchExportService | null = null;
  let productionInputs: ResearchProductionInputService | null = null;
  let prose: ResearchProseLintService | null = null;
  const toolchain = new ResearchToolchain(options.toolchainRoot ?? null, options.modelsRoot ?? null);
  const literatureService = new LiteratureSearchService(options.literatureFetch);
  const embeddingClient = new OpenAICompatibleEmbeddingClient(options.embeddingFetch);
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Research Workbench',
      description: '科研项目、阶段流程和 Provenance 基础能力。',
      loadPhase: 'critical',
      required: true,
      order: 55,
      dependencies: ['@roc/plugin-agent', '@roc/plugin-workspace'],
      capabilities: [...researchCapabilityDescriptors, ...Object.values(lifecycleCapabilities), ...researchEvidenceCapabilities, ...researchManuscriptCapabilities, ...researchIdeaCapabilities, ...researchRunCapabilities, ...researchProductionCapabilities, ...researchLibraryCapabilities, ...researchDocumentCapabilities, ...researchIndexCapabilities, ...researchExperimentCapabilities, ...researchFigureCapabilities, ...researchExportCapabilities, ...researchProductionInputCapabilities, ...researchProseCapabilities]
    },
    initialize: async (context: RocPluginContext) => {
      const db = context.database.getConnection();
      loadResearchVectorExtension(db);
      repository = new ResearchRepository(db);
      const researchRepository = repository;
      const researchEmbeddings = new ResearchEmbeddingService(researchRepository.knowledge, embeddingClient, context);
      embeddings = researchEmbeddings;
      researchRepository.setKnowledgeWriter((input, sourceMetadata = {}) => researchEmbeddings.upsertFromSource(input, sourceMetadata));
      const researchIndexer = new ResearchIndexService(researchRepository, toolchain, researchEmbeddings, options.indexRoot ?? null, context.logger, options.indexWatch);
      indexer = researchIndexer;
      registerResearchIndexCapabilities(context, researchRepository.indexing, researchIndexer);
      const researchExperiments = new ResearchExperimentService(researchRepository, new ResearchExperimentEnvironmentService(toolchain), options.experimentRoot ?? null, context.logger);
      experiments = researchExperiments;
      registerResearchExperimentCapabilities(context, researchRepository.experiments, researchExperiments);
      const researchFigures = new ResearchFigureService(researchRepository, researchExperiments, options.experimentRoot ?? null, context.logger);
      figures = researchFigures;
      registerResearchFigureCapabilities(context, researchRepository.figures, researchFigures);
      researchRepository.runs.recoverInterrupted();
      researchRepository.recoverTemplateCompiles();
      const researchTemplates = new ResearchTemplateService(researchRepository, toolchain);
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
      library = new ResearchLibraryService(researchRepository.library, toolchain, options.libraryRoot ?? null, options.libraryFetch);
      registerResearchLibraryCapabilities(context, researchRepository.library, library);
      researchRepository.documents.recover();
      documents = new ResearchDocumentService(researchRepository, toolchain, options.libraryRoot ?? null);
      registerResearchDocumentCapabilities(context, researchRepository.documents, documents);
      const effects = new ResearchProductionEffectService(researchRepository, new ResearchWorkspaceFileService(db, researchRepository, () => new Date().toISOString()),
        researchExperiments, researchFigures, researchTemplates, researchExports);
      const humanGate = createResearchHumanGate({ repository: researchRepository, production: productionJob });
      const runtime = new ResearchStageRuntime(researchRepository, context.capabilities, options.roleExecutor, humanGate, effects);
      stageRuntime = runtime;
      registerResearchRunCapabilities(context, researchRepository.runs, runtime, researchRepository.reviews);
      registerResearchEvidenceCapabilities(context, researchRepository.evidence);
      registerResearchManuscriptCapabilities(context, researchRepository.manuscripts);
      registerResearchIdeaCapabilities(context, researchRepository.ideas);
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
        return project;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.deleteProject, async (input) => {
        const request = researchProjectIdRequestSchema.parse(input);
        const result = researchRepository.deleteProject(request.id);
        researchIndexer.releaseProject(request.id);
        researchExperiments.releaseProject(request.id);
        researchFigures.releaseProject(request.id);
        researchExports.releaseProject(request.id);
        runtime.releaseProject(request.id);
        return result;
      });
      context.capabilities.register(pluginId, workbenchCapabilities.getWorkflow, async (input) => repository!.getWorkflow((input as { id: string }).id));
      context.capabilities.register(pluginId, workbenchCapabilities.transitionWorkflow, async (input) => applyResearchWorkflowTransition({
        request: researchWorkflowTransitionRequestSchema.parse(input),
        gate: humanGate,
        runtime,
        exports: researchExports
      }));
      context.capabilities.register(pluginId, workbenchCapabilities.stageRole, async (input) =>
        getResearchStageRoleProfile((input as ResearchStageRoleRequest).stage)
      );
      context.capabilities.register(pluginId, literatureCapabilities.search, async (input) => {
        return literatureService.searchAndStore(researchRepository, input as ResearchLiteratureSearchRequest);
      });
      context.capabilities.register(pluginId, knowledgeCapabilities.listEmbedding, async () => researchEmbeddings.listConfigs());
      context.capabilities.register(pluginId, knowledgeCapabilities.saveEmbedding, async (input) => {
        const config = researchEmbeddings.saveConfig(input as ResearchEmbeddingConfigSaveRequest);
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
        await shutdownResearchPlugin({ productionInputs, exports, figures, experiments, indexer, embeddings, stageRuntime, templates, documents, library, prose });
      } finally {
        productionInputs = null;
        exports = null;
        figures = null;
        experiments = null;
        indexer = null;
        embeddings = null;
        documents = null;
        library = null;
        prose = null;
        templates = null;
        stageRuntime = null;
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
