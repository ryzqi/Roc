import { z } from 'zod';
import { literatureSearchToolSchema } from './literature-import';

const term = z.string().trim().min(1).max(200);
export const researchSearchPlanSchema = z.object({
  researchQuestion: z.string().trim().min(1).max(10000),
  refinedQuestion: z.string().trim().min(1).max(2000),
  keywords: z.array(term).min(1).max(20),
  synonyms: z.array(z.object({term, alternatives: z.array(term).min(1).max(10)}).strict()).max(20),
  domain: z.string().trim().min(1).max(500),
  excludedTerms: z.array(term).max(20),
  queries: z.array(literatureSearchToolSchema).min(1).max(3)
}).strict().refine(plan => plan.queries.reduce((total, query) => total + query.limit, 0) <= 60, 'research_search_plan_candidate_budget_exceeded');

export type ResearchSearchPlan = z.infer<typeof researchSearchPlanSchema>;
