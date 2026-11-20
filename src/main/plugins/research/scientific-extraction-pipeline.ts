import {isDeepStrictEqual} from 'node:util';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {scientificKnowledgeCandidatesSchema, type ScientificExtractionSnapshot, type ScientificKnowledgeCandidates,
  type ScientificKnowledgeBundle} from '../../../shared/schemas/research-scientific-extraction';
import {buildScientificExtractionBatches, scientificSourceIsVisible, type ScientificExtractionBatch} from './scientific-extraction-batches';
import {extractScientificEntities, scientificMetadataEntity} from './scientific-entity-extractor';
import {extractScientificFacts} from './scientific-fact-extractor';
import {extractScientificRelations} from './scientific-relation-extractor';
import type {ScientificExtractionSession} from './scientific-extraction-model';
import {validateScientificKnowledgeCandidates} from './scientific-extraction-repository';
import {scientificSourceMentions} from './scientific-fact-validator';

export type ScientificExtractionStage = 'entities' | 'facts' | 'relations';
export type ScientificExtractionResult = {candidates: ScientificKnowledgeCandidates; knowledge: ScientificKnowledgeBundle; batches: number; calls: number};

/** Three bounded transformations, followed by source validation. Persistence/publication has a separate owner. */
export async function runScientificExtraction(input: {
  session: ScientificExtractionSession; snapshot: ScientificExtractionSnapshot; generationId: string; ir: PaperIRV2;
  signal: AbortSignal; assertCurrent?: () => Promise<void>;
  observe?: (stage: ScientificExtractionStage, batch: ScientificExtractionBatch,
    operation: () => Promise<void>) => Promise<void>;
}): Promise<ScientificExtractionResult> {
  const {session, snapshot, generationId, signal} = input, ir = structuredClone(input.ir);
  if (!isDeepStrictEqual(session.config, snapshot.config)) throw new Error('research_scientific_extraction_input_changed');
  const batches = buildScientificExtractionBatches(ir, session.config);
  const candidates: ScientificKnowledgeCandidates = {entities: [scientificMetadataEntity(ir)], facts: [], relations: []};
  let calls = 0;
  const validate = (): ScientificKnowledgeBundle => validateScientificKnowledgeCandidates(candidates, snapshot, generationId, ir);
  const current = async (): Promise<void> => {signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted();};
  const run = async (stage: ScientificExtractionStage, batch: ScientificExtractionBatch, operation: () => Promise<void>): Promise<void> => {
    await current();
    const invoke = async (): Promise<void> => {calls++; await operation(); await current(); validate();};
    if (input.observe) await input.observe(stage, batch, invoke); else await invoke();
  };
  const relevant = (batch: ScientificExtractionBatch) => candidates.entities.filter(entity =>
    entity.entityType === 'Paper' || entity.evidence.some(source => scientificSourceIsVisible(batch, source)) ||
    batch.blocks.some(block => scientificSourceMentions({quote: block.text}, entity.canonicalName)));
  validate();
  for (const batch of batches) {
    await run('entities', batch, async () => {candidates.entities.push(...await extractScientificEntities(session, batch, ir, signal));});
  }
  for (const batch of batches) {
    await run('facts', batch, async () => {candidates.facts.push(...await extractScientificFacts(session, batch, ir, relevant(batch), signal));});
  }
  for (const batch of batches) {
    const facts = candidates.facts.filter(fact => fact.evidence.some(source => scientificSourceIsVisible(batch, source)));
    const referenced = new Set(facts.flatMap(fact => [fact.subjectEntityId, fact.objectEntityId, fact.conditions.datasetId,
      fact.conditions.metricId, fact.conditions.baselineId]).filter(id => id !== null));
    const entities = [...new Map([...relevant(batch), ...candidates.entities.filter(entity => referenced.has(entity.id))]
      .map(entity => [entity.id, entity])).values()];
    await run('relations', batch, async () => {candidates.relations.push(...await extractScientificRelations(session, batch, ir, entities, facts, signal));});
  }
  await current();
  return {candidates: scientificKnowledgeCandidatesSchema.parse(candidates), knowledge: validate(), batches: batches.length, calls};
}
