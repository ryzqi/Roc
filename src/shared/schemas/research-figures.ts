import { z } from 'zod';
import { researchExperimentIdRequestSchema, researchExperimentListRequestSchema, researchExperimentPathSchema, researchExperimentRuntimeSchema } from './research-experiments';
import { researchFigureOptionsSchema, researchFigureValidationSchema } from './research-plotting';


const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const researchFigureStartFields = {
  requestId: z.string().min(1).max(128), label: z.string().trim().min(1).max(256),
  runtime: researchExperimentRuntimeSchema, sourcePath: researchExperimentPathSchema,
  inputPaths: z.array(researchExperimentPathSchema).max(1000),
  arguments: z.array(z.string().max(8192).refine((value) => !value.includes('\u0000'))).max(100),
  parameters: z.record(z.string().min(1).max(256), z.string().max(65536)).refine((value) => Object.keys(value).length <= 1000),
  expectedEnvironmentHash: digest, timeoutMs: z.number().int().min(1000).max(3600000),
  figure: researchFigureOptionsSchema
} as const;
function refineFigureStart(value: { sourcePath: string; inputPaths: string[]; runtime: { kind: string } }, context: z.RefinementCtx): void {
  if (!value.sourcePath.toLowerCase().endsWith('.py')) {
    context.addIssue({ code: 'custom', message: 'research_experiment_source_type_invalid', path: ['sourcePath'] });
  }
  if (new Set(value.inputPaths).size !== value.inputPaths.length) context.addIssue({ code: 'custom', message: 'research_experiment_duplicate_input', path: ['inputPaths'] });
  if (!['bundled-python', 'uv'].includes(value.runtime.kind)) {
    context.addIssue({ code: 'custom', message: 'research_experiment_runtime_mismatch', path: ['runtime'] });
  }
}
export const researchOwnedFigureStartSchema = z.object(researchFigureStartFields).strict().superRefine(refineFigureStart);
export const researchFigureStartSchema = z.object({
  projectId: z.string().min(1), ownerRunId: z.string().min(1).nullable().optional(), ...researchFigureStartFields
}).strict().superRefine(refineFigureStart);
export const researchFigurePublicationSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), runId: z.string().min(1), artifactId: z.string().min(1),
  title: z.string().min(1), sourcePath: researchExperimentPathSchema, inputPaths: z.array(researchExperimentPathSchema),
  replacesFigureId: z.string().min(1).nullable(),
  validation: researchFigureValidationSchema, manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['rendered', 'approved', 'superseded']), createdAt: z.string()
}).strict();
export const researchFigurePublishRequestSchema = researchExperimentIdRequestSchema.extend({ replacesFigureId: z.string().min(1).nullable() }).strict();
export const researchFigureListRequestSchema = researchExperimentListRequestSchema;
export const researchFigureIdRequestSchema = z.object({ projectId: z.string().min(1), figureId: z.string().min(1) }).strict();
export const researchFigureSourceRequestSchema = researchFigureIdRequestSchema.extend({
  format: z.enum(['png', 'svg', 'pdf']), sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export type ResearchFigurePublication = z.infer<typeof researchFigurePublicationSchema>;
export type ResearchFigureStart = z.infer<typeof researchFigureStartSchema>;
