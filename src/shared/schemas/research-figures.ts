import { z } from 'zod';
import { researchExperimentIdRequestSchema, researchExperimentListRequestSchema, researchExperimentPathSchema } from './research-experiments';
import { researchFigureValidationSchema } from './research-plotting';

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
