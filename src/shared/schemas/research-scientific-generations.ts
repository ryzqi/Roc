import {z} from 'zod';
import {scientificEmbeddingReceiptSchema} from './research-scientific-search';
const id = z.string().min(1).max(2048);
export const scientificGenerationsRequestSchema = z.object({
  projectId: id, documentId: id, storageProjectId: id.nullable()
}).strict();
export const scientificGenerationActivateSchema = scientificGenerationsRequestSchema.extend({
  generationId: id, expectedActiveId: id
}).strict();
const generation = z.object({
  id, status: z.enum(['building', 'active', 'retired', 'failed', 'cancelled']),
  parseId: id, sourceHash: z.string(), paperIRHash: z.string(), chunkVersion: id,
  embedding: scientificEmbeddingReceiptSchema.nullable(),
  policy: z.object({paragraphTokens: z.number().int(), tableTokens: z.number().int(), algorithmTokens: z.number().int()}).strict(),
  chunkCount: z.number().int().nonnegative(), createdAt: z.string(), publishedAt: z.string().nullable()
}).strict();
export const scientificGenerationsResultSchema = z.object({
  projectId: id, documentId: id, storageProjectId: id.nullable(),
  activeGeneration: id, candidateGeneration: id.nullable(), generations: z.array(generation).max(100)
}).strict();
export type ScientificGenerationsRequest = z.infer<typeof scientificGenerationsRequestSchema>;
export type ScientificGenerationActivate = z.infer<typeof scientificGenerationActivateSchema>;
export type ScientificGenerationsResult = z.infer<typeof scientificGenerationsResultSchema>;
