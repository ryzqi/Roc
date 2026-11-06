import {z} from 'zod';
import {normalizeResearchDoi} from './literature-identity';
import {resourceMetadataSchema, type ResourceMetadata} from '../../../shared/schemas/research-resources';

const text = z.string().min(1).max(8192);
const optionalText = text.nullish();
const payloadSchema = z.object({data: z.object({
  id: text, type: z.literal('dois'), attributes: z.object({
    doi: text, state: z.literal('findable'),
    types: z.object({resourceTypeGeneral: z.enum(['Dataset', 'Software']), resourceType: optionalText}),
    version: optionalText, schemaVersion: optionalText, url: optionalText,
    titles: z.array(z.object({title: text, titleType: optionalText, lang: optionalText})).min(1).max(32),
    rightsList: z.array(z.object({
      rights: optionalText, rightsUri: optionalText, rightsIdentifier: optionalText,
      rightsIdentifierScheme: optionalText, schemeUri: optionalText, lang: optionalText
    })).max(64).nullish(),
    relatedIdentifiers: z.array(z.object({
      relatedIdentifier: text, relatedIdentifierType: text, relationType: text,
      resourceTypeGeneral: optionalText, relationTypeInformation: optionalText,
      relatedMetadataScheme: optionalText, schemeUri: optionalText, schemeType: optionalText
    })).max(10000).nullish()
  })
})});

export function dataciteEndpoint(doi: string): string {
  return `https://api.datacite.org/dois/${encodeURIComponent(normalizeResearchDoi(doi))}`;
}

export function readDataCiteMetadata(doi: string, payload: unknown): ResourceMetadata {
  const {data} = payloadSchema.parse(payload);
  const canonicalDoi = normalizeResearchDoi(doi);
  const value = data.attributes;
  if (normalizeResearchDoi(data.id) !== canonicalDoi || normalizeResearchDoi(value.doi) !== canonicalDoi) {
    throw new Error('literature_provider_response_invalid');
  }
  return resourceMetadataSchema.parse({
    doi: canonicalDoi, providerIdentifier: data.id, kind: value.types.resourceTypeGeneral === 'Dataset' ? 'dataset' : 'software',
    resourceType: value.types.resourceType ?? null, version: value.version ?? null,
    reportedSchemaVersion: value.schemaVersion ?? null, landingPage: value.url ?? null,
    titles: value.titles.map(title => ({title: title.title, titleType: title.titleType ?? null, lang: title.lang ?? null})),
    rights: value.rightsList == null ? null : value.rightsList.map(right => ({
      rights: right.rights ?? null, rightsUri: right.rightsUri ?? null, rightsIdentifier: right.rightsIdentifier ?? null,
      rightsIdentifierScheme: right.rightsIdentifierScheme ?? null, schemeUri: right.schemeUri ?? null, lang: right.lang ?? null
    })),
    relatedIdentifiers: value.relatedIdentifiers == null ? null : value.relatedIdentifiers.map(relation => ({
      relatedIdentifier: relation.relatedIdentifier, relatedIdentifierType: relation.relatedIdentifierType,
      relationType: relation.relationType, resourceTypeGeneral: relation.resourceTypeGeneral ?? null,
      relationTypeInformation: relation.relationTypeInformation ?? null, relatedMetadataScheme: relation.relatedMetadataScheme ?? null,
      schemeUri: relation.schemeUri ?? null, schemeType: relation.schemeType ?? null
    }))
  });
}
