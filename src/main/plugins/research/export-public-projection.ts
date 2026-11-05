import {z} from 'zod';
import {
  researchPrivateValueReason, researchPublicProjectionSchema, type ResearchPublicProjection
} from '../../../shared/schemas/research-public-projection';
import {researchContentHash} from './research-files';

const privateFields = new Set([
  'workspacePath', 'workspaceRoot', 'rootPath', 'depotPath', 'executable', 'prefix', 'basePrefix',
  'destinationPath', 'storagePath'
]);
const credentialKey = /^(?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie|providerConfig|credentials)$/iu;
type Json = z.infer<ReturnType<typeof z.json>>;

/** Preserve source hashes separately from public projection hashes; omissions are part of the receipt. */
export function projectResearchPublicValue(input: unknown): ResearchPublicProjection {
  const source = z.json().parse(input);
  if (JSON.stringify(source) !== JSON.stringify(input)) throw new Error('research_export_projection_invalid');
  const omittedFields: ResearchPublicProjection['omittedFields'] = [];
  const visit = (value: Json, pointer: string): Json => {
    if (typeof value === 'string') {
      const reason = researchPrivateValueReason(value);
      if (reason === null) return value;
      omittedFields.push({pointer, reason});
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${pointer}/${index}`));
    if (value === null || typeof value !== 'object') return value;
    const result: [string, Json][] = [];
    for (const [key, entry] of Object.entries(value)) {
      const keyReason = researchPrivateValueReason(key);
      const safeKey = keyReason === null ? key.replace(/~/gu, '~0').replace(/\//gu, '~1') :
        `omitted-key-${researchContentHash(key)}`;
      const path = `${pointer}/${safeKey}`;
      const reason = keyReason === null ? credentialKey.test(key) ? 'credential' :
        privateFields.has(key) ? 'native_path' : null : 'private_key';
      if (reason !== null) omittedFields.push({pointer: path, reason});
      else result.push([key, visit(entry, path)]);
    }
    return Object.fromEntries(result);
  };
  const value = visit(source, '');
  return researchPublicProjectionSchema.parse({
    schemaVersion: 1, verification: 'public_projection',
    originalSha256: researchContentHash(JSON.stringify(source)),
    projectionSha256: researchContentHash(JSON.stringify(value)), omittedFields, value
  });
}

export function serializeResearchPublicProjection(input: unknown): string {
  return `${JSON.stringify(projectResearchPublicValue(input))}\n`;
}

/** Only the public projection is independently verifiable without the private original source. */
export function validateResearchPublicProjection(input: unknown): ResearchPublicProjection {
  const result = researchPublicProjectionSchema.parse(input);
  if (researchContentHash(JSON.stringify(result.value)) !== result.projectionSha256) throw new Error('research_export_projection_changed');
  const checked = projectResearchPublicValue((input as {value: unknown}).value);
  if (checked.omittedFields.length > 0) throw new Error('research_export_private_metadata');
  return result;
}
