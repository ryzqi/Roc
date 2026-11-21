import {researchExternalExperimentResultGetSchema} from './research-external-experiments';
export const researchExternalExperimentFigureSchema=researchExternalExperimentResultGetSchema.extend({
  sourceHash:researchExternalExperimentResultGetSchema.shape.expectedHash
});
