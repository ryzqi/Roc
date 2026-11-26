import {isDeepStrictEqual} from 'node:util';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {paperDeepExtractionSchema, paperDeepKnowledgeSchema,
  type PaperDeepKnowledge, type PaperDeepSelection} from '../../../shared/schemas/research-paper-deep-knowledge';
import type {ScientificSourceProposal} from '../../../shared/schemas/research-scientific-facts';
import {invokeScientificExtraction, type ScientificExtractionSession} from './scientific-extraction-model';
import {assertScientificBatchSources, scientificSourceIsVisible, type ScientificExtractionBatch} from './scientific-extraction-batches';
import {createScientificSourceValidator, scientificKnowledgeId} from './scientific-fact-validator';

type Claim = PaperDeepKnowledge['claims'][number];
const aspects = {
  Equation: ['variables', 'units', 'inputs', 'outputs', 'assumptions', 'referenced_definitions',
    'referenced_equations', 'derivation_steps', 'complexity'],
  Table: ['dataset', 'dataset_version', 'split', 'metric', 'metric_definition', 'baseline', 'units',
    'hardware', 'training_budget', 'inference_budget', 'random_seeds', 'repeats', 'uncertainty'],
  Figure: ['caption', 'body_references'], Algorithm: ['inputs', 'outputs', 'steps', 'complexity']
} as const;
const dimensions = {Equation: 'mathematical_formulation', Table: 'experiments', Figure: 'results', Algorithm: 'algorithm'} as const;

/** Select requested sections/objects only, retaining each selected object's original linked context. */
export function scientificDeepBatches(ir: PaperIRV2, batches: ScientificExtractionBatch[], request: PaperDeepSelection): ScientificExtractionBatch[] {
  const sectionIds = new Set(request.sectionIds), objectIds = new Set(request.objectIds);
  const objects = [...ir.tables, ...ir.figures, ...ir.equations, ...ir.algorithms];
  if (request.sectionIds.some(id => !ir.sections.some(section => section.id === id)) ||
    request.objectIds.some(id => !objects.some(object => object.id === id))) {
    throw new Error('research_scientific_deep_selection_invalid');
  }
  if (!sectionIds.size && !objectIds.size) return batches;
  for (const section of ir.sections) {
    let parent = section.parentId;
    while (parent !== null) {
      if (sectionIds.has(parent)) {sectionIds.add(section.id); break;}
      parent = ir.sections.find(item => item.id === parent)?.parentId ?? null;
    }
  }
  const blockIds = new Set(ir.blocks.filter(block => block.sectionIds.some(id => sectionIds.has(id))).map(block => block.blockId));
  return batches.flatMap(batch => {
    if (batch.objects.length) return batch.objects.some(object => objectIds.has(object.objectId) || blockIds.has(object.blockId)) ? [batch] : [];
    const blocks = batch.blocks.filter(block => blockIds.has(block.blockId));
    return blocks.length ? [{...batch, id: scientificKnowledgeId('deep-batch', [batch.id, blocks]), blocks}] : [];
  });
}

export function initialScientificDeepKnowledge(ir: PaperIRV2, request: PaperDeepSelection,
  batches: ScientificExtractionBatch[]): PaperDeepKnowledge {
  const selected = new Set(batches.flatMap(batch => batch.objects.map(object => object.objectId)));
  const unknown = (dimension: Claim['dimension'], aspect: Claim['aspect'], objectId: string | null): Claim => ({
    id: scientificKnowledgeId('deep-unknown', [dimension, aspect, objectId]), dimension, aspect, objectId,
    provenance: 'unknown', text: 'unknown', evidence: [], scientificApproval: 'unreviewed'
  });
  const claims = request.dimensions.map(dimension => unknown(dimension, 'summary', null));
  for (const object of batches.flatMap(batch => batch.objects)) {
    const dimension = dimensions[object.objectType];
    if (request.dimensions.includes(dimension)) {
      for (const aspect of aspects[object.objectType]) claims.push(unknown(dimension, aspect, object.objectId));
    }
  }
  return paperDeepKnowledgeSchema.parse({version: 1, identity: ir.identity, request, claims, relationships: [],
    objects: {tables: ir.tables.filter(object => selected.has(object.id)), figures: ir.figures.filter(object => selected.has(object.id)),
      equations: ir.equations.filter(object => selected.has(object.id)), algorithms: ir.algorithms.filter(object => selected.has(object.id))},
    status: 'source_validated', scientificApproval: 'unreviewed'});
}

function assertClaim(claim: Claim): void {
  if (claim.provenance === 'unknown' ? claim.text !== 'unknown' || claim.evidence.length !== 0 : claim.evidence.length === 0) {
    throw new Error('research_scientific_deep_provenance_invalid');
  }
  // Raw results are selected exact cells. Explanatory inferences never become new numerical measurements.
  if (claim.aspect === 'raw_result' && (claim.provenance !== 'source_derived' ||
    !claim.evidence.some(source => source.proposal.kind === 'table_cell' && source.proposal.raw === claim.text))) {
    throw new Error('research_scientific_deep_result_cell_required');
  }
}

/** Text-only figure reading has no authority to invent visual measurements, even in a summary. */
function assertFigureClaim(claim: Claim, batches: ScientificExtractionBatch[]): void {
  const figureBatch = batches.some(batch => batch.objects.some(object => object.objectType === 'Figure' &&
    (claim.objectId === object.objectId || claim.evidence.some(source => scientificSourceIsVisible(batch, source.proposal)))));
  if (!figureBatch || claim.provenance === 'unknown') return;
  const quantities = claim.text.match(/[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:[eE][+-]?\d+)?(?:\s*[\p{L}%‰°][\p{L}\d%‰°/^⁻¹²³-]*)?/gu) ?? [];
  if (!quantities.length) return;
  // Numeric model explanations cannot be consumed as new figure measurements. Original numbers need quoted text.
  const text = claim.evidence.filter(source => source.proposal.kind === 'text').map(source => source.quote);
  if (claim.provenance === 'model_inference' || quantities.some(quantity => !text.some(quote => {
    const escaped = quantity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,])`, 'u').test(quote);
  }))) throw new Error('research_scientific_deep_figure_quantity_unsupported');
}

export async function extractScientificDeepKnowledge(session: ScientificExtractionSession, batch: ScientificExtractionBatch,
  ir: PaperIRV2, previous: PaperDeepKnowledge, signal: AbortSignal): Promise<PaperDeepKnowledge> {
  const output = await invokeScientificExtraction(session, 'scientific_deep_reading', paperDeepExtractionSchema,
    'Answer only the requested dimensions/question using this source batch. Distinguish author_stated, source_derived, ' +
    'model_inference and unknown on every claim. Evidence validates source location, never scientific correctness or entailment. ' +
    'Use unknown with text "unknown" and no evidence for missing information; never assume defaults. ' +
    'Equation strategy: preserve original LaTeX externally; explain variables/units, inputs, outputs, assumptions, referenced definitions/equations, ' +
    'locatable derivation_steps and author-stated complexity. Model explanations are model_inference, never proofs. ' +
    'Table strategy: preserve exact result cells, units, dataset/version/split, metric definitions, baseline, hardware, training/inference budget, ' +
    'random seeds, repeats and uncertainty. raw_result must be source_derived and exactly one cited cell raw string. ' +
    'Figure strategy: captions and body references only; no visual observations or invented numerical values. ' +
    'Numeric figure claims must copy quantities and units exactly from cited caption/body text; model_inference figure claims must be qualitative. ' +
    'Method/algorithm strategy: source-addressed contains_component, uses_formula, tests_component and ablates_component relationships; ' +
    'never connect by name similarity. All sources must be present in the batch. Use unique local ids.',
    {batch, request: previous.request, objectAspects: aspects}, signal);
  const reader = createScientificSourceValidator(ir), read = (source: ScientificSourceProposal) => reader.read(source);
  const claims = output.claims.map((claim, ordinal): Claim => {
    assertScientificBatchSources(batch, claim.evidence, ir);
    if (!previous.request.dimensions.includes(claim.dimension) || claim.objectId !== null &&
      !batch.objects.some(object => object.objectId === claim.objectId)) throw new Error('research_scientific_deep_selection_invalid');
    const result: Claim = {...claim, id: scientificKnowledgeId('deep-claim', [batch.id, ordinal, claim.id]),
      evidence: claim.evidence.map(read), scientificApproval: 'unreviewed'};
    assertClaim(result); assertFigureClaim(result, [batch]);
    return result;
  });
  const relationships = output.relationships.map((relation, ordinal) => {
    assertScientificBatchSources(batch, [relation.from, relation.to, ...relation.evidence], ir);
    if (relation.type === 'uses_formula' && (relation.to.kind !== 'object' || relation.to.objectType !== 'Equation')) {
      throw new Error('research_scientific_deep_relationship_invalid');
    }
    return {...relation, id: scientificKnowledgeId('deep-relation', [batch.id, ordinal, relation.id]),
      from: read(relation.from), to: read(relation.to), evidence: relation.evidence.map(read), scientificApproval: 'unreviewed' as const};
  });
  return mergeScientificDeepClaims(previous, claims, relationships);
}

export function mergeScientificDeepClaims(previous: PaperDeepKnowledge, claims: PaperDeepKnowledge['claims'],
  relationships: PaperDeepKnowledge['relationships']): PaperDeepKnowledge {
  const covered = new Set(claims.filter(claim => claim.provenance !== 'unknown')
    .map(claim => JSON.stringify([claim.dimension, claim.aspect, claim.objectId])));
  for (const claim of claims) {
    if (claim.provenance !== 'unknown' && claim.aspect === 'summary') {
      covered.add(JSON.stringify([claim.dimension, 'summary', null]));
    }
  }
  const retained = previous.claims.filter(claim => claim.provenance !== 'unknown' ||
    !covered.has(JSON.stringify([claim.dimension, claim.aspect, claim.objectId])));
  return paperDeepKnowledgeSchema.parse({...previous, claims: [...retained, ...claims],
    relationships: [...previous.relationships, ...relationships]});
}

/** Revalidate persisted explanations against immutable sources and the requested selection before reuse/publication. */
export function validateScientificDeepKnowledge(input: PaperDeepKnowledge, ir: PaperIRV2, request: PaperDeepSelection,
  batches: ScientificExtractionBatch[]): PaperDeepKnowledge {
  const deep = paperDeepKnowledgeSchema.parse(input), expected = initialScientificDeepKnowledge(ir, request, batches);
  if (!isDeepStrictEqual(deep.identity, ir.identity) || !isDeepStrictEqual(deep.request, request) ||
    !isDeepStrictEqual(deep.objects, expected.objects) || deep.status !== 'source_validated' ||
    new Set(deep.claims.map(claim => claim.id)).size !== deep.claims.length ||
    new Set(deep.relationships.map(relation => relation.id)).size !== deep.relationships.length) {
    throw new Error('research_scientific_deep_source_invalid');
  }
  const reader = createScientificSourceValidator(ir);
  const source = (sources: Claim['evidence']): void => {
    reader.assertCurrent(sources);
    if (sources.some(item => !batches.some(batch => scientificSourceIsVisible(batch, item.proposal)))) {
      throw new Error('research_scientific_deep_selection_invalid');
    }
  };
  const objects = new Set(batches.flatMap(batch => batch.objects.map(object => object.objectId)));
  for (const claim of deep.claims) {
    assertClaim(claim); assertFigureClaim(claim, batches); source(claim.evidence);
    if (!request.dimensions.includes(claim.dimension) || claim.objectId !== null && !objects.has(claim.objectId)) {
      throw new Error('research_scientific_deep_selection_invalid');
    }
  }
  for (const relation of deep.relationships) {
    source([relation.from, relation.to, ...relation.evidence]);
    if (relation.type === 'uses_formula' && (relation.to.proposal.kind !== 'object' || relation.to.proposal.objectType !== 'Equation')) {
      throw new Error('research_scientific_deep_relationship_invalid');
    }
  }
  return deep;
}
