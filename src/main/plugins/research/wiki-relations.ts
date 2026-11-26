import type {z} from 'zod';
import {wikiRelationProjectionsSchema} from '../../../shared/schemas/research-wiki-pages';
import type {ScientificEntity} from '../../../shared/schemas/research-scientific-entities';
import {scientificWikiRegistry, type ScientificWikiBasis, type ScientificWikiEntry} from './wiki-scientific-synthesis';
import {checkScientificComparison} from './wiki-scientific-comparison';

/** Aliases are explicit owner-maintained records. Matching printed names never merge sources. */
export function wikiEntityAlignment(a: ScientificEntity, b: ScientificEntity): 'aligned' | 'unresolved' | 'different' {
  if (a.status !== 'source_validated' || b.status !== 'source_validated' ||
    a.resolutionStatus === 'conflict' || b.resolutionStatus === 'conflict' || a.entityType !== b.entityType) return 'unresolved';
  if (a.id !== b.id) return a.canonicalName === b.canonicalName || a.aliases.includes(b.canonicalName) || b.aliases.includes(a.canonicalName)
    ? 'unresolved' : 'different';
  // A shared alias does not erase differing original dataset versions or metric definitions.
  if (JSON.stringify(a.proposal.attributes) !== JSON.stringify(b.proposal.attributes)) return 'unresolved';
  return 'aligned';
}

/** A bounded projection of current owner publications; no second graph or scientific approval is written. */
export function projectWikiRelations(basis: ScientificWikiBasis): z.infer<typeof wikiRelationProjectionsSchema> {
  const entries = [...scientificWikiRegistry(basis).values()];
  const result: z.infer<typeof wikiRelationProjectionsSchema> = [];
  const entities = entries.filter((entry): entry is Extract<ScientificWikiEntry, {kind: 'entity'}> => entry.kind === 'entity');
  for (const entry of entries) {
    if (result.length >= 500) break;
    if (entry.kind === 'relation') {
      const relation = entry.value;
      const from = entities.find(item => item.ref.source.documentId === entry.ref.source.documentId && item.value.id === relation.fromEntityId);
      const to = entities.find(item => item.ref.source.documentId === entry.ref.source.documentId && item.value.id === relation.toEntityId);
      if (!from || !to) continue;
      const types = {DEFINES: 'defines', USES: 'uses', EXTENDS: 'extends', EVALUATES_ON: 'evaluates_on',
        COMPARES_WITH: 'compares_with', SUPPORTS: 'supports', CONTRADICTS: 'contradicts', RELATED_TO: 'related_to'} as const;
      const type = relation.type in types ? types[relation.type as keyof typeof types] : 'related_to';
      result.push({type, from: from.ref, to: to.ref, evidence: [entry.ref], validation: 'review_required',
        scientificApproval: 'unreviewed', comparison: null});
    }
  }
  const results = entries.filter((entry): entry is Extract<ScientificWikiEntry, {kind: 'fact'}> =>
    entry.kind === 'fact' && entry.value.factType === 'experimental_result').slice(0, 50);
  for (let i = 0; i < results.length && result.length < 500; i++) for (const right of results.slice(i + 1)) {
    if (result.length >= 500) break;
    const left = results[i]!;
    if (left.ref.source.documentId === right.ref.source.documentId) continue;
    const pair = [left, right], columns = pair.map(entry => ({source: entry.ref.source, fact: entry.value,
      entities: basis.knowledge.find(read => read.documentId === entry.ref.source.documentId)!.knowledge!.entities}));
    const comparison = checkScientificComparison(columns, pair.map(entry => entry.ref.source)).status;
    result.push({type: comparison === 'conditions_match' ? 'compares_with' : 'related_to', from: left.ref, to: right.ref,
      evidence: pair.map(entry => entry.ref), validation: 'review_required', scientificApproval: 'unreviewed', comparison});
  }
  return wikiRelationProjectionsSchema.parse(result);
}
