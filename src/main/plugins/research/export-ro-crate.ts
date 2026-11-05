import {z} from 'zod';
import {
  researchCrateContext, researchCrateInputSchema, researchCrateMetadataPath, researchCrateProfile, researchCrateProfilePath,
  researchCrateVersion, researchPublicTextSchema, researchPublicUrlSchema, type ResearchCrateInput
} from '../../../shared/schemas/research-ro-crate';
import {researchExportFileSchema, type ResearchExportFile} from '../../../shared/schemas/research-exports';
import {readResearchFile, researchContentHash, researchRelativePath} from './research-files';

const reference = z.strictObject({'@id': z.string().min(1)});
const references = z.array(reference);
const text = researchPublicTextSchema;
const nodeSchema = z.strictObject({
  '@id': text, '@type': z.union([
    z.enum(['CreativeWork', 'Profile', 'Dataset', 'File', 'Person', 'ScholarlyArticle',
      'SoftwareApplication', 'ImageObject', 'CreateAction', 'PropertyValue', 'ActionStatusType']),
    z.tuple([z.literal('File'), z.literal('SoftwareSourceCode')]),
    z.tuple([z.literal('File'), z.literal('CreativeWork'), z.literal('Profile')])
  ]),
  name: text.optional(), description: text.optional(), version: text.optional(),
  about: reference.optional(), conformsTo: reference.optional(),
  datePublished: z.iso.date().optional(), license: reference.optional(), author: references.optional(),
  hasPart: references.optional(), mainEntity: reference.optional(), subjectOf: references.optional(),
  encoding: references.optional(), isBasedOn: references.optional(), url: researchPublicUrlSchema.optional(),
  contentSize: z.number().int().nonnegative().optional(), sha256: researchExportFileSchema.shape.sha256.optional(),
  instrument: reference.optional(), object: references.optional(), result: references.optional(),
  startTime: z.iso.datetime().optional(), endTime: z.iso.datetime().optional(), actionStatus: reference.optional(),
  additionalProperty: references.optional(), propertyID: text.optional(), value: z.union([text, z.number()]).optional(),
  'roc:delivery': z.enum(['bundled', 'metadata_only']).optional(),
  'roc:acquisition': text.optional(), 'roc:environmentHash': researchExportFileSchema.shape.sha256.optional(),
  'roc:artifactId': text.optional(), 'roc:artifactVersion': researchExportFileSchema.shape.sha256.optional()
});
const documentSchema = z.strictObject({
  '@context': z.tuple([z.literal(researchCrateContext), z.strictObject({roc: z.literal('urn:roc:research:')})]),
  '@graph': z.array(nodeSchema).min(1).max(50000)
});
export type ResearchCrateDocument = z.infer<typeof documentSchema>;
type Node = ResearchCrateDocument['@graph'][number];
const ref = (id: string) => ({'@id': id});
const workId = (id: string) => `#work-${encodeURIComponent(id)}`;
const fileId = (path: string) => path.split('/').map(part => encodeURIComponent(part)).join('/');
const profileId = researchCrateProfilePath;
const hasType = (node: Node | undefined, type: string) => typeof node?.['@type'] === 'string' ?
  node['@type'] === type : node?.['@type'].some(value => value === type) === true;
const isFile = (node: Node | undefined) => hasType(node, 'File');
const statusId = {
  completed: 'http://schema.org/CompletedActionStatus', failed: 'http://schema.org/FailedActionStatus',
  cancelled: 'http://schema.org/FailedActionStatus', interrupted: 'http://schema.org/FailedActionStatus'
} as const;
const workTypes = {
  manuscript: 'ScholarlyArticle', dataset: 'Dataset', software: 'SoftwareApplication',
  figure: 'ImageObject', result: 'Dataset', reference: 'ScholarlyArticle'
} as const;

export const researchCrateProfileHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Roc research export profile 1</title>
<h1>Roc research export profile 1</h1>
<p>This package MUST conform to RO-Crate 1.2 with its canonical context referenced by URI.
Every payload file MUST appear in manifest.json and the root hasPart inventory with its byte size and SHA-256.
The metadata descriptor and manifest MUST NOT contain their own checksum.
The manifest MUST seal the metadata descriptor after all payload files are written.</p>
<p>The root MUST declare public name, description, date, authors and license.
Exactly one bundled manuscript MUST be the mainEntity and have a recorded human approval binding.
Each scholarly work MUST declare its license and either bundled paths or metadata-only acquisition instructions.
References MUST be metadata-only. A license declaration does not itself grant redistribution rights.</p>
<p>Every graph reference MUST resolve within this flat graph and every entity MUST be reachable from the root or descriptor.
Execution activities MUST preserve recorded environment, parameters, seed and cost;
unknown seed or cost MUST remain explicitly unknown. Public metadata MUST NOT expose private paths or credentials.
Approval bindings MUST identify artifact, exact version, recorded time and review file;
scientific approval does not grant permission to publish.</p></html>
`;

/** Generate before manifest.json: the manifest seals these bytes, with no mutual hash dependency. */
export function buildResearchCrate(input: ResearchCrateInput): ResearchCrateDocument {
  const source = researchCrateInputSchema.parse(input);
  const graph: Node[] = [];
  const addLicense = (id: string, license: ResearchCrateInput['publication']['license']) => {
    graph.push({'@id': id, '@type': 'CreativeWork', name: license.name, description: license.description,
      ...(license.url === null ? {} : {url: license.url})});
    return ref(id);
  };
  const license = addLicense('#license', source.publication.license);
  const authors = source.publication.authors.map((author, index) => {
    const id = `#author-${index}`;
    graph.push({'@id': id, '@type': 'Person', name: author.name, ...(author.orcid === null ? {} : {url: author.orcid})});
    return ref(id);
  });
  const manuscript = source.works.find(work => work.kind === 'manuscript')!;
  graph.push(
    {'@id': researchCrateMetadataPath, '@type': 'CreativeWork', about: ref('./'), conformsTo: ref('https://w3id.org/ro/crate/1.2')},
    {'@id': './', '@type': 'Dataset', name: source.publication.name, description: source.publication.description,
      datePublished: source.publication.datePublished, license, author: authors, conformsTo: ref(profileId),
      mainEntity: ref(workId(manuscript.id)),
      hasPart: [...source.files.map(file => ref(fileId(file.path))), ref('manifest.json')],
      subjectOf: [...source.works.map(work => ref(workId(work.id))), ...source.activities.map(activity => ref(`#activity-${encodeURIComponent(activity.id)}`)),
        ...source.approvals.map((_, index) => ref(`#approval-${index}`))]},
    {'@id': 'https://w3id.org/ro/crate/1.2', '@type': 'CreativeWork', name: `RO-Crate ${researchCrateVersion}`},
    {'@id': 'manifest.json', '@type': 'File', name: 'Authoritative byte inventory; excludes its own checksum.'}
  );
  const codePaths = new Set(source.works.filter(work => work.kind === 'software')
    .flatMap(work => work.delivery.kind === 'bundled' ? work.delivery.paths : []));
  for (const file of source.files) graph.push(file.path === profileId ?
    {'@id': profileId, '@type': ['File', 'CreativeWork', 'Profile'], name: file.path, version: '1',
      description: researchCrateProfile, contentSize: file.size, sha256: file.sha256} :
    {'@id': fileId(file.path), '@type': codePaths.has(file.path) ? ['File', 'SoftwareSourceCode'] : 'File',
      name: file.path, contentSize: file.size, sha256: file.sha256});
  for (const work of source.works) {
    const id = workId(work.id);
    const license = addLicense(`${id}-license`, work.license);
    graph.push({'@id': id, '@type': workTypes[work.kind], name: work.name, description: work.description,
      license, ...(work.version === null ? {} : {version: work.version}), ...(work.url === null ? {} : {url: work.url}),
      ...(work.kind === 'manuscript' ? {author: authors} : {}),
      isBasedOn: work.basedOn.map(id => ref(workId(id))), 'roc:delivery': work.delivery.kind,
      ...(work.delivery.kind === 'bundled' ? {encoding: work.delivery.paths.map(path => ref(fileId(path)))} :
        {'roc:acquisition': work.delivery.instructions, ...(work.delivery.url === null ? {} : {url: work.delivery.url})})});
  }
  for (const activity of source.activities) {
    const id = `#activity-${encodeURIComponent(activity.id)}`;
    const properties: {name: string; value: string | number}[] = [
      {name: 'execution status', value: activity.status}, {name: 'environment version', value: activity.environment.version},
      ...activity.environment.packages.map(property => ({name: `package: ${property.name}`, value: property.value})),
      ...activity.parameters.map(property => ({name: `parameter: ${property.name}`, value: property.value})),
      ...(activity.seed === null ? [{name: 'random seed', value: 'Not recorded'}] : [{name: 'random seed', value: activity.seed}]),
      ...(activity.cost.kind === 'known' ? [{name: 'cost (microusd)', value: activity.cost.microusd}] :
        [{name: 'cost unknown', value: activity.cost.reason}])
    ];
    const additionalProperty = properties.map((property, index) => {
      const propertyId = `${id}-property-${index}`;
      graph.push({'@id': propertyId, '@type': 'PropertyValue', name: property.name, propertyID: property.name, value: property.value});
      return ref(propertyId);
    });
    graph.push({'@id': id, '@type': 'CreateAction', name: activity.name, instrument: ref(workId(activity.software)),
      object: activity.inputs.map(id => ref(workId(id))), result: activity.outputs.map(id => ref(workId(id))),
      actionStatus: ref(statusId[activity.status]), additionalProperty, 'roc:environmentHash': activity.environment.hash,
      ...(activity.startedAt === null ? {} : {startTime: activity.startedAt}),
      ...(activity.endedAt === null ? {} : {endTime: activity.endedAt})});
  }
  for (const id of new Set(source.activities.map(activity => statusId[activity.status]))) {
    graph.push({'@id': id, '@type': 'ActionStatusType', name: id.slice(id.lastIndexOf('/') + 1)});
  }
  source.approvals.forEach((approval, index) => graph.push({
    '@id': `#approval-${index}`, '@type': 'CreativeWork', name: 'Recorded human approval binding',
    about: ref(workId(approval.workId)), subjectOf: [ref(fileId(approval.reviewPath))],
    'roc:artifactId': approval.artifactId, 'roc:artifactVersion': approval.artifactVersion,
    description: `Human approval recorded at ${approval.recordedAt}; binding does not grant publication permission.`
  }));
  return validateResearchCrate({'@context': [researchCrateContext, {roc: 'urn:roc:research:'}], '@graph': graph}, source.files);
}

export function serializeResearchCrate(document: ResearchCrateDocument): string {
  return `${JSON.stringify(documentSchema.parse(document), null, 2)}\n`;
}

/** Offline Roc profile validator. It performs no context downloads or URL availability checks. */
export function validateResearchCrate(document: unknown, inventory: readonly ResearchExportFile[]): ResearchCrateDocument {
  const crate = documentSchema.parse(document);
  const nodes = new Map(crate['@graph'].map(node => [node['@id'], node]));
  if (nodes.size !== crate['@graph'].length) throw new Error('research_crate_duplicate_entity');
  const descriptor = nodes.get(researchCrateMetadataPath);
  const root = nodes.get('./');
  if (descriptor?.['@type'] !== 'CreativeWork' || descriptor.about?.['@id'] !== './' ||
    descriptor.conformsTo?.['@id'] !== 'https://w3id.org/ro/crate/1.2' ||
    root?.['@type'] !== 'Dataset' || !root.name || !root.description || !root.datePublished ||
    root.conformsTo?.['@id'] !== profileId || !hasType(nodes.get(profileId), 'Profile') || nodes.get(profileId)?.version !== '1' ||
    !root.license || !root.author?.length || nodes.get(root.mainEntity?.['@id'] ?? '')?.['@type'] !== 'ScholarlyArticle') {
    throw new Error('research_crate_profile_invalid');
  }
  const main = nodes.get(root.mainEntity!['@id'])!;
  if (main['roc:delivery'] !== 'bundled' || !crate['@graph'].some(node => node['roc:artifactVersion'] && node.about?.['@id'] === main['@id'])) {
    throw new Error('research_crate_approval_missing');
  }
  for (const id of [root.license['@id'], ...root.author.map(author => author['@id'])]) {
    const node = nodes.get(id);
    if (!node?.name || (id === root.license['@id'] ? node['@type'] !== 'CreativeWork' || !node.description : node['@type'] !== 'Person')) {
      throw new Error('research_crate_profile_invalid');
    }
  }
  if (nodes.get('manifest.json')?.['@type'] !== 'File' || nodes.get('manifest.json')?.sha256 !== undefined ||
    descriptor.sha256 !== undefined) throw new Error('research_crate_generation_order');
  for (const node of crate['@graph']) {
    if (node['@id'].startsWith('#work-') && node['@type'] !== 'CreativeWork') {
      if (!node.name || !node.description || !node.license || !node['roc:delivery'] ||
        (node['roc:delivery'] === 'metadata_only' ? node.encoding !== undefined || !node['roc:acquisition'] : !node.encoding?.length)) {
        throw new Error('research_crate_delivery_invalid');
      }
      const license = nodes.get(node.license['@id']);
      if (license?.['@type'] !== 'CreativeWork' || !license.name || !license.description) throw new Error('research_crate_profile_invalid');
      if (node.encoding?.some(file => !isFile(nodes.get(file['@id'])))) throw new Error('research_crate_file_missing');
      if (node['@type'] === 'SoftwareApplication' && (!node.url || !node.version)) throw new Error('research_crate_software_metadata_required');
      if (node['@type'] === 'ScholarlyArticle' && node['@id'] !== main['@id'] && node['roc:delivery'] !== 'metadata_only') {
        throw new Error('research_crate_reference_metadata_only');
      }
    }
    if (node['roc:artifactVersion'] !== undefined && (!node['roc:artifactId'] || !node.about || !node.subjectOf?.length ||
      node.subjectOf.some(file => !isFile(nodes.get(file['@id']))))) throw new Error('research_crate_approval_missing');
  }
  const reachable = new Set<string>();
  const pending = ['./', researchCrateMetadataPath];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = nodes.get(id);
    if (node === undefined) throw new Error('research_crate_reference_missing');
    reachable.add(id);
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (typeof entry === 'object') pending.push(entry['@id']);
        }
      }
    }
  }
  if (reachable.size !== nodes.size) throw new Error('research_crate_unreachable_entity');
  const payload = inventory.map(file => researchExportFileSchema.parse(file))
    .filter(file => ![researchCrateMetadataPath, 'manifest.json'].includes(file.path));
  const files = new Map(payload.map(file => [fileId(file.path), file]));
  if (files.size !== payload.length) throw new Error('research_crate_duplicate_entity');
  for (const node of crate['@graph']) {
    if (!isFile(node) || node['@id'] === 'manifest.json') continue;
    const file = files.get(node['@id']);
    if (file === undefined || file.sha256 !== node.sha256 || file.size !== node.contentSize || file.path !== node.name) {
      throw new Error('research_crate_file_changed');
    }
    files.delete(node['@id']);
  }
  if (files.size > 0) throw new Error('research_crate_file_missing');
  const parts = root.hasPart?.map(part => part['@id']) ?? [];
  const expected = [...payload.map(file => fileId(file.path)), 'manifest.json'];
  if (parts.length !== expected.length || new Set(parts).size !== parts.length || expected.some(id => !parts.includes(id))) {
    throw new Error('research_crate_file_missing');
  }
  return crate;
}

/** Validate real payload bytes as well as metadata, before any archive is considered complete. */
export async function verifyResearchCrateFiles(root: string, document: unknown,
  inventory: readonly ResearchExportFile[], signal: AbortSignal): Promise<void> {
  const crate = validateResearchCrate(document, inventory);
  const paths = inventory.map(file => file.path.normalize('NFC').toLowerCase());
  if (new Set(paths).size !== paths.length) throw new Error('research_crate_duplicate_entity');
  if (!inventory.some(file => file.path === researchCrateMetadataPath)) throw new Error('research_crate_metadata_missing');
  for (const file of inventory) {
    signal.throwIfAborted();
    researchRelativePath(file.path);
    const bytes = await readResearchFile(root, file.path, 64 * 1024 * 1024);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_crate_file_changed');
    if (file.path === researchCrateProfilePath && bytes.toString('utf8') !== researchCrateProfileHtml) {
      throw new Error('research_crate_profile_invalid');
    }
    if (file.path === researchCrateMetadataPath && serializeResearchCrate(JSON.parse(bytes.toString('utf8'))) !== serializeResearchCrate(crate)) {
      throw new Error('research_crate_metadata_changed');
    }
  }
}
