import type {ResearchExportFile} from '../../../shared/schemas/research-export-file';
import {researchPrivateValueReason, researchPublicFileProjectionSchema} from '../../../shared/schemas/research-public-projection';
import {projectResearchPublicValue, validateResearchPublicProjection} from './export-public-projection';
import {exportFileLimit, type ResearchExportFiles} from './export-files';
import {readResearchFile, researchContentHash} from './research-files';

/** Original code/data bytes are delivered unchanged, after an explicit public-content check. */
export async function copyPublicExportFile(writer: ResearchExportFiles, root: string,
  source: ResearchExportFile, destination: string): Promise<void> {
  const bytes = await readResearchFile(root, source.path, exportFileLimit);
  if (bytes.length !== source.size || researchContentHash(bytes) !== source.sha256) throw new Error('research_export_snapshot_changed');
  assertPublicExportText(bytes.toString('utf8'));
  await writer.write(destination, bytes);
}

export function assertPublicExportText(text: string): void {
  if (researchPrivateValueReason(text) !== null) throw new Error('research_export_private_file');
}

/** Byte identity and canonical JSON identity are different contracts and both are retained. */
export async function writePublicExportFileProjection(writer: ResearchExportFiles, root: string,
  source: ResearchExportFile, destination: string, encoding: 'json' | 'text'): Promise<void> {
  const bytes = await readResearchFile(root, source.path, exportFileLimit);
  if (bytes.length !== source.size || researchContentHash(bytes) !== source.sha256) throw new Error('research_export_snapshot_changed');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value: unknown = encoding === 'json' ? JSON.parse(text) : text;
  const receipt = researchPublicFileProjectionSchema.parse({
    schemaVersion: 1, verification: 'public_file_projection',
    originalFile: {path: source.path, sha256: source.sha256, size: source.size},
    projection: projectResearchPublicValue(value)
  });
  validateResearchPublicProjection(receipt.projection);
  await writer.write(destination, `${JSON.stringify(receipt)}\n`);
}
