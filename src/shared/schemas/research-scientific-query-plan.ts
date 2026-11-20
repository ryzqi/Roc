import {z} from 'zod';
import {scientificBlockRoleSchema} from './research-paper-structure';

export const scientificQueryPlannerVersion = 'roc-scientific-query-plan/1';
export const scientificQueryIntentSchema = z.enum([
  'overview', 'method', 'equation', 'table', 'figure', 'experiment', 'results', 'comparison', 'citation', 'cross_paper'
]);
export const scientificRetrievalChannelSchema = z.enum(['text', 'metadata', 'table', 'equation', 'figure', 'citation']);
const strings = z.array(z.string().min(1).max(500)).max(1000);
export const scientificQuerySpanSchema = z.object({
  text: z.string().min(1).max(500), start: z.number().int().nonnegative(), end: z.number().int().positive()
}).strict();
export const scientificQuerySupplementSchema = z.object({
  intents: z.array(scientificQueryIntentSchema).max(10),
  documentIds: strings,
  datasets: z.array(scientificQuerySpanSchema).max(20),
  metrics: z.array(scientificQuerySpanSchema).max(20),
  sectionRoles: z.array(scientificBlockRoleSchema).max(9)
}).strict();
export const scientificQueryPlanSchema = z.object({
  version: z.literal(scientificQueryPlannerVersion),
  query: z.string().trim().min(1).max(4000),
  intents: z.array(scientificQueryIntentSchema).min(1).max(10),
  scope: z.object({
    projectId: z.string().min(1).nullable(),
    // An unresolved explicit identifier is "none"; an empty list never implicitly means all papers.
    selection: z.enum(['all', 'selected', 'none']),
    documentIds: strings, paperIds: strings
  }).strict(),
  filters: z.object({
    dois: strings, datasets: strings, metrics: strings,
    years: z.array(z.number().int().min(1800).max(2199)).max(100),
    sectionRoles: z.array(scientificBlockRoleSchema).max(9)
  }).strict(),
  objects: z.object({tableNumbers: strings, figureNumbers: strings, equationNumbers: strings}).strict(),
  retrievalChannels: z.array(scientificRetrievalChannelSchema).min(1).max(6),
  requiresEvidenceChain: z.boolean(),
  observation: z.object({
    ruleIntents: z.array(scientificQueryIntentSchema).max(10),
    unresolvedIdentifiers: strings,
    supplement: z.enum(['not_needed', 'unavailable', 'budget_exceeded', 'succeeded', 'invalid', 'failed', 'timed_out']),
    calls: z.number().int().min(0).max(1),
    providerId: z.string().min(1).max(300).nullable(), modelId: z.string().min(1).max(300).nullable()
  }).strict()
}).strict().superRefine((plan, ctx) => {
  const scope = plan.scope;
  if ((scope.selection === 'none') !== (scope.documentIds.length === 0) ||
    scope.documentIds.length !== scope.paperIds.length ||
    new Set(scope.documentIds).size !== scope.documentIds.length ||
    new Set(plan.intents).size !== plan.intents.length ||
    new Set(plan.retrievalChannels).size !== plan.retrievalChannels.length ||
    (['succeeded', 'invalid', 'failed', 'timed_out'].includes(plan.observation.supplement)) !== (plan.observation.calls === 1) ||
    (plan.observation.supplement === 'succeeded') !== (plan.observation.providerId !== null && plan.observation.modelId !== null)) {
    ctx.addIssue({code: 'custom', message: 'research_scientific_plan_invalid'});
  }
});
export type ScientificQueryPlan = z.infer<typeof scientificQueryPlanSchema>;
export type ScientificQueryIntent = z.infer<typeof scientificQueryIntentSchema>;
export type ScientificRetrievalChannel = z.infer<typeof scientificRetrievalChannelSchema>;
