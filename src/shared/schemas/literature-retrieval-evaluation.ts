import {z} from 'zod';
import {literatureSearchPoolSchema} from './literature-search-pool';

const evidence = z.object({reference: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const annotation = z.object({
  method: z.literal('independent_human'), blindToRanking: z.literal(true),
  reviewerIds: z.array(z.string().min(1)).min(2), producerIds: z.array(z.string().min(1)).min(1),
  evidence
}).strict();
const query = z.object({
  queryId: z.string().min(1), topicId: z.string().min(1), pool: literatureSearchPoolSchema,
  papers: z.array(z.object({
    paperId: z.string().min(1), grade: z.number().int().min(0).max(3),
    recordHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)), evidenceRefs: z.array(z.string().min(1)).min(1)
  }).strict()).min(1)
}).strict();
const corpus = z.object({
  schemaVersion: z.literal(1), corpusId: z.string().min(1), minimumTopics: z.number().int().positive(),
  queries: z.array(query).min(1)
}).strict();
export const literatureRetrievalCaptureSetSchema = corpus.extend({
  queries: z.array(query.omit({papers: true})).min(1)
});
export const literatureRetrievalEvaluationSchema = z.discriminatedUnion('kind', [
  corpus.extend({kind: z.literal('engineering_fixture'), annotation: z.null()}),
  corpus.extend({kind: z.literal('human_reviewed'), annotation})
]);
