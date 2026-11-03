import {z} from 'zod';

export const researchArtifactVersionSchema = z.object({
  artifactId: z.string().min(1), version: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const researchArtifactVersionsSchema = researchArtifactVersionSchema.array().min(1).refine(
  values => new Set(values.map(value => value.artifactId)).size === values.length,
  'Reviewed artifact IDs must be unique.');
export type ResearchArtifactVersion = z.infer<typeof researchArtifactVersionSchema>;
