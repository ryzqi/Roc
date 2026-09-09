import { z } from 'zod';

export const researchStageSchema = z.enum([
  'discovery',
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
]);

export const researchProjectStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);

export const researchStageStatusSchema = z.enum([
  'locked',
  'ready',
  'running',
  'waiting_approval',
  'paused',
  'blocked',
  'completed',
  'failed'
]);

export const researchArtifactKindSchema = z.enum([
  'search_strategy',
  'source_corpus',
  'reading_notes',
  'idea_canvas',
  'research_plan',
  'experiment_run',
  'figure',
  'manuscript',
  'review_report',
  'revision_plan',
  'export_package'
]);

export const researchProjectSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    workspacePath: z.string().nullable(),
    status: researchProjectStatusSchema,
    currentStage: researchStageSchema,
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const researchProjectListRequestSchema = z.object({}).strict();

export const researchProjectIdRequestSchema = z.object({ id: z.string().min(1) }).strict();

export const researchProjectCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    workspacePath: z.string().trim().min(1).nullable()
  })
  .strict();

export const researchProjectUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    workspacePath: z.string().trim().min(1).nullable().optional(),
    status: researchProjectStatusSchema.optional()
  })
  .strict();

export const researchStageStateSchema = z
  .object({
    stage: researchStageSchema,
    status: researchStageStatusSchema,
    activeRunId: z.string().nullable(),
    artifactIds: z.array(z.string()),
    enteredAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    gateRequired: z.boolean(),
    gateApproved: z.boolean(),
    lastError: z.string().nullable()
  })
  .strict();

export const researchWorkflowSnapshotSchema = z
  .object({
    projectId: z.string(),
    currentStage: researchStageSchema,
    projectStatus: researchProjectStatusSchema,
    stages: z.array(researchStageStateSchema),
    lastEvent: z
      .object({
        type: z.string(),
        stage: researchStageSchema,
        message: z.string(),
        createdAt: z.string()
      })
      .strict()
      .nullable()
  })
  .strict();

export const researchWorkflowTransitionRequestSchema = z
  .object({
    projectId: z.string().min(1),
    action: z.enum(['start', 'pause', 'resume', 'complete', 'approve', 'reject']),
    expectedStage: researchStageSchema,
    note: z.string().trim().max(2000).optional()
  })
  .strict();

export const researchArtifactSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    stage: researchStageSchema,
    kind: researchArtifactKindSchema,
    title: z.string(),
    path: z.string().nullable(),
    status: z.enum(['draft', 'approved', 'superseded']),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const researchProvenanceSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    artifactId: z.string().nullable(),
    subjectType: z.enum(['claim', 'paragraph', 'figure', 'experiment', 'artifact']),
    subjectId: z.string(),
    sourceType: z.enum(['literature', 'file', 'experiment', 'model_run', 'workflow_event']),
    sourceId: z.string(),
    locator: z.string().nullable(),
    excerpt: z.string().nullable(),
    createdAt: z.string()
  })
  .strict();

