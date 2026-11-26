import {z} from 'zod';
import {scientificConditionsSchema, scientificFactExtractionSchema, scientificFactProposalSchema,
  scientificIdSchema, scientificExtendedConditionFields, scientificStringConditionFields,
  type ScientificFactProposal, type ScientificSource, type ScientificSourceProposal
} from '../../../shared/schemas/research-scientific-facts';
import {scientificNameTokens, type scientificExtractionInput} from './scientific-extraction-input';
import type {ScientificExtractionBatch} from './scientific-extraction-batches';
import type {ScientificResultEvidenceScope} from './scientific-fact-validator';

const stringFields = scientificStringConditionFields;
const rangeSchema = z.object({sourceId: scientificIdSchema, firstToken: z.number().int().nonnegative(),
  lastToken: z.number().int().nonnegative()}).strict();
const optionalRange = z.union([z.literal('unknown'), rangeSchema]).optional();
const optionalRanges = Object.fromEntries(scientificExtendedConditionFields.map(field => [field, optionalRange])) as
  Record<typeof scientificExtendedConditionFields[number], typeof optionalRange>;
const tokenConditions = z.object({...scientificConditionsSchema.shape,
  datasetVersion: z.union([z.literal('unknown'), rangeSchema]),
  split: z.union([z.literal('unknown'), rangeSchema]), budget: z.union([z.literal('unknown'), rangeSchema]),
  ...optionalRanges,
  other: z.record(z.string().min(1).max(200), rangeSchema)
}).strict();
const tokenProposal = z.object({...scientificFactProposalSchema.shape, conditions: tokenConditions}).strict()
  .refine(value => value.factType !== 'experimental_result' || value.value !== null && value.table !== null,
    'research_scientific_result_cell_required');
const tokenExtraction = z.object({facts: z.array(tokenProposal).max(500)}).strict()
  .refine(value => new Set(value.facts.map(fact => fact.id)).size === value.facts.length,
    'research_scientific_fact_ids_invalid');
type TokenExtraction = z.infer<typeof tokenExtraction>;
type Codec = Pick<ReturnType<typeof scientificExtractionInput>, 'cellHandle'>;
type Report = (path: (string | number)[], message: string) => void;
const sourceKey = (source: unknown): string => source !== null && typeof source === 'object' ?
  JSON.stringify(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) : '';

/** One identity per complete proposal; equal quotes at different locators remain distinct. */
export function scientificFactConditionTokenContract(batch: ScientificExtractionBatch,
  sources: readonly ScientificSource[], scopes: readonly ScientificResultEvidenceScope[]) {
  const inventory = [...new Map(sources.map(source => [sourceKey(source.proposal), source])).values()]
    .map((source, index) => ({sourceId: `condition-source-${index}`, source,
      tokens: scientificNameTokens(source.quote)}));
  const selectable = inventory.filter(item => item.tokens.length > 0);
  const byId = new Map(selectable.map(item => [item.sourceId, item]));
  const wireSource = (proposal: ScientificSourceProposal, codec: Codec): unknown => {
    if (proposal.kind === 'table_cell') return {...proposal, cellId: codec.cellHandle(proposal.tableId, proposal.cellId)};
    if (proposal.kind !== 'text') return proposal;
    const index = batch.blocks.findIndex(block => block.blockId === proposal.blockId &&
      block.start === proposal.start && block.end === proposal.end && block.text === proposal.quote);
    if (index < 0) throw new Error('research_scientific_extraction_condition_input_invalid');
    return {kind: 'text_span', textId: `text-${index}`};
  };
  const numericScopes = scopes.flatMap(scope => scope.rows.map(row => ({
    tableId: scope.tableId, row: row.row,
    allowedSourceIds: selectable.filter(({source: {proposal}}) =>
      proposal.kind === 'table_cell' ? proposal.tableId === scope.tableId && row.conditionCellIds.includes(proposal.cellId) :
      proposal.kind === 'text' && scope.linkedTextRanges.some(range =>
        range.blockId === proposal.blockId && range.start <= proposal.start && range.end >= proposal.end)
    ).map(item => item.sourceId)
  })));
  const allIds = selectable.map(item => item.sourceId);
  const allowedSources = (tableId?: string, row?: number): readonly string[] =>
    tableId === undefined ? allIds : numericScopes.find(scope => scope.tableId === tableId && scope.row === row)?.allowedSourceIds ?? [];
  const conditions = (base: z.ZodObject, ids: readonly string[]): z.ZodObject => {
    // Independent indices keep the inventory linear; source-specific bounds stay host checks.
    const maximum = ids.reduce((maximum, id) => Math.max(maximum, byId.get(id)!.tokens.length - 1), 0);
    const selection = rangeSchema.extend({sourceId: z.enum([...ids]),
      firstToken: rangeSchema.shape.firstToken.max(maximum), lastToken: rangeSchema.shape.lastToken.max(maximum)});
    const fixed = ids.length ? z.union([z.literal('unknown'), selection]) : z.literal('unknown');
    return z.object({...base.shape, datasetVersion: fixed, split: fixed, budget: fixed,
      ...Object.fromEntries(scientificExtendedConditionFields.map(field => [field, fixed.optional()])),
      other: z.record(z.string().min(1).max(200), selection)}).strict();
  };
  const evidence = (codec: Codec, ids: readonly string[]): z.ZodType => {
    const choices = ids.map(id => z.object(Object.fromEntries(Object.entries(
      wireSource(byId.get(id)!.source.proposal, codec) as Record<string, string | number>
    ).map(([key, value]) => [key, z.literal(value)]))).strict());
    return z.array(choices.length ? choices.length === 1 ? choices[0]! : z.union(choices) : z.never()).min(1).max(50);
  };
  const project = (input: unknown, report: Report, codec?: Codec): {facts: ScientificFactProposal[]} | null => {
    // Both callers have parsed their own strict representation before this pure projection.
    const bundle = input as TokenExtraction;
    let failed = false;
    const issue: Report = (path, message) => {failed = true; report(path, message);};
    const facts = bundle.facts.map((fact, index) => {
      const at = ['facts', index];
      const allowed = new Set(allowedSources(fact.table?.tableId, fact.table?.row));
      const proposalKey = (id: string) => {
        const source = byId.get(id)!.source.proposal;
        return sourceKey(codec ? wireSource(source, codec) : source);
      };
      const allowedKeys = new Set([...allowed].map(proposalKey));
      const seen = new Set<string>();
      for (const [ordinal, item] of fact.conditionEvidence.entries()) {
        const signature = JSON.stringify([item.field, item.key]), path = [...at, 'conditionEvidence', ordinal];
        if (seen.has(signature)) issue(path, 'duplicate_condition_evidence');
        seen.add(signature);
        if (item.field === 'other' ? item.key === null || !Object.hasOwn(fact.conditions.other, item.key) :
          item.key !== null) issue(path, 'condition_evidence_key_invalid');
        const value = item.field === 'other' ? fact.conditions.other[item.key ?? ''] : fact.conditions[item.field];
        if (value === null || value === 'unknown' || value === undefined) issue(path, 'unknown_condition_has_evidence');
        if ((item.field === 'other' || stringFields.some(field => field === item.field)) &&
          item.evidence.some(source => !allowedKeys.has(sourceKey(source)))) issue(path, 'condition_source_not_allowed');
      }
      for (const [field, value] of Object.entries(fact.conditions)) {
        if (field === 'other') continue;
        if (value !== undefined && value !== null && value !== 'unknown' && !seen.has(JSON.stringify([field, null]))) {
          issue([...at, 'conditions', field], 'known_condition_evidence_required');
        }
      }
      const read = (selection: z.infer<typeof rangeSchema>, field: string, key: string | null, maximum: number): string => {
        const path = [...at, 'conditions', field, ...(key === null ? [] : [key])];
        const item = byId.get(selection.sourceId);
        if (!item || !allowed.has(selection.sourceId)) {
          issue(path, 'condition_source_not_allowed'); return '';
        }
        const first = item.tokens[selection.firstToken], last = item.tokens[selection.lastToken];
        if (!Number.isInteger(selection.firstToken) || !Number.isInteger(selection.lastToken) ||
          !first || !last || selection.lastToken < selection.firstToken) {
          issue(path, 'condition_token_range_invalid'); return '';
        }
        const matching = fact.conditionEvidence.find(item => item.field === field && item.key === key);
        if (!matching?.evidence.some(source => sourceKey(source) === proposalKey(selection.sourceId))) {
          issue(path, 'condition_selection_evidence_required');
        }
        const text = item.source.quote.slice(first.start, last.end);
        if (text === 'unknown' || text.length < 1 || text.length > maximum) {
          issue(path, 'condition_token_value_invalid');
        }
        return text;
      };
      const fixed = (field: typeof stringFields[number]): string | undefined => {
        const selection = fact.conditions[field];
        return selection === undefined || selection === 'unknown' ? selection : read(selection, field, null, 16000);
      };
      const conditions: ScientificFactProposal['conditions'] = {
        datasetId: fact.conditions.datasetId, metricId: fact.conditions.metricId, baselineId: fact.conditions.baselineId,
        datasetVersion: fixed('datasetVersion')!, split: fixed('split')!, budget: fixed('budget')!,
        other: Object.fromEntries(Object.entries(fact.conditions.other).map(([key, selection]) =>
          [key, read(selection, 'other', key, 2000)]))
      };
      for (const field of scientificExtendedConditionFields) {
        if (fact.conditions[field] !== undefined) conditions[field] = fixed(field);
      }
      return {...fact, conditions};
    });
    return failed ? null : {facts};
  };
  const guardOwnKeys = (input: unknown, ctx: z.RefinementCtx) => {
    if (typeof input === 'object' && input !== null && 'facts' in input && Array.isArray(input.facts)) {
      input.facts.forEach((fact, index) => {
        if (typeof fact !== 'object' || fact === null || !('conditions' in fact)) return;
        const conditions = fact.conditions;
        if (typeof conditions !== 'object' || conditions === null || !('other' in conditions)) return;
        if (conditions.other !== null && typeof conditions.other === 'object' && Object.hasOwn(conditions.other, '__proto__')) {
          ctx.addIssue({code: 'custom', path: ['facts', index, 'conditions', 'other', '__proto__'],
            message: 'condition_key_not_representable'});
        }
      });
    }
    return input;
  };
  const proposalSchema = z.preprocess(guardOwnKeys, tokenExtraction.superRefine((bundle, ctx) => {
    const projected = project(bundle, (path, message) => ctx.addIssue({code: 'custom', path, message}));
    if (!projected) return;
    const parsed = scientificFactExtractionSchema.safeParse(projected);
    if (!parsed.success) parsed.error.issues.forEach(issue => ctx.addIssue({...issue}));
  }));
  return {
    inputChoices: {version: 'roc-scientific-fact-condition-tokens/1',
      sources: selectable.map(item => ({sourceId: item.sourceId,
        evidence: item.source.proposal.kind === 'text' ?
          wireSource(item.source.proposal, {cellHandle: () => {throw new Error('unexpected_cell');}}) : item.source.proposal,
        tokenCount: item.tokens.length, tokens: item.tokens.map((token, index) => [index, token.text])})),
      numericScopes},
    conditions, evidence, allowedSources,
    project: (input: unknown, ctx: z.RefinementCtx, codec: Codec) =>
      project(input, (path, message) => ctx.addIssue({code: 'custom', path, message}), codec),
    proposalSchema,
    decode: (input: unknown): {facts: ScientificFactProposal[]} => {
      const selections = proposalSchema.parse(input);
      const projected = project(selections, () => {});
      if (!projected) throw new Error('research_scientific_extraction_condition_selection_invalid');
      return scientificFactExtractionSchema.parse(projected);
    }
  };
}
export type ScientificFactConditionTokenContract = ReturnType<typeof scientificFactConditionTokenContract>;
