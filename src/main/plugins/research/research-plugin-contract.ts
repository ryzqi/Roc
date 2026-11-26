import {paperDeepKnowledgeRequestSchema} from '../../../shared/schemas/research-paper-deep-knowledge';
import {paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema} from '../../../shared/schemas/research-paper-card-knowledge';
import {scientificQueryRequestSchema, scientificQueryResultSchema} from '../../../shared/schemas/research-scientific-query';
import {researchVisualCapabilities} from './visual-capabilities';
import {figureUnderstandingCapability} from './figure-understanding-capabilities';
import { researchWikiCapabilities } from './wiki-capabilities';
import { rerankerConfigSchema, rerankerSaveSchema } from '../../../shared/schemas/research-reranker';
import { knowledgeContextRequestSchema, knowledgeContextResultSchema } from '../../../shared/schemas/research-knowledge-context';
import {scientificSearchRequestSchema, scientificSearchResultSchema} from '../../../shared/schemas/research-scientific-search';
import {scientificGenerationsRequestSchema, scientificGenerationActivateSchema,
  scientificGenerationsResultSchema} from '../../../shared/schemas/research-scientific-generations';
import {scientificContextRequestSchema, scientificContextResultSchema} from '../../../shared/schemas/research-scientific-context';
import {scientificEvidenceRequestSchema, scientificEvidenceResultSchema} from '../../../shared/schemas/research-scientific-evidence';
import {scientificKnowledgeReadRequestSchema, scientificKnowledgeReadSchema, scientificExtractionDocumentRequestSchema,
  scientificExtractionJobsRequestSchema, scientificExtractionJobRequestSchema,
  scientificExtractionJobSchema} from '../../../shared/schemas/research-scientific-extraction';
import { knowledgeJobSchema, knowledgeJobsListSchema, knowledgeJobRetrySchema } from '../../../shared/schemas/research-knowledge-jobs';
import { researchDiagramCapability } from './diagram-capabilities';
import { researchReadingCapabilities } from './reading-capabilities';
import { taskFactCapabilities } from './task-fact-capabilities';
import { researchStorageCapability } from './storage-usage';
import { researchZenodoPublicationCapabilities } from './zenodo-publication-capabilities';
import { researchZenodoCapabilities } from './zenodo-capabilities';
import { researchMonitorCapabilities } from './monitor-capabilities';
import { researchTaskCapabilities } from './task-capabilities';
import { literatureImportCapabilities } from './literature-import-capabilities';
import {literatureAcquisitionCapabilities} from './literature-acquisition-capabilities';
import { z } from 'zod';
import { researchArtifactCreateRequestSchema, researchArtifactIdRequestSchema, researchArtifactListRequestSchema, researchArtifactSchema, researchArtifactUpdateRequestSchema, researchProjectCreateRequestSchema, researchProjectIdRequestSchema, researchProjectListRequestSchema, researchProjectSchema, researchProjectUpdateRequestSchema, researchEmbeddingConfigSaveRequestSchema, researchEmbeddingConfigSchema, researchKnowledgeDocumentSchema, researchKnowledgeDocumentUpsertRequestSchema, researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema, researchStageRoleProfileSchema, researchStageRoleRequestSchema, researchStageSchema, researchProvenanceCreateRequestSchema, researchProvenanceSchema, researchProvenanceListRequestSchema, researchWorkflowSnapshotSchema, researchWorkflowEventSchema, researchWorkflowEventsRequestSchema, researchWorkflowTransitionRequestSchema } from '../../../shared/schemas/research';
import type { CapabilityDescriptor } from '../../kernel/types';
import { zoteroCapabilities } from './zotero-capabilities';
import { researchProductionCapabilities } from './production-capabilities';
import { researchProseCapabilities } from './prose-lint-capabilities';
import { researchCitationCoverageCapability } from './citation-coverage-capability';
import { researchCitationReviewCapabilities } from './citation-review-capabilities';
import { researchConsistencyCapabilities } from './consistency-capabilities';
import { researchJournalComplianceCapabilities } from './journal-compliance-capabilities';
import { researchResponseMatrixCapabilities } from './response-matrix-capabilities';
import { researchFigureConsistencyCapabilities } from './figure-consistency-capabilities';
import { researchLibraryCapabilities } from './library-capabilities';
import { referenceCheckCapability } from './reference-check-capabilities';
import { researchScholarlyCapabilities } from './scholarly-relations-capabilities';
import { researchOpenReviewCapabilities } from './openreview-capabilities';
import { researchHuggingFaceCapabilities } from './huggingface-capabilities';
import { researchHuggingFaceDownloadCapabilities } from './huggingface-download-capabilities';
import { researchResourceCapabilities } from './resource-capabilities';
import { researchResourceAssociationCapabilities } from './resource-association-capabilities';
import { researchDocumentCapabilities } from './document-capabilities';
import { researchSystematicReviewCapabilities } from './systematic-review-capabilities';
import { researchReviewSearchCapabilities, researchOwnedReviewSearchCapabilities } from './review-search-capabilities';
import { researchReviewCorpusCapabilities } from './review-corpus-capabilities';
import { researchReviewDeduplicationCapabilities } from './review-deduplication-capabilities';
import { researchReviewFullTextCapabilities } from './review-fulltext-capabilities';
import { researchReviewExtractionCapabilities } from './review-extraction-capabilities';
import { researchReviewStudiesCapabilities } from './review-studies-capabilities';
import { researchReviewReportCapability } from './review-report-capability';
import { researchReviewQualityCapabilities } from './review-quality-capabilities';
import { researchReviewFullTextScreeningCapabilities } from './review-fulltext-screening-capabilities';
import { researchReviewScreeningCapabilities } from './review-screening-capabilities';
import { researchIndexCapabilities } from './index-capabilities';
import { researchPythonEnvironmentCapabilities } from './python-environment-capabilities';
import { researchNotebookCapabilities } from './notebook-capabilities';
import { researchIdeaOutcomeCapabilities } from './idea-outcome-capabilities';
import { researchExperimentResultCapabilities } from './experiment-result-capabilities';
import { researchExperimentCapabilities } from './experiment-capabilities';
import { researchFigureCapabilities } from './figure-capabilities';
import { researchExportCapabilities } from './export-capabilities';
import { researchProductionInputCapabilities } from './production-input-capabilities';
import { researchEvidenceCapabilities } from './evidence-capabilities';
import { researchManuscriptCapabilities } from './manuscript-capabilities';
import { researchIdeaCapabilities } from './idea-capabilities';
import { researchIdeaPlanCapabilities } from './idea-plan-capabilities';
import {researchProposalCapabilities} from './proposal-capabilities';
import {researchManuscriptSyncCapabilities} from './manuscript-sync-capabilities';
import {researchResultDerivationCapabilities} from './result-derivation-capabilities';
import {researchImpactCapabilities} from './impact-capabilities';
import {researchArgumentOutlineCapabilities} from './argument-outline-capabilities';
import {researchReviewPilotCapability} from './review-pilot-capability';
import {researchSubmissionProfileCapabilities} from './submission-profile-capabilities';
import {researchSubmissionCapabilities} from './submission-capabilities';
import {researchFeedbackCapabilities} from './feedback-capabilities';
import {researchExternalExperimentCapabilities} from './external-experiment-capabilities';
import { researchRunCapabilities } from './run-capabilities';
import { researchArtifactInspectorCapability, researchGateReviewCapability } from './artifact-inspector-capability';
import type { RocPluginManifest } from '../../kernel/types';
export const pluginId = '@roc/plugin-research';
const capabilityVersion = '1.0.0';
const emptyInputSchema = z.object({}).strict();

export const workbenchCapabilities = {
  listProjects: descriptor('research.projects.list', researchProjectListRequestSchema, researchProjectSchema.array()),
  getProject: descriptor('research.projects.get', researchProjectIdRequestSchema, researchProjectSchema),
  createProject: descriptor('research.projects.create', researchProjectCreateRequestSchema, researchProjectSchema),
  updateProject: descriptor('research.projects.update', researchProjectUpdateRequestSchema, researchProjectSchema),
  deleteProject: descriptor('research.projects.delete', researchProjectIdRequestSchema, z.object({ id: z.string(), deleted: z.literal(true) }).strict()),
  getWorkflow: descriptor('research.workflow.get', researchProjectIdRequestSchema, researchWorkflowSnapshotSchema),
  transitionWorkflow: {...descriptor('research.workflow.transition', researchWorkflowTransitionRequestSchema, researchWorkflowSnapshotSchema),
    effectReceipt: 'handler' as const},
  verifyStageArtifacts: descriptor(
    'research.workflow.verifyStageArtifacts',
    z.object({ projectId: z.string().min(1), stage: researchStageSchema }).strict(),
    z.object({ passed: z.boolean(), detail: z.string(), refs: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()) }).strict()
  ),
  stageRole: descriptor('research.workflow.role', researchStageRoleRequestSchema, researchStageRoleProfileSchema)
};
export const knowledgeCapabilities = {
  jobs: descriptor('research.knowledge.jobs', knowledgeJobsListSchema, knowledgeJobSchema.array()),
  retry: descriptor('research.knowledge.retry', knowledgeJobRetrySchema, z.object({queued:z.literal(true)})),
  listEmbedding: descriptor('research.embedding.list', emptyInputSchema, researchEmbeddingConfigSchema.array()),
  saveEmbedding: descriptor('research.embedding.save', researchEmbeddingConfigSaveRequestSchema, researchEmbeddingConfigSchema),
  readReranker: descriptor('research.reranker.read', emptyInputSchema, rerankerConfigSchema.nullable()),
  saveReranker: descriptor('research.reranker.save', rerankerSaveSchema, rerankerConfigSchema),
  upsertDocument: descriptor('research.knowledge.upsert', researchKnowledgeDocumentUpsertRequestSchema, researchKnowledgeDocumentSchema),
  search: descriptor('research.knowledge.search', researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema),
  scientificQuery: descriptor('research.knowledge.scientificQuery', scientificQueryRequestSchema, scientificQueryResultSchema),
  scientificSearch: descriptor('research.knowledge.scientificSearch', scientificSearchRequestSchema, scientificSearchResultSchema),
  scientificGenerations: descriptor('research.knowledge.scientificGenerations', scientificGenerationsRequestSchema, scientificGenerationsResultSchema),
  scientificActivate: descriptor('research.knowledge.scientificActivate', scientificGenerationActivateSchema, scientificGenerationsResultSchema),
  scientificContext: descriptor('research.knowledge.scientificContext', scientificContextRequestSchema, scientificContextResultSchema),
  scientificEvidence: descriptor('research.knowledge.scientificEvidence', scientificEvidenceRequestSchema, scientificEvidenceResultSchema),
  scientificRead: descriptor('research.knowledge.scientificRead', scientificKnowledgeReadRequestSchema, scientificKnowledgeReadSchema),
  deepRequest: descriptor('research.knowledge.deepRequest', paperDeepKnowledgeRequestSchema, scientificExtractionJobSchema),
  deepRead: descriptor('research.knowledge.deepRead', paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema),
  extractionEnqueue: descriptor('research.knowledge.extractionEnqueue', scientificExtractionDocumentRequestSchema, scientificExtractionJobSchema),
  extractionJobs: descriptor('research.knowledge.extractionJobs', scientificExtractionJobsRequestSchema, scientificExtractionJobSchema.array()),
  extractionRetry: descriptor('research.knowledge.extractionRetry', scientificExtractionJobRequestSchema, scientificExtractionJobSchema),
  extractionCancel: descriptor('research.knowledge.extractionCancel', scientificExtractionJobRequestSchema, scientificExtractionJobSchema),
  context: descriptor('research.knowledge.context', knowledgeContextRequestSchema, knowledgeContextResultSchema)
};
export const provenanceCapabilities = {
  add: descriptor('research.provenance.add', researchProvenanceCreateRequestSchema, researchProvenanceSchema),
  list: descriptor('research.provenance.list', researchProvenanceListRequestSchema, researchProvenanceSchema.array())
};
const researchCapabilityDescriptors = [
  ...researchProposalCapabilities,
  ...researchManuscriptSyncCapabilities,
  ...researchResultDerivationCapabilities,
  ...researchImpactCapabilities,
  ...researchArgumentOutlineCapabilities,
  researchReviewPilotCapability,
  ...researchSubmissionProfileCapabilities,
  ...researchSubmissionCapabilities,
  ...researchFeedbackCapabilities,
  ...researchExternalExperimentCapabilities,
  ...Object.values(workbenchCapabilities),
  ...literatureImportCapabilities,
  ...literatureAcquisitionCapabilities,
  ...zoteroCapabilities,
  ...Object.values(knowledgeCapabilities),
  ...Object.values(provenanceCapabilities)
];

export const lifecycleCapabilities = {
  createArtifact: descriptor('research.artifacts.create', researchArtifactCreateRequestSchema, researchArtifactSchema),
  getArtifact: descriptor('research.artifacts.get', researchArtifactIdRequestSchema, researchArtifactSchema),
  listArtifacts: descriptor('research.artifacts.list', researchArtifactListRequestSchema, researchArtifactSchema.array()),
  updateArtifact: descriptor('research.artifacts.update', researchArtifactUpdateRequestSchema, researchArtifactSchema),
  events: descriptor('research.workflow.events', researchWorkflowEventsRequestSchema, researchWorkflowEventSchema.array())
};


export function createResearchPluginManifest(): RocPluginManifest {
  return {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Research Workbench',
      description: '科研项目、阶段流程和 Provenance 基础能力。',
      required: true,
      order: 55,
      dependencies: ['@roc/plugin-agent', '@roc/plugin-workspace'],
      capabilities: [researchDiagramCapability, referenceCheckCapability, ...researchReadingCapabilities, ...taskFactCapabilities, researchStorageCapability, researchArtifactInspectorCapability, researchGateReviewCapability, ...researchTaskCapabilities, ...researchCapabilityDescriptors, ...Object.values(lifecycleCapabilities), ...researchEvidenceCapabilities, ...researchWikiCapabilities, ...researchManuscriptCapabilities, ...researchIdeaCapabilities, ...researchIdeaPlanCapabilities, ...researchIdeaOutcomeCapabilities, ...researchRunCapabilities, ...researchProductionCapabilities, ...researchLibraryCapabilities, ...researchScholarlyCapabilities, ...researchResourceCapabilities, ...researchOpenReviewCapabilities, ...researchMonitorCapabilities, ...researchZenodoCapabilities, ...researchZenodoPublicationCapabilities, ...researchHuggingFaceCapabilities, ...researchHuggingFaceDownloadCapabilities, ...researchResourceAssociationCapabilities, ...researchDocumentCapabilities, ...researchSystematicReviewCapabilities, ...researchReviewSearchCapabilities, ...researchOwnedReviewSearchCapabilities, ...researchReviewCorpusCapabilities, ...researchReviewDeduplicationCapabilities, ...researchReviewScreeningCapabilities, ...researchReviewFullTextCapabilities, ...researchReviewFullTextScreeningCapabilities, ...researchReviewExtractionCapabilities, ...researchReviewQualityCapabilities, ...researchReviewStudiesCapabilities, researchReviewReportCapability, ...researchIndexCapabilities, ...researchExperimentCapabilities, ...researchPythonEnvironmentCapabilities, ...researchNotebookCapabilities, ...researchExperimentResultCapabilities, ...researchFigureCapabilities, ...researchExportCapabilities, ...researchProductionInputCapabilities, ...researchProseCapabilities, researchCitationCoverageCapability, ...researchCitationReviewCapabilities, ...researchConsistencyCapabilities, ...researchFigureConsistencyCapabilities, ...researchResponseMatrixCapabilities, ...researchJournalComplianceCapabilities, ...researchVisualCapabilities, figureUnderstandingCapability]
    };
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: capabilityVersion, inputSchema, outputSchema };
}
