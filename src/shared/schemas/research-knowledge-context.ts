import {z} from 'zod';

export const knowledgeContextRequestSchema = z.object({
  projectId: z.string().min(1), chunkId: z.string().min(1),
  expectedIndexedVersion: z.string().regex(/^[a-f0-9]{64}$/u),
  maxChars: z.number().int().min(200).max(8000).default(6000),
  neighbors: z.boolean().default(true)
}).strict();
const context = z.object({
  chunkId: z.string(), parentChunkId: z.string(), content: z.string(), locator: z.string().nullable(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(), indexedVersion: z.string()
}).strict();
export const knowledgeContextResultSchema = z.object({
  derived: z.literal(false), context, neighbors: z.array(context).max(2)
}).strict();
export type KnowledgeContextRequest = z.infer<typeof knowledgeContextRequestSchema>;
