import {isDeepStrictEqual} from 'node:util';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {scientificKnowledgeCandidatesSchema, type ScientificExtractionSnapshot, type ScientificKnowledgeCandidates,
  type ScientificKnowledgeBundle} from '../../../shared/schemas/research-scientific-extraction';
import {buildScientificExtractionBatches, scientificSourceIsVisible, assertScientificBatchSources, type ScientificExtractionBatch} from './scientific-extraction-batches';
import {extractScientificEntities, scientificMetadataEntity} from './scientific-entity-extractor';
import {extractScientificFacts} from './scientific-fact-extractor';
import {extractScientificRelations} from './scientific-relation-extractor';
import type {ScientificExtractionSession} from './scientific-extraction-model';
import {validateScientificKnowledgeCandidates} from './scientific-extraction-repository';
import {scientificSourceMentions} from './scientific-fact-validator';
import {researchContentHash} from './research-files';
import {scientificExtractionInputHash} from './scientific-extraction-repository';
import {scientificDeepBatches, initialScientificDeepKnowledge, extractScientificDeepKnowledge, mergeScientificDeepClaims} from './scientific-extraction-deep';
import {scientificBatchHash, type ScientificBatchCheckpoint} from './scientific-extraction-receipts';

export type ScientificExtractionStage = 'entities' | 'facts' | 'relations' | 'deep';
export type ScientificExtractionResult = {candidates: ScientificKnowledgeCandidates; knowledge: ScientificKnowledgeBundle; batches: number; calls: number};

/** Three bounded transformations, followed by source validation. Persistence/publication has a separate owner. */
export async function runScientificExtraction(input: {
  session: ScientificExtractionSession; snapshot: ScientificExtractionSnapshot; generationId: string; ir: PaperIRV2;
  signal: AbortSignal; baseCandidates?: ScientificKnowledgeCandidates; checkpoint?: ScientificBatchCheckpoint; assertCurrent?: () => Promise<void>;
  observe?: (stage: ScientificExtractionStage, batch: ScientificExtractionBatch,
    operation: () => Promise<void>) => Promise<void>;
}): Promise<ScientificExtractionResult> {
  const {session, snapshot, generationId, signal} = input, ir = structuredClone(input.ir);
  if (!isDeepStrictEqual(session.config, snapshot.config)) throw new Error('research_scientific_extraction_input_changed');
  const batches = buildScientificExtractionBatches(ir, session.config);
  const candidates: ScientificKnowledgeCandidates = input.baseCandidates && snapshot.deepRequest ?
    scientificKnowledgeCandidatesSchema.parse(structuredClone(input.baseCandidates)) :
    {entities: [scientificMetadataEntity(ir)], facts: [], relations: []};
  if (candidates.deepReading) throw new Error('research_scientific_deep_base_invalid');
  const deepBatches = snapshot.deepRequest ? scientificDeepBatches(ir, batches, snapshot.deepRequest) : [];
  const hash = (value: unknown): string => researchContentHash(JSON.stringify(value));
  const inputHash = scientificExtractionInputHash(snapshot), modelRevision = hash(snapshot.config.model);
  const receipts = input.checkpoint?.read() ?? [];
  let calls = 0;
  const validate = (): ScientificKnowledgeBundle => validateScientificKnowledgeCandidates(candidates, snapshot, generationId, ir);
  const current = async (): Promise<void> => {signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted();};
  const run = async (stage: ScientificExtractionStage, batch: ScientificExtractionBatch, operation: () => Promise<void>): Promise<void> => {
    await current();
    const before = structuredClone(candidates), dependencyHash = scientificBatchHash({batch, candidates: before});
    const receipt = receipts.find(item => item.jobId === generationId && item.inputHash === inputHash &&
      item.modelRevision === modelRevision && item.stage === stage && item.batchId === batch.id &&
      item.dependencyHash === dependencyHash && item.validationStatus === 'source_validated' && item.outputHash === scientificBatchHash(item.output));
    if (receipt) {
      try {
        const delta = scientificKnowledgeCandidatesSchema.parse(receipt.output);
        for (const key of ['entities', 'facts', 'relations'] as const) {
          if (key !== stage && delta[key].length) throw new Error('research_scientific_extraction_checkpoint_invalid');
        }
        if (stage === 'deep' ? !delta.deepReading || !before.deepReading : delta.deepReading !== undefined) {
          throw new Error('research_scientific_extraction_checkpoint_invalid');
        }
        const sources = stage === 'entities' ? delta.entities.flatMap(item => item.evidence) :
          stage === 'facts' ? delta.facts.flatMap(item => [...item.evidence,
            ...item.conditionEvidence.flatMap(condition => condition.evidence), ...(item.value?.unitEvidence ?? [])]) :
          stage === 'relations' ? delta.relations.flatMap(item => item.evidence) :
          [...delta.deepReading!.claims.flatMap(item => item.evidence.map(source => source.proposal)),
            ...delta.deepReading!.relationships.flatMap(item => [item.from.proposal, item.to.proposal,
              ...item.evidence.map(source => source.proposal)])];
        assertScientificBatchSources(batch, sources, ir);
        const output: ScientificKnowledgeCandidates = {entities: [...before.entities, ...delta.entities],
          facts: [...before.facts, ...delta.facts], relations: [...before.relations, ...delta.relations]};
        if (delta.deepReading && before.deepReading) {
          if (!isDeepStrictEqual(delta.deepReading.identity, before.deepReading.identity) ||
            !isDeepStrictEqual(delta.deepReading.request, before.deepReading.request) ||
            Object.values(delta.deepReading.objects).some(objects => objects.length)) {
            throw new Error('research_scientific_extraction_checkpoint_invalid');
          }
          output.deepReading = mergeScientificDeepClaims(before.deepReading,
            delta.deepReading.claims, delta.deepReading.relationships);
        }
        validateScientificKnowledgeCandidates(output, snapshot, generationId, ir);
        Object.assign(candidates, output);
        await current();
        return;
      } catch {
        Object.assign(candidates, before);
        if (!before.deepReading) delete candidates.deepReading;
        await current();
      }
    }
    const invoke = async (): Promise<void> => {
      calls++; await operation(); await current(); validate();
      const output: ScientificKnowledgeCandidates = {entities: candidates.entities.slice(before.entities.length),
        facts: candidates.facts.slice(before.facts.length), relations: candidates.relations.slice(before.relations.length)};
      if (stage === 'deep' && candidates.deepReading && before.deepReading) {
        const claimIds = new Set(before.deepReading.claims.map(claim => claim.id));
        const relationIds = new Set(before.deepReading.relationships.map(relation => relation.id));
        output.deepReading = {...candidates.deepReading,
          claims: candidates.deepReading.claims.filter(claim => !claimIds.has(claim.id)),
          relationships: candidates.deepReading.relationships.filter(relation => !relationIds.has(relation.id)),
          objects: {tables: [], figures: [], equations: [], algorithms: []}};
      }
      input.checkpoint?.write({jobId: generationId, inputHash, batchId: batch.id, stage, modelRevision,
        dependencyHash, outputHash: scientificBatchHash(output), validationStatus: 'source_validated', output});
    };
    if (input.observe) await input.observe(stage, batch, invoke); else await invoke();
  };
  const relevant = (batch: ScientificExtractionBatch) => candidates.entities.filter(entity =>
    entity.entityType === 'Paper' || entity.evidence.some(source => scientificSourceIsVisible(batch, source)) ||
    batch.blocks.some(block => scientificSourceMentions({quote: block.text}, entity.canonicalName)));
  validate();
  for (const batch of input.baseCandidates && snapshot.deepRequest ? [] : batches) {
    await run('entities', batch, async () => {candidates.entities.push(...await extractScientificEntities(session, batch, ir, signal));});
  }
  for (const batch of input.baseCandidates && snapshot.deepRequest ? [] : batches) {
    await run('facts', batch, async () => {candidates.facts.push(...await extractScientificFacts(session, batch, ir, relevant(batch), signal));});
  }
  for (const batch of input.baseCandidates && snapshot.deepRequest ? [] : batches) {
    const facts = candidates.facts.filter(fact => fact.evidence.some(source => scientificSourceIsVisible(batch, source)));
    const referenced = new Set(facts.flatMap(fact => [fact.subjectEntityId, fact.objectEntityId, fact.conditions.datasetId,
      fact.conditions.metricId, fact.conditions.baselineId]).filter(id => id !== null));
    const entities = [...new Map([...relevant(batch), ...candidates.entities.filter(entity => referenced.has(entity.id))]
      .map(entity => [entity.id, entity])).values()];
    await run('relations', batch, async () => {candidates.relations.push(...await extractScientificRelations(session, batch, ir, entities, facts, signal));});
  }
  if (snapshot.deepRequest) {
    candidates.deepReading = initialScientificDeepKnowledge(ir, snapshot.deepRequest, deepBatches);
    for (const batch of deepBatches) {
      await run('deep', batch, async () => {
        candidates.deepReading = await extractScientificDeepKnowledge(session, batch, ir, candidates.deepReading!, signal);
      });
    }
  }
  await current();
  return {candidates: scientificKnowledgeCandidatesSchema.parse(candidates), knowledge: validate(), batches: batches.length, calls};
}
