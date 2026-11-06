import {z} from 'zod';
import {researchTaskRequestSchema, researchExecutionKindSchema, researchTaskSchema} from './research-tasks';

const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const taskFactSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('user'), locator: z.string().trim().min(1).max(512)}),
  z.strictObject({kind: z.literal('artifact'), artifactId: id, version: hash}),
  z.strictObject({kind: z.literal('document'), documentId: id, sourceHash: hash, parseId: id.nullable()}),
  z.strictObject({kind: z.literal('execution'), executionKind: researchExecutionKindSchema, executionId: id, manifestHash: hash})
]);
export const taskFactSchema = z.strictObject({
  id, kind: z.enum(['constraint', 'source_version', 'human_decision', 'hypothesis', 'todo', 'counterevidence', 'evaluation_condition', 'correction']),
  content: z.string().trim().min(1).max(2000),
  state: z.enum(['active', 'resolved', 'superseded']),
  sources: taskFactSourceSchema.array().min(1).max(8)
});
const entries = taskFactSchema.array().max(100).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'task_fact_ids_unique')
  .refine(rows => JSON.stringify(rows).length <= 32_000, 'task_facts_context_limit');
export const taskFactsSaveSchema = researchTaskRequestSchema.extend({expectedRevision: z.number().int().nonnegative(), entries}).strict();
export const taskFactsSnapshotSchema = researchTaskRequestSchema.extend({
  contractVersion: z.literal(1), revision: z.number().int().positive(), entries, createdAt: z.iso.datetime(),
  savedBy: z.strictObject({kind: z.literal('user'), id}), snapshotHash: hash
}).strict();
export const taskFactsViewSchema = z.strictObject({
  snapshot: taskFactsSnapshotSchema.nullable(),
  freshness: z.array(z.strictObject({entryId: id, sourceIndex: z.number().int().nonnegative(),
    state: z.enum(['current', 'expired']), reason: z.string().nullable()})),
  authority: z.literal('research_data_only')
});
export const taskFactsHistoryRequestSchema = researchTaskRequestSchema.extend({
  beforeRevision: z.number().int().positive().nullable(), limit: z.number().int().min(1).max(50)
}).strict();
export const taskFactsHistorySchema = z.strictObject({
  snapshots: taskFactsSnapshotSchema.array(), nextRevision: z.number().int().positive().nullable(), hasMore: z.boolean()
});
export type TaskFactSource = z.infer<typeof taskFactSourceSchema>;
export type TaskFactsSnapshot = z.infer<typeof taskFactsSnapshotSchema>;
export type TaskFactsView = z.infer<typeof taskFactsViewSchema>;
export type TaskFactsSave = z.infer<typeof taskFactsSaveSchema>;
export const researchTaskContextSchema = z.strictObject({task: researchTaskSchema, facts: taskFactsViewSchema});
export type ResearchTaskContext = z.infer<typeof researchTaskContextSchema>;
