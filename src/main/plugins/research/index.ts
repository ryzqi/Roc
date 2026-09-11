import { z } from 'zod';
import * as sqliteVec from 'sqlite-vec';

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
  researchExperimentRunRecordRequestSchema,
  researchExperimentRunSchema,
  researchFigureRecordRequestSchema,
  researchFigureSchema,
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
  ResearchExperimentRunRecordRequest,
  ResearchFigureRecordRequest,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest,
  ResearchLiteratureSearchRequest
  ,ResearchStageRoleRequest
  ,ResearchProvenanceCreateRequest
  ,ResearchProvenanceListRequest
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
import { ResearchLibraryService } from './library-service';
import { registerResearchLibraryCapabilities, researchLibraryCapabilities } from './library-capabilities';
import { ResearchDocumentService } from './document-service';
import { registerResearchDocumentCapabilities, researchDocumentCapabilities } from './document-capabilities';
import { ResearchIndexService, type ResearchIndexWatch } from './index-service';
import { registerResearchIndexCapabilities, researchIndexCapabilities } from './index-capabilities';
import { registerResearchEvidenceCapabilities, researchEvidenceCapabilities } from './evidence-capabilities';
import { registerResearchRunCapabilities, researchRunCapabilities } from './run-capabilities';
import type { ResearchRoleExecutor } from './role-executor';
import { ResearchStageRuntime } from './stage-runtime';

const pluginId = '@roc/plugin-research';
const capabilityVersion = '1.0.0';
const emptyInputSchema = z.object({}).strict();

const researchCapabilityDescriptors = [
  descriptor('research.projects.list', researchProjectListRequestSchema, researchProjectSchema.array()),
  descriptor('research.projects.get', researchProjectIdRequestSchema, researchProjectSchema),
  descriptor('research.projects.create', researchProjectCreateRequestSchema, researchProjectSchema),
  descriptor('research.projects.update', researchProjectUpdateRequestSchema, researchProjectSchema),
  descriptor('research.workflow.get', researchProjectIdRequestSchema, researchWorkflowSnapshotSchema),
  descriptor('research.workflow.transition', researchWorkflowTransitionRequestSchema, researchWorkflowSnapshotSchema),
  descriptor('research.literature.search', researchLiteratureSearchRequestSchema, researchLiteratureSchema.array()),
  descriptor('research.embedding.list', emptyInputSchema, researchEmbeddingConfigSchema.array()),
  descriptor('research.embedding.save', researchEmbeddingConfigSaveRequestSchema, researchEmbeddingConfigSchema),
  descriptor('research.knowledge.upsert', researchKnowledgeDocumentUpsertRequestSchema, researchKnowledgeDocumentSchema),
  descriptor('research.knowledge.search', researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema),
  descriptor('research.experiment.record', researchExperimentRunRecordRequestSchema, researchExperimentRunSchema),
  descriptor('research.figure.record', researchFigureRecordRequestSchema, researchFigureSchema),
  descriptor('research.workflow.role', researchStageRoleRequestSchema, researchStageRoleProfileSchema),
  descriptor('research.provenance.add', researchProvenanceCreateRequestSchema, researchProvenanceSchema),
  descriptor('research.provenance.list', researchProvenanceListRequestSchema, researchProvenanceSchema.array()),
] as const satisfies readonly CapabilityDescriptor[];

const lifecycleCapabilities = {
  createArtifact: descriptor('research.artifacts.create', researchArtifactCreateRequestSchema, researchArtifactSchema),
  getArtifact: descriptor('research.artifacts.get', researchArtifactIdRequestSchema, researchArtifactSchema),
  listArtifacts: descriptor('research.artifacts.list', researchArtifactListRequestSchema, researchArtifactSchema.array()),
  updateArtifact: descriptor('research.artifacts.update', researchArtifactUpdateRequestSchema, researchArtifactSchema),
  events: descriptor('research.workflow.events', researchWorkflowEventsRequestSchema, researchWorkflowEventSchema.array())
};

export type ResearchPluginOptions = {
  indexRoot?: string;
  indexWatch?: ResearchIndexWatch;
  libraryRoot?: string;
  libraryFetch?: ConstructorParameters<typeof ResearchLibraryService>[3];
  toolchainRoot?: string;
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
  const toolchain = new ResearchToolchain(options.toolchainRoot ?? null);
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
      capabilities: [...researchCapabilityDescriptors, ...Object.values(lifecycleCapabilities), ...researchEvidenceCapabilities, ...researchRunCapabilities, ...researchProductionCapabilities, ...researchLibraryCapabilities, ...researchDocumentCapabilities, ...researchIndexCapabilities]
    },
    initialize: async (context: RocPluginContext) => {
      const db = context.database.getConnection();
      sqliteVec.load(db);
      repository = new ResearchRepository(db);
      const researchRepository = repository;
      const researchEmbeddings = new ResearchEmbeddingService(researchRepository, embeddingClient, context);
      embeddings = researchEmbeddings;
      const researchIndexer = new ResearchIndexService(researchRepository, toolchain, researchEmbeddings, options.indexRoot ?? null, context.logger, options.indexWatch);
      indexer = researchIndexer;
      registerResearchIndexCapabilities(context, researchRepository.indexing, researchIndexer);
      researchRepository.runs.recoverInterrupted();
      researchRepository.recoverTemplateCompiles();
      templates = new ResearchTemplateService(researchRepository, toolchain);
      registerResearchProductionCapabilities(context, templates, toolchain);
      library = new ResearchLibraryService(researchRepository.library, toolchain, options.libraryRoot ?? null, options.libraryFetch);
      registerResearchLibraryCapabilities(context, researchRepository.library, library);
      researchRepository.documents.recover();
      documents = new ResearchDocumentService(researchRepository, toolchain, options.libraryRoot ?? null);
      registerResearchDocumentCapabilities(context, researchRepository.documents, documents);
      const runtime = new ResearchStageRuntime(researchRepository, context.capabilities, options.roleExecutor);
      stageRuntime = runtime;
      registerResearchRunCapabilities(context, researchRepository.runs, runtime, researchRepository.reviews);
      registerResearchEvidenceCapabilities(context, researchRepository.evidence);
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
      context.capabilities.register(pluginId, researchCapabilityDescriptors[0], async () => repository!.listProjects());
      context.capabilities.register(pluginId, researchCapabilityDescriptors[1], async (input) => repository!.getProject((input as { id: string }).id));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[2], async (input) => {
        const project = researchRepository.createProject(researchProjectCreateRequestSchema.parse(input));
        researchIndexer.projectChanged(project.id);
        return project;
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[3], async (input) => {
        const project = researchRepository.updateProject(researchProjectUpdateRequestSchema.parse(input));
        researchIndexer.projectChanged(project.id);
        return project;
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[4], async (input) => repository!.getWorkflow((input as { id: string }).id));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[5], async (input) => runtime.transition(researchWorkflowTransitionRequestSchema.parse(input)));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[6], async (input) => {
        const request = input as ResearchLiteratureSearchRequest;
        const records = await literatureService.search(request);
        for (const record of records) {
          repository!.upsertLiterature(record);
          if (record.abstract !== null && record.abstract.trim().length > 0) {
            repository!.upsertKnowledgeDocument({
              id: `literature:${record.id}`,
              projectId: null,
              sourceType: 'literature',
              sourceId: record.id,
              title: record.title,
              content: record.abstract,
              chunks: [{ content: record.abstract, locator: 'abstract' }],
              embeddingConfigId: null
            });
          }
        }
        return records;
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[7], async () => researchEmbeddings.listConfigs());
      context.capabilities.register(pluginId, researchCapabilityDescriptors[8], async (input) => {
        const config = researchEmbeddings.saveConfig(input as ResearchEmbeddingConfigSaveRequest);
        researchIndexer.configurationChanged();
        return config;
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[9], async (input) => await researchEmbeddings.upsertDocument(input as ResearchKnowledgeDocumentUpsertRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[10], async (input) => await researchEmbeddings.search(input as ResearchKnowledgeSearchRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[11], async (input) => repository!.recordExperimentRun(input as ResearchExperimentRunRecordRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[12], async (input) => repository!.recordFigure(input as ResearchFigureRecordRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[13], async (input) =>
        getResearchStageRoleProfile((input as ResearchStageRoleRequest).stage)
      );
      context.capabilities.register(pluginId, researchCapabilityDescriptors[14], async (input) => repository!.addProvenance(input as ResearchProvenanceCreateRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[15], async (input) => repository!.listProvenance(input as ResearchProvenanceListRequest));
      researchIndexer.start();
    },
    shutdown: async () => {
      const results = await Promise.allSettled([indexer?.shutdown(), embeddings?.shutdown(), stageRuntime?.shutdown(), templates?.shutdown(), documents?.shutdown(), library?.shutdown()]);
      indexer = null;
      embeddings = null;
      documents = null;
      library = null;
      templates = null;
      stageRuntime = null;
      repository = null;
      const errors: unknown[] = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'research_shutdown_failed');
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
