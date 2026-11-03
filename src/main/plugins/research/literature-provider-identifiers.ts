import {literatureIdentifierObservationSchema, type LiteratureIdentifierObservation, type LiteratureRawIdentifiers} from '../../../shared/schemas/literature-identifiers';
import {z} from 'zod';
import {normalizeResearchArxiv, normalizeResearchDoi, normalizeResearchPmid} from './literature-identity';

export function openAlexIdentifierObservations(ids: {doi?: string | null; pmid?: string | null} | null | undefined): LiteratureIdentifierObservation[] {
  const observations: LiteratureIdentifierObservation[] = [];
  if (ids?.doi != null) observations.push({kind: 'doi', field: 'ids.doi', value: ids.doi, identity: `doi:${normalizeResearchDoi(ids.doi)}`});
  if (ids?.pmid != null) observations.push({kind: 'pmid', field: 'ids.pmid', value: ids.pmid, identity: `pmid:${normalizeResearchPmid(ids.pmid)}`});
  return observations.map(value => literatureIdentifierObservationSchema.parse(value));
}

export function semanticScholarIdentifierObservations(ids: {DOI?: string | null; ArXiv?: string | null} | null | undefined): LiteratureIdentifierObservation[] {
  const observations: LiteratureIdentifierObservation[] = [];
  if (ids?.DOI != null) observations.push({kind: 'doi', field: 'externalIds.DOI', value: ids.DOI, identity: `doi:${normalizeResearchDoi(ids.DOI)}`});
  if (ids?.ArXiv != null) observations.push({kind: 'arxiv', field: 'externalIds.ArXiv', value: ids.ArXiv, identity: `arxiv:${normalizeResearchArxiv(ids.ArXiv).id}`});
  return observations.map(value => literatureIdentifierObservationSchema.parse(value));
}

const text = z.string().nullable().optional();
const openAlexIds = z.looseObject({doi: text, pmid: text});
const semanticIds = z.looseObject({DOI: text, ArXiv: text});
export function providerIdentifierObservations(source: string, raw: LiteratureRawIdentifiers): LiteratureIdentifierObservation[] {
  if (source === 'openalex') return openAlexIdentifierObservations(openAlexIds.parse(raw));
  if (source === 'semantic_scholar') return semanticScholarIdentifierObservations(semanticIds.parse(raw));
  throw new Error('literature_provider_identifier_source_invalid');
}
