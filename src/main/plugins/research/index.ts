import { randomUUID } from 'node:crypto';
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
  researchTemplateCompileRequestSchema,
  researchTemplateImportRequestSchema,
  researchTemplateSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowEventSchema,
  researchWorkflowEventsRequestSchema,
  researchWorkflowTransitionRequestSchema
} from '../../../shared/schemas/research';
import type {
  ResearchEmbeddingConfig,
  ResearchEmbeddingConfigSaveRequest,
  ResearchExperimentRunRecordRequest,
  ResearchFigureRecordRequest,
  ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest,
  ResearchLiteratureSearchRequest
  ,ResearchStageRoleRequest
  ,ResearchProvenanceCreateRequest
  ,ResearchProvenanceListRequest
  ,ResearchTemplateImportRequest
  ,ResearchTemplateCompileRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { vectorToBlob } from './embedding-client';
import { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { LiteratureSearchService } from './literature-service';
import { ResearchRepository, type EmbeddingConfigRow } from './repository';
import { getResearchStageRoleProfile } from './role-profiles';
import { compileImportedLatexTemplate, importLatexTemplate } from './template-service';

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
  descriptor('research.template.import', researchTemplateImportRequestSchema, researchTemplateSchema),
  descriptor('research.template.compile', researchTemplateCompileRequestSchema, researchTemplateSchema)
] as const satisfies readonly CapabilityDescriptor[];

const lifecycleCapabilities = {
  createArtifact: descriptor('research.artifacts.create', researchArtifactCreateRequestSchema, researchArtifactSchema),
  getArtifact: descriptor('research.artifacts.get', researchArtifactIdRequestSchema, researchArtifactSchema),
  listArtifacts: descriptor('research.artifacts.list', researchArtifactListRequestSchema, researchArtifactSchema.array()),
  updateArtifact: descriptor('research.artifacts.update', researchArtifactUpdateRequestSchema, researchArtifactSchema),
  events: descriptor('research.workflow.events', researchWorkflowEventsRequestSchema, researchWorkflowEventSchema.array())
};

export type ResearchPluginOptions = {
  literatureFetch?: ConstructorParameters<typeof LiteratureSearchService>[0];
  embeddingFetch?: ConstructorParameters<typeof OpenAICompatibleEmbeddingClient>[0];
};

export function createResearchPlugin(options: ResearchPluginOptions = {}): RocPlugin {
  let repository: ResearchRepository | null = null;
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
      capabilities: [...researchCapabilityDescriptors, ...Object.values(lifecycleCapabilities)]
    },
    initialize: async (context: RocPluginContext) => {
      const db = context.database.getConnection();
      sqliteVec.load(db);
      repository = new ResearchRepository(db);
      const researchRepository = repository;
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
      context.capabilities.register(pluginId, researchCapabilityDescriptors[2], async (input) => repository!.createProject(input as never));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[3], async (input) => repository!.updateProject(input as never));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[4], async (input) => repository!.getWorkflow((input as { id: string }).id));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[5], async (input) => repository!.transitionWorkflow(input as never));
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
      context.capabilities.register(pluginId, researchCapabilityDescriptors[7], async () => listEmbeddingConfigs(context, repository!));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[8], async (input) => saveEmbeddingConfig(context, repository!, input as ResearchEmbeddingConfigSaveRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[9], async (input) => {
        const request = input as ResearchKnowledgeDocumentUpsertRequest;
        repository!.upsertKnowledgeDocument(request);
        await embedDocument(context, repository!, embeddingClient, request);
        return {
          id: request.id,
          projectId: request.projectId,
          sourceType: request.sourceType,
          sourceId: request.sourceId,
          title: request.title,
          content: request.content,
          indexedAt: new Date().toISOString()
        };
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[10], async (input) => searchKnowledge(context, repository!, embeddingClient, input as ResearchKnowledgeSearchRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[11], async (input) => repository!.recordExperimentRun(input as ResearchExperimentRunRecordRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[12], async (input) => repository!.recordFigure(input as ResearchFigureRecordRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[13], async (input) =>
        getResearchStageRoleProfile((input as ResearchStageRoleRequest).stage)
      );
      context.capabilities.register(pluginId, researchCapabilityDescriptors[14], async (input) => repository!.addProvenance(input as ResearchProvenanceCreateRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[15], async (input) => repository!.listProvenance(input as ResearchProvenanceListRequest));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[16], async (input) => {
        const request = input as ResearchTemplateImportRequest;
        const project = repository!.getProject(request.projectId);
        if (project.workspacePath === null) throw new Error('research_project_workspace_required');
        const templateId = `template_${randomUUID()}`;
        const imported = importLatexTemplate({ sourcePath: request.sourcePath, destinationRoot: `${project.workspacePath}/.roc-research/templates/${templateId}` });
        return repository!.createTemplate({ id: templateId, projectId: request.projectId, rootPath: imported.rootPath, entryPath: imported.entryPath });
      });
      context.capabilities.register(pluginId, researchCapabilityDescriptors[17], async (input) => {
        const request = input as ResearchTemplateCompileRequest;
        const template = repository!.getTemplate(request);
        repository!.updateTemplateCompile({ projectId: request.projectId, templateId: request.templateId, status: 'compiling', pdfPath: template.pdfPath, errors: [], lastCompiledAt: template.lastCompiledAt });
        const compiled = await compileImportedLatexTemplate({ rootPath: template.rootPath, entryPath: template.entryPath });
        return repository!.updateTemplateCompile({ projectId: request.projectId, templateId: request.templateId, status: compiled.status, pdfPath: compiled.pdfPath, errors: compiled.errors, lastCompiledAt: new Date().toISOString() });
      });
    },
    shutdown: async () => {
      repository = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function listEmbeddingConfigs(context: RocPluginContext, repository: ResearchRepository): ResearchEmbeddingConfig[] {
  return repository.listEmbeddingConfigRows().map((row) => toEmbeddingConfig(row, context));
}

function saveEmbeddingConfig(
  context: RocPluginContext,
  repository: ResearchRepository,
  request: ResearchEmbeddingConfigSaveRequest
): ResearchEmbeddingConfig {
  const secretKey = `research.embedding.${request.id}`;
  context.secrets.set(secretKey, request.apiKey);
  repository.saveEmbeddingConfig(request, secretKey);
  const row = repository.listEmbeddingConfigRows().find((item) => item.id === request.id);
  if (row === undefined) throw new Error('research_embedding_config_missing_after_save');
  return toEmbeddingConfig(row, context);
}

async function embedDocument(
  context: RocPluginContext,
  repository: ResearchRepository,
  client: OpenAICompatibleEmbeddingClient,
  request: ResearchKnowledgeDocumentUpsertRequest
): Promise<void> {
  const row = selectEmbeddingRow(repository, request.embeddingConfigId);
  if (row === null || row.enabled !== 1) return;
  const apiKey = context.secrets.get(row.api_key_secret_key);
  if (apiKey === null) return;
  const config = toEmbeddingConfig(row, context);
  const vectors = await client.embed({ config, apiKey, texts: request.chunks.map((chunk) => chunk.content) });
  repository.storeChunkEmbeddings({
    model: row.model,
    dimensions: row.dimensions,
    chunkIds: request.chunks.map((_, index) => `${request.id}:chunk:${index}`),
    vectors: vectors.map(vectorToBlob)
  });
}

async function searchKnowledge(
  context: RocPluginContext,
  repository: ResearchRepository,
  client: OpenAICompatibleEmbeddingClient,
  request: ResearchKnowledgeSearchRequest
): Promise<ReturnType<ResearchRepository['searchKnowledge']>> {
  const row = selectEmbeddingRow(repository, request.embeddingConfigId);
  if (row === null || row.enabled !== 1) {
    return repository.searchKnowledge({ request, vector: null });
  }
  const apiKey = context.secrets.get(row.api_key_secret_key);
  if (apiKey === null) return repository.searchKnowledge({ request, vector: null });
  const config = toEmbeddingConfig(row, context);
  const [vector] = await client.embed({ config, apiKey, texts: [request.query] });
  return repository.searchKnowledge({
    request,
    vector: { model: row.model, dimensions: row.dimensions, blob: vectorToBlob(vector) }
  });
}

function selectEmbeddingRow(repository: ResearchRepository, id: string | null): EmbeddingConfigRow | null {
  const rows = repository.listEmbeddingConfigRows();
  return (id === null ? rows.find((row) => row.enabled === 1) : rows.find((row) => row.id === id)) ?? null;
}

function toEmbeddingConfig(row: EmbeddingConfigRow, context: RocPluginContext): ResearchEmbeddingConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    dimensions: row.dimensions,
    keyConfigured: context.secrets.get(row.api_key_secret_key) !== null,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at
  };
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: capabilityVersion, inputSchema, outputSchema };
}
