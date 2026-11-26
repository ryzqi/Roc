import {paperDeepKnowledgeRequestSchema} from '../../../shared/schemas/research-paper-deep-knowledge';
import { knowledgeContextRequestSchema } from '../../../shared/schemas/research-knowledge-context';
import {scientificSearchRequestSchema} from '../../../shared/schemas/research-scientific-search';
import {scientificGenerationsRequestSchema, scientificGenerationActivateSchema} from '../../../shared/schemas/research-scientific-generations';
import {scientificContextRequestSchema} from '../../../shared/schemas/research-scientific-context';
import {scientificEvidenceRequestSchema} from '../../../shared/schemas/research-scientific-evidence';
import {scientificKnowledgeReadRequestSchema, scientificExtractionDocumentRequestSchema,
  scientificExtractionJobsRequestSchema, scientificExtractionJobRequestSchema} from '../../../shared/schemas/research-scientific-extraction';
import { knowledgeJobsListSchema, knowledgeJobRetrySchema } from '../../../shared/schemas/research-knowledge-jobs';
import { getCapabilityAbortSignal } from '../../kernel/capability-cancellation';
import type { ResearchEmbeddingConfigSaveRequest, ResearchKnowledgeDocumentUpsertRequest, ResearchKnowledgeSearchRequest, ResearchProvenanceCreateRequest, ResearchProvenanceListRequest } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { pluginId, knowledgeCapabilities, provenanceCapabilities } from './research-plugin-contract';
import type { ResearchProductionServices } from './research-plugin-production';

export function registerResearchKnowledge(
  context: RocPluginContext, production: ResearchProductionServices
): void {
  const { researchRepository, researchEmbeddings, researchIndexer } = production;
  context.capabilities.register(pluginId, knowledgeCapabilities.jobs, async input => {
    const request=knowledgeJobsListSchema.parse(input);
    return researchRepository.knowledgeJobs.list(request.projectId, request.offset);
  });
  context.capabilities.register(pluginId, knowledgeCapabilities.retry, async input => {
    const request=knowledgeJobRetrySchema.parse(input);
    researchRepository.knowledgeJobs.retry(request.documentId, request.generation);
    return {queued:true as const};
  });
  context.capabilities.register(pluginId, knowledgeCapabilities.listEmbedding, async () => await researchEmbeddings.listConfigs());
  context.capabilities.register(pluginId, knowledgeCapabilities.saveEmbedding, async (input) => {
    const config = await researchEmbeddings.saveConfig(input as ResearchEmbeddingConfigSaveRequest);
    researchIndexer.configurationChanged();
    researchRepository.knowledgeJobs.configurationChanged();
    return config;
  });
  context.capabilities.register(pluginId, knowledgeCapabilities.upsertDocument, async (input) => await researchEmbeddings.upsertDocument(input as ResearchKnowledgeDocumentUpsertRequest));
  context.capabilities.register(pluginId, knowledgeCapabilities.search, async (input) =>
    await production.shadowRetrieval.search(input as ResearchKnowledgeSearchRequest, getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificQuery, async input =>
    production.scientificQuery.search(scientificSearchRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificSearch, async input =>
    await production.scientificRetrieval.search(scientificSearchRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificGenerations, async input =>
    production.scientificGenerations.list(scientificGenerationsRequestSchema.parse(input)));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificActivate, async input =>
    await production.scientificGenerations.activate(scientificGenerationActivateSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificContext, async input =>
    await production.scientificRetrieval.readContext(scientificContextRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificEvidence, async input =>
    await production.scientificRetrieval.validateEvidence(scientificEvidenceRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.scientificRead, async input =>
    await production.scientificExtraction.read(scientificKnowledgeReadRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.deepRequest, input =>
    production.scientificExtraction.requestDeep(paperDeepKnowledgeRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.deepRead, input =>
    production.scientificExtraction.readDeep(scientificKnowledgeReadRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.extractionEnqueue, async input =>
    await production.scientificExtraction.enqueue(scientificExtractionDocumentRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.extractionJobs, async input => {
    const request = scientificExtractionJobsRequestSchema.parse(input);
    return researchRepository.scientificExtraction.list(request.projectId, request.documentId, request.offset);
  });
  context.capabilities.register(pluginId, knowledgeCapabilities.extractionRetry, async input =>
    await production.scientificExtraction.retry(scientificExtractionJobRequestSchema.parse(input), getCapabilityAbortSignal()));
  context.capabilities.register(pluginId, knowledgeCapabilities.extractionCancel, async input =>
    production.scientificExtraction.cancel(scientificExtractionJobRequestSchema.parse(input)));
  context.capabilities.register(pluginId, knowledgeCapabilities.context, async input => researchRepository.knowledge.readContext(knowledgeContextRequestSchema.parse(input)));
  context.capabilities.register(pluginId, provenanceCapabilities.add, async (input) => researchRepository.addProvenance(input as ResearchProvenanceCreateRequest));
  context.capabilities.register(pluginId, provenanceCapabilities.list, async (input) => researchRepository.listProvenance(input as ResearchProvenanceListRequest));
}
