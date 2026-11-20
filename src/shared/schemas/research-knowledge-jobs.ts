import {z} from 'zod';

export const knowledgeJobSchema = z.object({
  documentId: z.string(), generation: z.string(), title: z.string(),
  status: z.enum(['queued', 'running', 'blocked', 'failed', 'ready']),
  attempts: z.number().int().nonnegative(), error: z.string().nullable(), updatedAt: z.string()
}).strict();
export const knowledgeJobsListSchema = z.object({projectId: z.string().nullable(),
  offset: z.number().int().min(0).default(0)}).strict();
export const knowledgeJobRetrySchema = z.object({documentId: z.string().min(1), generation: z.string().min(1)}).strict();
export type KnowledgeJob = z.infer<typeof knowledgeJobSchema>;
