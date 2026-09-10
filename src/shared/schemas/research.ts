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

const researchWorkflowTransitionBaseSchema = z.object({
  projectId: z.string().min(1),
  expectedStage: researchStageSchema,
  note: z.string().trim().max(2000).optional()
});

export const researchWorkflowTransitionRequestSchema = z.discriminatedUnion('action', [
  researchWorkflowTransitionBaseSchema.extend({
    action: z.enum(['start', 'pause', 'resume', 'complete', 'approve', 'reject'])
  }).strict(),
  researchWorkflowTransitionBaseSchema.extend({
    action: z.literal('move'),
    targetStage: researchStageSchema
  }).strict()
]);

export const researchWorkflowEventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  stage: researchStageSchema,
  type: z.string(),
  message: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
}).strict();

export const researchWorkflowEventsRequestSchema = z.object({
  projectId: z.string().min(1),
  limit: z.number().int().positive().max(200)
}).strict();

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

export const researchArtifactCreateRequestSchema = z.object({
  projectId: z.string().min(1),
  stage: researchStageSchema,
  kind: researchArtifactKindSchema,
  title: z.string().trim().min(1).max(300),
  path: z.string().trim().min(1).nullable()
}).strict();

export const researchArtifactIdRequestSchema = z.object({ id: z.string().min(1) }).strict();

export const researchArtifactUpdateRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  path: z.string().trim().min(1).nullable().optional()
}).strict();

export const researchArtifactListRequestSchema = z.object({
  projectId: z.string().min(1),
  stage: researchStageSchema.optional()
}).strict();

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

export const researchLiteratureSourceSchema = z.enum(['openalex', 'crossref', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc', 'local']);

export const researchLiteratureSchema = z
  .object({
    id: z.string(),
    source: researchLiteratureSourceSchema,
    externalId: z.string(),
    doi: z.string().nullable(),
    title: z.string(),
    authors: z.array(z.string()),
    abstract: z.string().nullable(),
    publishedYear: z.number().int().nullable(),
    citationCount: z.number().int().nullable(),
    url: z.string().nullable(),
    openAccessUrl: z.string().nullable(),
    importedAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const researchLiteratureSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1),
    sources: z.array(researchLiteratureSourceSchema).min(1),
    limit: z.number().int().positive().max(50)
  })
  .strict();

export const researchEmbeddingConfigSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    dimensions: z.number().int().positive(),
    keyConfigured: z.boolean(),
    enabled: z.boolean(),
    updatedAt: z.string()
  })
  .strict();

export const researchEmbeddingConfigSaveRequestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    baseUrl: z.string().url(),
    model: z.string().trim().min(1),
    dimensions: z.number().int().positive(),
    apiKey: z.string().trim().min(1),
    enabled: z.boolean()
  })
  .strict();

export const researchKnowledgeDocumentSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    sourceType: z.enum(['literature', 'file', 'note', 'experiment']),
    sourceId: z.string(),
    title: z.string(),
    content: z.string(),
    indexedAt: z.string()
  })
  .strict();

export const researchKnowledgeDocumentUpsertRequestSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().nullable(),
    sourceType: z.enum(['literature', 'file', 'note', 'experiment']),
    sourceId: z.string().min(1),
    title: z.string().trim().min(1),
    content: z.string().min(1),
    chunks: z.array(z.object({ content: z.string().min(1), locator: z.string().nullable() }).strict()).min(1),
    embeddingConfigId: z.string().min(1).nullable()
  })
  .strict();

export const researchKnowledgeSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1),
    projectId: z.string().min(1).nullable(),
    limit: z.number().int().positive().max(50),
    embeddingConfigId: z.string().min(1).nullable()
  })
  .strict();

export const researchKnowledgeSearchHitSchema = z
  .object({
    chunkId: z.string(),
    documentId: z.string(),
    title: z.string(),
    content: z.string(),
    locator: z.string().nullable(),
    sourceType: z.string(),
    sourceId: z.string(),
    keywordRank: z.number().int().nullable(),
    vectorRank: z.number().int().nullable(),
    rrfScore: z.number()
  })
  .strict();

export const researchKnowledgeSearchResultSchema = z
  .object({
    query: z.string(),
    hits: z.array(researchKnowledgeSearchHitSchema),
    keywordCount: z.number().int(),
    vectorCount: z.number().int(),
    embeddingModel: z.string().nullable(),
    generatedAt: z.string()
  })
  .strict();

export const researchTemplateSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    rootPath: z.string(),
    entryPath: z.string(),
    status: z.enum(['imported', 'compiling', 'ready', 'failed']),
    pdfPath: z.string().nullable(),
    errors: z.array(z.string()),
    lastCompiledAt: z.string().nullable(),
    updatedAt: z.string()
  })
  .strict();

export const researchTemplateImportRequestSchema = z
  .object({ projectId: z.string().min(1), sourcePath: z.string().min(1) })
  .strict();

export const researchTemplateCompileRequestSchema = z
  .object({ projectId: z.string().min(1), templateId: z.string().min(1) })
  .strict();

export const researchExperimentRunSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    label: z.string(),
    command: z.string(),
    parameters: z.record(z.string(), z.string()),
    environment: z.record(z.string(), z.string()),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    outputs: z.array(z.string()),
    startedAt: z.string(),
    endedAt: z.string().nullable()
  })
  .strict();

export const researchExperimentRunRecordRequestSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    label: z.string().trim().min(1),
    command: z.string().trim().min(1),
    parameters: z.record(z.string(), z.string()),
    environment: z.record(z.string(), z.string()),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    outputs: z.array(z.string()),
    startedAt: z.string(),
    endedAt: z.string().nullable()
  })
  .strict();

export const researchFigureSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    codePath: z.string(),
    dataPaths: z.array(z.string()),
    outputPaths: z.array(z.string()),
    status: z.enum(['draft', 'rendered', 'approved', 'failed']),
    runId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const researchFigureRecordRequestSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().trim().min(1),
    codePath: z.string().min(1),
    dataPaths: z.array(z.string()),
    outputPaths: z.array(z.string()),
    status: z.enum(['draft', 'rendered', 'approved', 'failed']),
    runId: z.string().nullable()
  })
  .strict();

export const researchStageRoleProfileSchema = z
  .object({
    stage: researchStageSchema,
    role: z.string(),
    skillIds: z.array(z.string()),
    allowedCapabilities: z.array(z.string()),
    outputKind: researchArtifactKindSchema
  })
  .strict();

export const researchStageRoleRequestSchema = z.object({ stage: researchStageSchema }).strict();

export const researchProvenanceCreateRequestSchema = researchProvenanceSchema.omit({ id: true, createdAt: true }).strict();
export const researchProvenanceListRequestSchema = z.object({ projectId: z.string().min(1), subjectId: z.string().optional() }).strict();
