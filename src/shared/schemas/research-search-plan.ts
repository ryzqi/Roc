import { z } from 'zod';
import { literatureSearchToolSchema } from './literature-import';

const term = z.string().trim().min(1).max(200);
export const researchQueryIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const querySchema = literatureSearchToolSchema.safeExtend({
  id: researchQueryIdSchema
}).refine(query => new Set(query.sources).size === query.sources.length, 'research_search_query_sources_invalid');
export const researchSearchPlanSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  researchQuestion: z.string().trim().min(1).max(10000),
  refinedQuestion: z.string().trim().min(1).max(2000),
  keywords: z.array(term).min(1).max(20),
  synonyms: z.array(z.object({term, alternatives: z.array(term).min(1).max(10)}).strict()).max(20),
  domain: z.string().trim().min(1).max(500),
  excludedTerms: z.array(term).max(20),
  queries: z.array(querySchema).min(1),
  perspectives: z.array(z.object({
    id: researchQueryIdSchema, label: term, rationale: z.string().trim().min(1).max(2000),
    expectedEvidence: z.string().trim().min(1).max(1000),
    queryIds: z.array(researchQueryIdSchema).min(1)
  }).strict()).min(1).max(6),
}).strict().superRefine((plan, ctx) => {
  const fail = (message: string) => ctx.addIssue({code: 'custom', message});
  const ids = new Set(plan.queries.map(query => query.id));
  if (ids.size !== plan.queries.length || new Set(plan.perspectives.map(view => view.id)).size !== plan.perspectives.length) {
    fail('research_search_plan_duplicate_id');
  }
  const referenced = new Set<string>();
  for (const view of plan.perspectives) {
    if (new Set(view.queryIds).size !== view.queryIds.length || view.queryIds.some(id => !ids.has(id))) {
      fail('research_search_plan_query_reference_invalid');
    }
    view.queryIds.forEach(id => referenced.add(id));
  }
  if (plan.queries.some(query => !referenced.has(query.id))) fail('research_search_plan_unexplained_query');
});

export type ResearchSearchPlan = z.infer<typeof researchSearchPlanSchema>;
