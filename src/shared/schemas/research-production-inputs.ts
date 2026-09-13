import { z } from 'zod';
import { researchArtifactSchema } from './research';
import { researchExperimentExecutionSchema, researchExperimentPathSchema } from './research-experiments';
import { researchFigurePublicationSchema } from './research-figures';
import { researchExportExecutionSchema } from './research-exports';

export const researchProductionInputRequestSchema = z.object({ projectId: z.string().min(1), artifactId: z.string().min(1) }).strict();
export const researchProductionInputFileSchema = z.object({
  area: z.enum(['input', 'output', 'log', 'notebook', 'bundle']), path: researchExperimentPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative()
}).strict();
export const researchProductionInputSchema = z.object({
  artifact: researchArtifactSchema, files: z.array(researchProductionInputFileSchema),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('experiment'), execution: researchExperimentExecutionSchema }).strict(),
    z.object({ kind: z.literal('figure'), figure: researchFigurePublicationSchema, execution: researchExperimentExecutionSchema }).strict(),
    z.object({ kind: z.literal('export'), execution: researchExportExecutionSchema }).strict()
  ])
}).strict();
export const researchProductionInputReadSchema = researchProductionInputRequestSchema.extend({
  area: researchProductionInputFileSchema.shape.area, path: researchExperimentPathSchema
}).strict();
export const researchProductionInputContentSchema = z.object({
  file: researchProductionInputFileSchema, content: z.string(), encoding: z.enum(['utf8', 'base64'])
}).strict();

export type ResearchProductionInput = z.infer<typeof researchProductionInputSchema>;
export type ResearchProductionInputRead = z.infer<typeof researchProductionInputReadSchema>;
export type ResearchProductionInputContent = z.infer<typeof researchProductionInputContentSchema>;
