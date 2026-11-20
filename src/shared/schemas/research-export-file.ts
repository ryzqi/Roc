import {z} from 'zod';
import {researchExperimentPathSchema} from './research-experiments';

export const researchExportFileSchema = z.strictObject({
  path: researchExperimentPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative()
});
export type ResearchExportFile = z.infer<typeof researchExportFileSchema>;
