import {z} from 'zod';
import type {ScholarlyProvider, ScholarlyRelation} from '../../../shared/schemas/research-scholarly-relations';
import {scholarlyRelationSchema} from '../../../shared/schemas/research-scholarly-relations';
import {normalizeResearchDoi} from './literature-identity';

type Identity = ScholarlyRelation['subject'];
export type ScholarlyProviderMaterial = {
  relations: ScholarlyRelation[]; unmappedReferences: number; referencesReported: boolean;
  relationsReported: boolean; updatesReported: boolean;
  retraction: 'retracted' | 'not_reported' | 'unknown'; nextOffset: number | null
};
const text = z.string().trim().min(1).max(2048);
const openalexId = text.regex(/^https:\/\/openalex\.org\/W[1-9]\d*$/u);
const openalex = z.looseObject({
  id: openalexId, doi: text, referenced_works: z.array(openalexId).max(10000), is_retracted: z.boolean()
});
const crossref = z.looseObject({message: z.looseObject({
  DOI: text, reference: z.array(z.looseObject({DOI: text.optional()})).max(10000).optional(),
  relation: z.record(text, z.array(z.looseObject({
    id: text, 'id-type': text, 'asserted-by': z.enum(['subject', 'object'])
  })).max(10000)).optional(),
  'update-to': z.array(z.looseObject({
    DOI: text, type: text, updated: z.looseObject({'date-parts': z.array(z.array(z.number().int()).min(1).max(3)).min(1)})
  })).max(10000).optional()
})});
const semantic = z.looseObject({
  offset: z.number().int().nonnegative(), next: z.number().int().nonnegative().optional(),
  data: z.array(z.looseObject({citedPaper: z.looseObject({
    paperId: text.nullable(), externalIds: z.looseObject({DOI: text.nullable().optional()}).nullable().optional()
  }).nullable()})).max(100)
});
const doiId = (value: string): Identity => ({scheme: 'doi', value: normalizeResearchDoi(value)});
const relation = (subject: Identity, object: Identity, kind: ScholarlyRelation['kind'],
  providerType: string, field: string, assertedBy: ScholarlyRelation['assertedBy'] = null): ScholarlyRelation =>
  ({subject, object, kind, providerType, field, assertedBy});
const versionTypes = new Set(['is-version-of', 'has-version', 'is-preprint-of', 'has-preprint',
  'is-manuscript-of', 'has-manuscript', 'is-identical-to']);

export function scholarlyEndpoint(source: ScholarlyProvider, doi: string, offset: number, limit: number): string {
  const encoded = encodeURIComponent(normalizeResearchDoi(doi));
  switch (source) {
    case 'openalex': return `https://api.openalex.org/works/https://doi.org/${encoded}?select=id,doi,referenced_works,is_retracted`;
    case 'crossref': return `https://api.crossref.org/works/${encoded}`;
    case 'semantic_scholar': return `https://api.semanticscholar.org/graph/v1/paper/DOI:${encoded}/references?fields=paperId,externalIds&offset=${offset}&limit=${limit}`;
  }
}

export function readScholarlyMaterial(source: ScholarlyProvider, queriedDoi: string, offset: number,
  limit: number, payload: unknown): ScholarlyProviderMaterial {
  const material = mapScholarlyMaterial(source, queriedDoi, offset, limit, payload);
  material.relations = z.array(scholarlyRelationSchema).max(10000).parse(material.relations);
  return material;
}

function mapScholarlyMaterial(source: ScholarlyProvider, queriedDoi: string, offset: number,
  limit: number, payload: unknown): ScholarlyProviderMaterial {
  const subject = doiId(queriedDoi);
  switch (source) {
    case 'openalex': {
      const value = openalex.parse(payload);
      if (normalizeResearchDoi(value.doi) !== subject.value) throw new Error('scholarly_provider_identity_mismatch');
      return {relations: value.referenced_works.map((id, index) =>
        relation({scheme: 'openalex', value: value.id}, {scheme: 'openalex', value: id}, 'cites', 'referenced_works', `referenced_works[${index}]`)),
      unmappedReferences: 0, referencesReported: true, relationsReported: false, updatesReported: false,
      retraction: value.is_retracted ? 'retracted' : 'not_reported', nextOffset: null};
    }
    case 'crossref': {
      const value = crossref.parse(payload).message;
      if (normalizeResearchDoi(value.DOI) !== subject.value) throw new Error('scholarly_provider_identity_mismatch');
      const relations: ScholarlyRelation[] = [];
      let unmappedReferences = 0;
      value.reference?.forEach((reference, index) => {
        if (reference.DOI === undefined) {unmappedReferences++; return;}
        relations.push(relation(subject, doiId(reference.DOI), 'cites', 'reference', `reference[${index}].DOI`));
      });
      for (const [type, entries] of Object.entries(value.relation ?? {})) {
        entries.forEach((entry, index) => relations.push(relation(subject,
          entry['id-type'].toLowerCase() === 'doi' ? doiId(entry.id) : {scheme: 'external', value: `${entry['id-type']}:${entry.id}`},
          versionTypes.has(type) ? 'version' : 'provider_relation', type, `relation.${type}[${index}]`, entry['asserted-by'])));
      }
      value['update-to']?.forEach((update, index) => relations.push(relation(subject, doiId(update.DOI),
        update.type === 'retraction' ? 'retraction' : update.type === 'correction' ? 'correction' : 'provider_relation',
        update.type, `update-to[${index}].DOI`)));
      return {relations, unmappedReferences, referencesReported: value.reference !== undefined,
        relationsReported: value.relation !== undefined, updatesReported: value['update-to'] !== undefined,
        retraction: 'unknown', nextOffset: null};
    }
    case 'semantic_scholar': {
      const value = semantic.parse(payload);
      if (value.offset !== offset || value.data.length > limit ||
        value.next !== undefined && (value.next <= offset || value.next !== offset + value.data.length))
        throw new Error('scholarly_provider_pagination_invalid');
      const relations: ScholarlyRelation[] = [];
      let unmappedReferences = 0;
      value.data.forEach((entry, index) => {
        const paper = entry.citedPaper;
        if (paper === null) {unmappedReferences++; return;}
        const doi = paper.externalIds?.DOI;
        let object: Identity;
        if (doi != null) object = doiId(doi);
        else if (paper.paperId !== null) object = {scheme: 'semantic_scholar', value: paper.paperId};
        else {unmappedReferences++; return;}
        relations.push(relation(subject, object,
          'cites', 'references', `data[${index}].citedPaper`));
      });
      return {relations, unmappedReferences, referencesReported: true, relationsReported: false,
        updatesReported: false, retraction: 'unknown', nextOffset: value.next ?? null};
    }
  }
}
