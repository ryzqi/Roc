import type { z } from 'zod';
import type {
  researchTemplateFileSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema,
  researchTemplateFileSaveRequestSchema, researchTemplateEntryRequestSchema, researchTemplateListRequestSchema,
  researchToolchainStatusSchema, researchParsedDocumentSchema, researchRenderedPdfSchema
} from '../schemas/research-production';

export type ResearchTemplateFile = z.infer<typeof researchTemplateFileSchema>;
export type ResearchTemplateFileContent = z.infer<typeof researchTemplateFileContentSchema>;
export type ResearchTemplateFileRequest = z.infer<typeof researchTemplateFileRequestSchema>;
export type ResearchTemplateFileSaveRequest = z.infer<typeof researchTemplateFileSaveRequestSchema>;
export type ResearchTemplateEntryRequest = z.infer<typeof researchTemplateEntryRequestSchema>;
export type ResearchTemplateListRequest = z.infer<typeof researchTemplateListRequestSchema>;
export type ResearchToolchainStatus = z.infer<typeof researchToolchainStatusSchema>;
export type ResearchParsedDocument = z.infer<typeof researchParsedDocumentSchema>;
export type ResearchRenderedPdf = z.infer<typeof researchRenderedPdfSchema>;
import type {
  researchArtifactContentSchema,
  researchModelSelectionSchema,
  researchStageOutputSchema,
  researchStagePolicySchema,
  researchStageRunSchema,
  researchStageRunStartRequestSchema,
  researchStageRunIdRequestSchema,
  researchStageRunRetryRequestSchema,
  researchStageRunsRequestSchema,
  researchReviewCycleSchema
} from '../schemas/research-runs';
import type {
  researchEvidenceSchema,
  researchEvidenceCaptureRequestSchema,
  researchEvidenceListRequestSchema,
  researchClaimSchema,
  researchClaimCreateRequestSchema,
  researchClaimUpdateRequestSchema,
  researchClaimListRequestSchema,
  researchManuscriptSchema,
  researchManuscriptSaveRequestSchema,
  researchExportBundleSchema,
  researchExportBundleRequestSchema
} from '../schemas/research-evidence';

import {
  researchArtifactCreateRequestSchema,
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
  researchKnowledgeSearchHitSchema,
  researchKnowledgeSearchResultSchema,
  researchExperimentRunRecordRequestSchema,
  researchExperimentRunSchema,
  researchFigureRecordRequestSchema,
  researchFigureSchema,
  researchLiteratureSchema,
  researchLiteratureSearchRequestSchema,
  researchProvenanceSchema,
  researchStageStateSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowEventSchema,
  researchWorkflowEventsRequestSchema,
  researchWorkflowTransitionRequestSchema
  ,researchTemplateCompileRequestSchema
  ,researchTemplateImportRequestSchema
  ,researchTemplateSchema
  ,researchStageRoleProfileSchema
  ,researchStageRoleRequestSchema
  ,researchProvenanceCreateRequestSchema
  ,researchProvenanceListRequestSchema
} from '../schemas/research';

export type ResearchProject = z.infer<typeof researchProjectSchema>;
export type ResearchProjectListRequest = z.infer<typeof researchProjectListRequestSchema>;
export type ResearchProjectIdRequest = z.infer<typeof researchProjectIdRequestSchema>;
export type ResearchProjectCreateRequest = z.infer<typeof researchProjectCreateRequestSchema>;
export type ResearchProjectUpdateRequest = z.infer<typeof researchProjectUpdateRequestSchema>;
export type ResearchStageState = z.infer<typeof researchStageStateSchema>;
export type ResearchWorkflowSnapshot = z.infer<typeof researchWorkflowSnapshotSchema>;
export type ResearchWorkflowTransitionRequest = z.infer<typeof researchWorkflowTransitionRequestSchema>;
export type ResearchArtifact = z.infer<typeof researchArtifactSchema>;
export type ResearchArtifactCreateRequest = z.infer<typeof researchArtifactCreateRequestSchema>;
export type ResearchArtifactUpdateRequest = z.infer<typeof researchArtifactUpdateRequestSchema>;
export type ResearchArtifactListRequest = z.infer<typeof researchArtifactListRequestSchema>;
export type ResearchWorkflowEvent = z.infer<typeof researchWorkflowEventSchema>;
export type ResearchWorkflowEventsRequest = z.infer<typeof researchWorkflowEventsRequestSchema>;
export type ResearchProvenance = z.infer<typeof researchProvenanceSchema>;
export type ResearchLiterature = z.infer<typeof researchLiteratureSchema>;
export type ResearchLiteratureSearchRequest = z.infer<typeof researchLiteratureSearchRequestSchema>;
export type ResearchEmbeddingConfig = z.infer<typeof researchEmbeddingConfigSchema>;
export type ResearchEmbeddingConfigSaveRequest = z.infer<typeof researchEmbeddingConfigSaveRequestSchema>;
export type ResearchKnowledgeDocument = z.infer<typeof researchKnowledgeDocumentSchema>;
export type ResearchKnowledgeDocumentUpsertRequest = z.infer<typeof researchKnowledgeDocumentUpsertRequestSchema>;
export type ResearchKnowledgeSearchRequest = z.infer<typeof researchKnowledgeSearchRequestSchema>;
export type ResearchKnowledgeSearchHit = z.infer<typeof researchKnowledgeSearchHitSchema>;
export type ResearchKnowledgeSearchResult = z.infer<typeof researchKnowledgeSearchResultSchema>;
export type ResearchTemplate = z.infer<typeof researchTemplateSchema>;
export type ResearchTemplateImportRequest = z.infer<typeof researchTemplateImportRequestSchema>;
export type ResearchTemplateCompileRequest = z.infer<typeof researchTemplateCompileRequestSchema>;
export type ResearchExperimentRun = z.infer<typeof researchExperimentRunSchema>;
export type ResearchExperimentRunRecordRequest = z.infer<typeof researchExperimentRunRecordRequestSchema>;
export type ResearchFigure = z.infer<typeof researchFigureSchema>;
export type ResearchFigureRecordRequest = z.infer<typeof researchFigureRecordRequestSchema>;
export type ResearchStageRoleProfile = z.infer<typeof researchStageRoleProfileSchema>;
export type ResearchStageRoleRequest = z.infer<typeof researchStageRoleRequestSchema>;
export type ResearchProvenanceCreateRequest = z.infer<typeof researchProvenanceCreateRequestSchema>;
export type ResearchProvenanceListRequest = z.infer<typeof researchProvenanceListRequestSchema>;
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export type ResearchEvidenceCaptureRequest = z.infer<typeof researchEvidenceCaptureRequestSchema>;
export type ResearchEvidenceListRequest = z.infer<typeof researchEvidenceListRequestSchema>;
export type ResearchClaim = z.infer<typeof researchClaimSchema>;
export type ResearchClaimCreateRequest = z.infer<typeof researchClaimCreateRequestSchema>;
export type ResearchClaimUpdateRequest = z.infer<typeof researchClaimUpdateRequestSchema>;
export type ResearchClaimListRequest = z.infer<typeof researchClaimListRequestSchema>;
export type ResearchManuscript = z.infer<typeof researchManuscriptSchema>;
export type ResearchManuscriptSaveRequest = z.infer<typeof researchManuscriptSaveRequestSchema>;
export type ResearchExportBundle = z.infer<typeof researchExportBundleSchema>;
export type ResearchExportBundleRequest = z.infer<typeof researchExportBundleRequestSchema>;
export type ResearchArtifactContent = z.infer<typeof researchArtifactContentSchema>;
export type ResearchModelSelection = z.infer<typeof researchModelSelectionSchema>;
export type ResearchStageOutput = z.infer<typeof researchStageOutputSchema>;
export type ResearchStagePolicy = z.infer<typeof researchStagePolicySchema>;
export type ResearchStageRun = z.infer<typeof researchStageRunSchema>;
export type ResearchStageRunStartRequest = z.infer<typeof researchStageRunStartRequestSchema>;
export type ResearchStageRunIdRequest = z.infer<typeof researchStageRunIdRequestSchema>;
export type ResearchStageRunRetryRequest = z.infer<typeof researchStageRunRetryRequestSchema>;
export type ResearchStageRunsRequest = z.infer<typeof researchStageRunsRequestSchema>;
export type ResearchReviewCycle = z.infer<typeof researchReviewCycleSchema>;
