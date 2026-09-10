import type { z } from 'zod';
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
