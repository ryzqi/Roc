import { z } from 'zod';

import { researchProjectLanguageSchema, researchProjectSchema } from './research';

const identifier = z.string().trim().min(1);
const evidenceIds = z.array(identifier).max(100).refine((ids) => new Set(ids).size === ids.length, 'Evidence IDs must be unique.');
const text = z.string().trim().min(1).max(20000);
const optionalText = z.string().trim().max(20000);

export const researchIdeaFieldKeySchema = z.enum([
  'problem',
  'hypothesis',
  'novelty',
  'supportingEvidence',
  'counterevidence',
  'experiment',
  'risks'
]);

export const researchIdeaPrioritySchema = z.enum(['high', 'medium', 'low']);

export const researchIdeaFieldSchema = z.object({
  key: researchIdeaFieldKeySchema,
  content: z.string().trim().max(20000),
  status: z.enum(['supported', 'hypothesis', 'pending']),
  evidenceIds
}).strict();

export const researchIdeaCanvasSchema = z.object({
  artifactId: identifier,
  projectId: identifier,
  version: z.number().int().positive(),
  problem: text,
  hypothesis: text,
  novelty: text,
  supportingEvidence: optionalText,
  counterevidence: optionalText,
  experiment: text,
  risks: text,
  priority: researchIdeaPrioritySchema,
  rationale: text,
  fields: z.array(researchIdeaFieldSchema).length(7),
  contentHash: identifier,
  createdAt: identifier,
  updatedAt: identifier
}).strict();

export const researchIdeaCanvasContentSchema = z.object({
  problem: text,
  hypothesis: text,
  novelty: text,
  supportingEvidence: optionalText,
  counterevidence: optionalText,
  experiment: text,
  risks: text,
  priority: researchIdeaPrioritySchema,
  rationale: text,
  fields: z.array(researchIdeaFieldSchema).length(7)
}).strict();

export const researchIdeaCanvasSaveRequestSchema = researchIdeaCanvasContentSchema.extend({
  artifactId: identifier,
  expectedVersion: z.number().int().positive().nullable()
}).strict().superRefine((request, context) => {
  const expected = {
    problem: request.problem,
    hypothesis: request.hypothesis,
    novelty: request.novelty,
    supportingEvidence: request.supportingEvidence,
    counterevidence: request.counterevidence,
    experiment: request.experiment,
    risks: request.risks
  };
  const keys = new Set<string>();
  for (const field of request.fields) {
    if (keys.has(field.key)) {
      context.addIssue({ code: 'custom', message: 'Idea Canvas fields must be unique.', path: ['fields'] });
      return;
    }
    keys.add(field.key);
    if (field.content !== expected[field.key]) {
      context.addIssue({ code: 'custom', message: 'Idea Canvas field content must match the named section.', path: ['fields'] });
      return;
    }
  }
  for (const key of Object.keys(expected)) {
    if (!keys.has(key)) {
      context.addIssue({ code: 'custom', message: 'Idea Canvas is missing a required field.', path: ['fields'] });
      return;
    }
  }
});

export const researchIdeaCanvasGetRequestSchema = z.object({ artifactId: identifier }).strict();
export const researchIdeaCanvasHistoryRequestSchema = z.object({ artifactId: identifier }).strict();

export const researchIdeaPromoteRequestSchema = z.object({
  artifactId: identifier,
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
  workspacePath: z.string().trim().min(1).nullable().optional(),
  language: researchProjectLanguageSchema.optional()
}).strict();

export const researchIdeaPromotionSchema = z.object({
  canvas: researchIdeaCanvasSchema,
  project: researchProjectSchema
}).strict();
