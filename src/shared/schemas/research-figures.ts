import { z } from 'zod';
import { researchExperimentEnvironmentSchema, researchExperimentFileSchema, researchExperimentIdRequestSchema, researchExperimentListRequestSchema, researchExperimentPathSchema, researchExperimentRuntimeSchema } from './research-experiments';
import { researchFigureOptionsSchema, researchFigureValidationSchema } from './research-plotting';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const figureStartFields = {
  requestId: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(256),
  engine: z.literal('vega-lite'),
  sourceVersion: z.literal(1),
  sourcePath: researchExperimentPathSchema,
  inputPaths: z.array(researchExperimentPathSchema).max(1000),
  expectedEnvironmentHash: digest.optional(),
  timeoutMs: z.number().int().min(1000).max(3600000),
  figure: researchFigureOptionsSchema
} as const;

function refineFigureStart(value: { sourcePath: string; inputPaths: string[] }, context: z.RefinementCtx): void {
  if (!value.sourcePath.toLowerCase().endsWith('.vl.json')) {
    context.addIssue({ code: 'custom', message: 'research_figure_source_type_invalid', path: ['sourcePath'] });
  }
  if (new Set(value.inputPaths).size !== value.inputPaths.length) {
    context.addIssue({ code: 'custom', message: 'research_figure_duplicate_input', path: ['inputPaths'] });
  }
  if (value.inputPaths.includes(value.sourcePath)) {
    context.addIssue({ code: 'custom', message: 'research_figure_source_input_duplicate', path: ['inputPaths'] });
  }
}

const historicalFigureStartFields = {
  requestId: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(256),
  runtime: researchExperimentRuntimeSchema,
  sourcePath: researchExperimentPathSchema,
  inputPaths: z.array(researchExperimentPathSchema).max(1000),
  arguments: z.array(z.string().max(8192).refine((value) => !value.includes('\u0000'))).max(100),
  parameters: z.record(z.string().min(1).max(256), z.string().max(65536)).refine((value) => Object.keys(value).length <= 1000),
  expectedEnvironmentHash: digest.optional(),
  timeoutMs: z.number().int().min(1000).max(3600000),
  figure: researchFigureOptionsSchema
} as const;

function refineHistoricalFigureStart(value: { sourcePath: string; inputPaths: string[] }, context: z.RefinementCtx): void {
  if (!value.sourcePath.toLowerCase().endsWith('.py')) {
    context.addIssue({ code: 'custom', message: 'research_figure_historical_source_invalid', path: ['sourcePath'] });
  }
  if (new Set(value.inputPaths).size !== value.inputPaths.length) {
    context.addIssue({ code: 'custom', message: 'research_figure_duplicate_input', path: ['inputPaths'] });
  }
}

export const researchOwnedFigureStartSchema = z.object(figureStartFields).strict().superRefine(refineFigureStart);
export const researchFigureStartSchema = z.object({
  projectId: z.string().min(1),
  ownerRunId: z.string().min(1).nullable().optional(),
  ...figureStartFields
}).strict().superRefine(refineFigureStart);

const historicalFigureRunRequestSchema = z.object({
  projectId: z.string().min(1),
  ownerRunId: z.string().min(1).nullable().optional(),
  ...historicalFigureStartFields
}).strict().superRefine(refineHistoricalFigureStart);

export const researchFigureEnvironmentRequestSchema = z.object({ projectId: z.string().min(1).max(128) }).strict();

export const researchFigureRendererEnvironmentSchema = z.object({
  engine: z.literal('vega-lite'),
  vegaVersion: z.string().min(1),
  vegaLiteVersion: z.string().min(1),
  renderer: z.literal('@napi-rs/canvas'),
  rendererVersion: z.string().min(1),
  pipelineVersion: z.string().min(1).default('roc-vega-pipeline/legacy'),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  hash: digest
}).strict();

const figureOutputFileSchema = z.object({
  path: z.enum(['figure.png', 'figure.svg', 'figure.pdf']),
  size: z.number().int().positive(),
  sha256: digest
}).strict();

export const researchFigureRenderJobSchema = z.object({
  operation: z.literal('render_figure'),
  projectRoot: z.string().min(1),
  sourcePath: researchExperimentPathSchema,
  label: z.string().trim().min(1).max(256),
  outputDir: z.string().min(1),
  inputPaths: z.array(researchExperimentPathSchema).max(1000).refine((paths) => new Set(paths).size === paths.length,
    { message: 'research_figure_duplicate_input' }),
  timeoutMs: z.number().int().min(1000).max(3600000),
  figure: researchFigureOptionsSchema
}).strict();

export const researchFigureRenderResultSchema = z.object({
  engine: z.literal('vega-lite'),
  rendererHash: digest,
  outputs: z.array(figureOutputFileSchema).length(3)
}).strict();
export const researchFigureRenderJobResultSchema = researchFigureRenderResultSchema.extend({ sourceHash: digest });

export const researchFigureRunSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  request: z.union([researchFigureStartSchema, historicalFigureRunRequestSchema]),
  ownerRunId: z.string().min(1).nullable(),
  workspacePath: z.string().min(1),
  workspaceRoot: z.string().min(1),
  status: z.enum(['preparing', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  environment: z.union([researchFigureRendererEnvironmentSchema, researchExperimentEnvironmentSchema]).nullable(),
  files: z.array(researchExperimentFileSchema),
  inputHash: digest.nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  artifactId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable()
}).strict();

export const researchFigurePublicationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  artifactId: z.string().min(1),
  title: z.string().min(1),
  sourcePath: researchExperimentPathSchema,
  inputPaths: z.array(researchExperimentPathSchema),
  replacesFigureId: z.string().min(1).nullable(),
  validation: researchFigureValidationSchema,
  manifestHash: digest,
  status: z.enum(['rendered', 'approved', 'superseded']),
  createdAt: z.string()
}).strict();

export const researchFigurePublishRequestSchema = researchExperimentIdRequestSchema.extend({ replacesFigureId: z.string().min(1).nullable() }).strict();
export const researchFigureListRequestSchema = researchExperimentListRequestSchema;
export const researchFigureIdRequestSchema = z.object({ projectId: z.string().min(1), figureId: z.string().min(1) }).strict();
export const researchFigureSourceRequestSchema = researchFigureIdRequestSchema.extend({
  format: z.enum(['png', 'svg', 'pdf']),
  sha256: digest
}).strict();

export type ResearchFigurePublication = z.infer<typeof researchFigurePublicationSchema>;
export type ResearchFigureRun = z.infer<typeof researchFigureRunSchema>;
export type ResearchFigureStart = z.infer<typeof researchFigureStartSchema>;
export type ResearchFigureRendererEnvironment = z.infer<typeof researchFigureRendererEnvironmentSchema>;
export type ResearchFigureRenderResult = z.infer<typeof researchFigureRenderJobResultSchema>;
export type ResearchFigureRenderJob = z.infer<typeof researchFigureRenderJobSchema>;
