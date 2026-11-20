import {createHash} from 'node:crypto';
import {z} from 'zod';
import {paperAcquisitionReceiptSchema} from '../../../shared/schemas/literature-acquisition';

const id = z.string().min(1);
const sample = z.object({
  paperId: id, topicId: id, expectedOpenAccess: z.boolean().nullable(),
  startedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  discovered: z.boolean(), receipt: paperAcquisitionReceiptSchema.nullable(),
  parsed: z.boolean().nullable(), indexed: z.boolean().nullable(), wiki: z.boolean().nullable(),
  readyAt: z.iso.datetime().nullable(),
  recovery: z.object({incident: z.enum(['interruption', 'rate_limit', 'restart']), recovered: z.boolean().nullable()}).strict().nullable(),
  failures: z.array(z.object({provider: id, code: id}).strict())
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({code: 'custom', message: 'literature_acquisition_evidence_inconsistent'});
  const start = Date.parse(value.startedAt), end = Date.parse(value.observedAt);
  if (end < start || value.receipt !== null && !value.discovered ||
    value.parsed === true && value.receipt === null || value.indexed === true && value.parsed !== true ||
    value.wiki === true && value.indexed !== true) invalid();
  if (value.readyAt !== null && (value.parsed !== true || value.indexed !== true || value.wiki !== true ||
    Date.parse(value.readyAt) < start || Date.parse(value.readyAt) > end)) invalid();
  if (value.parsed === true && value.indexed === true && value.wiki === true && value.readyAt === null) invalid();
});
export const literatureAcquisitionEvaluationSchema = z.object({
  schemaVersion: z.literal(1), corpusId: id, expectedPaperIds: z.array(id).min(1),
  environment: z.enum(['public_network', 'engineering_fixture', 'application_export']),
  samples: z.array(sample).min(1)
}).strict();
export type LiteratureAcquisitionEvaluation = z.infer<typeof literatureAcquisitionEvaluationSchema>;

/** Keep failed/unknown papers in the frozen denominator and expose unmeasured stages. */
export function evaluateLiteratureAcquisition(input: unknown) {
  const corpus = literatureAcquisitionEvaluationSchema.parse(input);
  const expected = new Set(corpus.expectedPaperIds), actual = new Set(corpus.samples.map(value => value.paperId));
  if (expected.size !== corpus.expectedPaperIds.length || actual.size !== corpus.samples.length ||
    actual.size !== expected.size || [...actual].some(id => !expected.has(id))) throw new Error('literature_acquisition_denominator_changed');
  const rate = (numerator: number, denominator: number) => ({numerator, denominator, rate: denominator === 0 ? null : numerator / denominator});
  const metrics = (values: typeof corpus.samples) => {
    const ready = values.filter(value => value.readyAt !== null);
    const completion = ready.map(value => Date.parse(value.readyAt!) - Date.parse(value.startedAt)).sort((a, b) => a - b);
    const observed = values.filter(value => value.parsed !== null && value.indexed !== null && value.wiki !== null);
    const recovery = values.filter(value => value.recovery !== null);
    return {
      discovery: rate(values.filter(value => value.discovered).length, values.length),
      verifiedPdf: rate(values.filter(value => value.receipt !== null).length, values.length),
      endToEndReady: {...rate(ready.length, values.length), fullyObserved: observed.length,
        completeMeasurement: observed.length === values.length},
      completionTime: {p95Ms: completion.length ? completion[Math.ceil(completion.length * 0.95) - 1] : null,
        completed: completion.length, censored: values.length - completion.length, population: 'completed_only' as const},
      recovery: {...rate(recovery.filter(value => value.recovery?.recovered === true).length, recovery.length),
        unknown: recovery.filter(value => value.recovery?.recovered === null).length}
    };
  };
  return {schemaVersion: 1, corpusId: corpus.corpusId, environment: corpus.environment,
    evidenceHash: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    allPapers: metrics(corpus.samples), declaredOpenAccess: metrics(corpus.samples.filter(value => value.expectedOpenAccess === true)),
    topics: [...new Set(corpus.samples.map(value => value.topicId))].map(topicId => ({
      topicId, ...metrics(corpus.samples.filter(value => value.topicId === topicId))
    })), failures: corpus.samples.flatMap(value => value.failures.map(failure => ({paperId: value.paperId, ...failure})))};
}
