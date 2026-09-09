import type { z } from 'zod';

import {
  researchArtifactSchema,
  researchProjectCreateRequestSchema,
  researchProjectIdRequestSchema,
  researchProjectListRequestSchema,
  researchProjectSchema,
  researchProjectUpdateRequestSchema,
  researchProvenanceSchema,
  researchStageStateSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowTransitionRequestSchema
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
export type ResearchProvenance = z.infer<typeof researchProvenanceSchema>;

