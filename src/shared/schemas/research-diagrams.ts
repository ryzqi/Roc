import {z} from 'zod';
export const researchDiagramRequestSchema = z.object({projectId: z.string().min(1), path: z.string().min(1).max(1000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()}).strict();
export const researchDiagramResultSchema = z.object({id: z.string(), directory: z.string(), sourceHash: z.string(), renderer: z.string(),
  files: z.array(z.object({path: z.string(), sha256: z.string(), size: z.number()})), limitations: z.array(z.string())}).strict();
export type ResearchDiagramRequest = z.infer<typeof researchDiagramRequestSchema>;
