import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {wikiExplanationDraftSchema, wikiScientificExplanationSchema, wikiSectionInputSchema,
  type WikiScientificExplanation, type WikiExplanationDraft, type WikiSection} from '../../../shared/schemas/research-wiki-pages';
import {scientificSourceRefSchema, type ScientificSourceRef} from '../../../shared/schemas/research-scientific-source-ref';
import type {ScientificSource} from '../../../shared/schemas/research-scientific-facts';
import {scientificStatementKey, scientificWikiRegistry, scientificWikiSection, type ScientificWikiBasis,
  type ScientificWikiEntry} from './wiki-scientific-synthesis';
import {checkScientificComparison} from './wiki-scientific-comparison';

export const wikiExplanationOutputSchema = z.object({sections: z.array(z.object({
  id: wikiSectionInputSchema.shape.id, statements: z.array(wikiExplanationDraftSchema).min(1).max(8)
}).strict()).min(1).max(3)}).strict();
export const wikiSemanticReviewSchema = z.object({reviews: z.array(z.object({
  sectionId: wikiSectionInputSchema.shape.id, statementIndex: z.number().int().min(0).max(7),
  support: z.enum(['supported', 'unsupported', 'uncertain'])
}).strict()).max(24)}).strict();
export type WikiSemanticReview = z.infer<typeof wikiSemanticReviewSchema>['reviews'][number];
const labels = {source_statement: '原文陈述', paraphrase: '综合解释', comparison: '条件对齐比较', inference: '模型推断'};

const evidence = (entry: ScientificWikiEntry): ScientificSource[] => entry.kind === 'object' ? [] : [
  ...entry.value.evidence, ...(entry.kind === 'fact' ? [
    ...entry.value.conditionEvidence.flatMap(item => item.evidence), ...(entry.value.value?.unitEvidence ?? [])
  ] : [])
];
function quotes(entry: ScientificWikiEntry): string[] {
  if (entry.kind !== 'object') return evidence(entry).map(source => source.quote).filter(Boolean);
  const value = entry.value;
  return 'data' in value && 'rawLatex' in value.data ? [value.data.rawLatex ?? ''] :
    'data' in value && 'captions' in value.data ? value.data.captions.map(item => item.evidence.text) :
    'text' in value ? [value.text] : [];
}
function sourceRefs(entry: ScientificWikiEntry, basis: ScientificWikiBasis): ScientificSourceRef[] {
  const read = basis.knowledge.find(value => value.documentId === entry.ref.source.documentId)!;
  const receipt = read.publishedJob!.snapshot.source;
  const sources = entry.kind === 'object' ? [{locator: entry.value.sourceLocator,
    type: entry.ref.objectType.toLowerCase()}] : evidence(entry).flatMap(source => {
    if (!source.locator || source.proposal.kind === 'metadata') return [];
    return [{locator: source.locator, type: source.proposal.kind === 'text' ? 'block' :
      source.proposal.kind === 'table_cell' ? 'table_cell' : source.proposal.objectType.toLowerCase()}];
  });
  return sources.map(({locator, type}) => scientificSourceRefSchema.parse({...receipt.paperIR.identity,
    paperIrHash: receipt.paperIR.sha256, generationId: receipt.generationId,
    objectId: locator.objectId, objectType: type, locator}));
}
function selectedEntries(draft: WikiExplanationDraft, basis: ScientificWikiBasis): ScientificWikiEntry[] {
  const registry = scientificWikiRegistry(basis), seen = new Set<string>();
  return draft.references.map(ref => {
    if (ref.kind === 'unknown') throw new Error('wiki_explanation_evidence_required');
    const key = scientificStatementKey(ref), entry = registry.get(key);
    if (!entry || seen.has(key)) throw new Error('wiki_scientific_reference_invalid');
    seen.add(key); return entry;
  });
}

const numericPattern = /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?/gu;
// These grammatical continuations are prose, not a quantity suffix. Other adjacent labels are
// conservatively bound to their original number, including units unknown to the application.
const numericContinuations = new Set(['and', 'or', 'is', 'are', 'was', 'were', 'with', 'without', 'of',
  'for', 'in', 'on', 'at', 'to', 'from', 'as', 'by', 'than', 'versus', 'vs']);
function numericProofs(text: string): {values: string[]; quantities: string[]} {
  const values: string[] = [], quantities: string[] = [];
  for (const match of text.matchAll(numericPattern)) {
    const value = match[0]; values.push(value);
    // Do not bind a value to the first word in a separate quote/table cell on the next line.
    const suffix = /^[\t \u00a0\u202f]*([\p{L}%‰°][\p{L}\p{M}\p{N}%‰°]*(?:[/*·^−-][\p{L}\p{M}\p{N}%‰°+-]+)*)/u
      .exec(text.slice(match.index + value.length))?.[1];
    if (suffix && !numericContinuations.has(suffix.toLowerCase())) quantities.push(`${value}:${suffix}`);
  }
  return {values, quantities};
}

/** Only verified publication values enter these proofs. Model verdicts never grant scientific approval. */
export function validateWikiExplanation(draft: WikiExplanationDraft, basis: ScientificWikiBasis,
  semanticSupport: WikiScientificExplanation['statements'][number]['semanticSupport'] = 'not_checked'):
  WikiScientificExplanation['statements'][number] {
  const parsed = wikiExplanationDraftSchema.parse(draft), entries = selectedEntries(parsed, basis);
  const originals = entries.flatMap(quotes);
  if (parsed.kind === 'source_statement' && !originals.some(text => text.includes(parsed.text))) {
    throw new Error('wiki_explanation_quote_invalid');
  }
  const facts = entries.filter((entry): entry is Extract<ScientificWikiEntry, {kind: 'fact'}> => entry.kind === 'fact');
  const originalText = [...originals, ...facts.flatMap(entry => [entry.value.value?.raw ?? '',
    entry.value.value?.rawUnit ? `${entry.value.value.raw} ${entry.value.value.rawUnit}` : '',
    ...Object.values(entry.value.conditions).flatMap(value => typeof value === 'string' ? [value] : [])])].join('\n');
  const originalsProof = numericProofs(originalText), proposedProof = numericProofs(parsed.text);
  const allowedValues = new Set(originalsProof.values), allowedQuantities = new Set(originalsProof.quantities);
  if (proposedProof.values.some(value => !allowedValues.has(value)) ||
      proposedProof.quantities.some(quantity => !allowedQuantities.has(quantity))) throw new Error('wiki_explanation_numeric_invalid');
  if (parsed.kind === 'comparison') {
    const results = facts.filter(entry => entry.value.factType === 'experimental_result');
    const columns = results.map(entry => ({source: entry.ref.source, fact: entry.value,
      entities: basis.knowledge.find(read => read.documentId === entry.ref.source.documentId)!.knowledge!.entities}));
    if (checkScientificComparison(columns, results.map(entry => entry.ref.source)).status !== 'conditions_match') {
      throw new Error('wiki_explanation_conditions_not_comparable');
    }
  }
  const refs = [...new Map(entries.flatMap(entry => sourceRefs(entry, basis)).map(ref => [JSON.stringify(ref), ref])).values()];
  if (!refs.length) throw new Error('wiki_explanation_original_locator_required');
  return {...parsed, sourceRefs: refs, validation: parsed.kind === 'source_statement' ? 'source_validated' : 'review_required',
    semanticSupport, scientificApproval: 'unreviewed'};
}

export function explainedWikiSection(target: Pick<WikiSection, 'id' | 'title'>,
  explanation: WikiScientificExplanation, basis: ScientificWikiBasis): z.infer<typeof wikiSectionInputSchema> {
  const parsed = wikiScientificExplanationSchema.parse(explanation);
  const validated = parsed.statements.map(statement => validateWikiExplanation({text: statement.text,
    kind: statement.kind, references: statement.references}, basis, statement.semanticSupport));
  if (!isDeepStrictEqual(validated, parsed.statements)) throw new Error('wiki_explanation_validation_invalid');
  const refs = [...new Map(validated.flatMap(statement => statement.references).map(ref =>
    [ref.kind === 'unknown' ? 'unknown' : scientificStatementKey(ref), ref])).values()];
  const original = scientificWikiSection(target, refs, basis);
  // Full factual values and conditions remain host-owned, including when prose contains only a paraphrase.
  const body = [validated.map(statement => `${labels[statement.kind]} · ${statement.validation === 'source_validated' ? '来源已核对' : '待人工核验'}\n${statement.text}\n语义支持建议：${statement.semanticSupport}`).join('\n\n'),
    ...(parsed.unresolvedQuestions.length ? [`未解决问题：\n${parsed.unresolvedQuestions.join('\n')}`] : []), original.body].join('\n\n');
  if (body.length > 6000) throw new Error('wiki_scientific_section_budget');
  return wikiSectionInputSchema.parse({...original, body, scientificExplanation: {...parsed, statements: validated}});
}
