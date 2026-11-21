import {z} from 'zod';
import {researchExperimentResultGetSchema} from './research-experiment-results';
import {researchExperimentPathSchema} from './research-experiments';
import {researchResultDerivationRequestSchema} from './research-result-derivation';

const sourceHash = researchExperimentResultGetSchema.shape.expectedHash;
export const researchResultFigureSourceRequestSchema = researchExperimentResultGetSchema.extend({
  sourceHash, metricIds: researchResultDerivationRequestSchema.shape.metricIds
});
export const researchResultFigureSourceSchema = z.strictObject({sourcePath: researchExperimentPathSchema, sourceHash});
export type ResearchResultFigureSourceRequest = z.infer<typeof researchResultFigureSourceRequestSchema>;
