import {exportValidationPath} from '../../../shared/schemas/research-export-validation';
import {z} from 'zod';
import {researchExportFileSchema, type ResearchExportExecution} from '../../../shared/schemas/research-exports';
import {researchPublicFileProjectionSchema, researchPublicProjectionSchema} from '../../../shared/schemas/research-public-projection';
import {researchCrateMetadataPath, researchPublicTextSchema} from '../../../shared/schemas/research-ro-crate';
import {archiveBuilderProvenance, exportFileLimit} from './export-files';
import {readResearchFile} from './research-files';
import {serializeResearchPublicProjection, validateResearchPublicProjection} from './export-public-projection';
import {verifyResearchCrateFiles} from './export-ro-crate';
import {exportScientificReviewPath} from './export-scientific-review';

export const researchExportManifestSchema = z.strictObject({
  version: z.literal(4), exportId: z.string().min(1),
  request: researchPublicProjectionSchema,
  sourceHash: researchExportFileSchema.shape.sha256,
  toolchainHash: researchExportFileSchema.shape.sha256,
  toolchainVersions: z.record(z.string(), researchPublicTextSchema),
  archiveBuilder: z.json(), files: z.array(researchExportFileSchema).min(1).max(10000)
});

export async function verifyExportPublicBundle(root: string, record: ResearchExportExecution, signal: AbortSignal): Promise<void> {
  const json = async (path: string): Promise<unknown> => JSON.parse((await readResearchFile(root, path, exportFileLimit)).toString('utf8'));
  const manifest = researchExportManifestSchema.parse(await json('manifest.json'));
  const inventory = record.files.filter(file => file.path !== 'manifest.json');
  if (manifest.exportId !== record.id || manifest.sourceHash !== record.sourceHash || manifest.toolchainHash !== record.toolchainHash ||
    JSON.stringify(manifest.files) !== JSON.stringify(inventory) ||
    JSON.stringify(manifest.archiveBuilder) !== JSON.stringify(archiveBuilderProvenance) ||
    JSON.stringify(manifest.request) !== serializeResearchPublicProjection(record.request).trim()) {
    throw new Error('research_export_manifest_changed');
  }
  validateResearchPublicProjection(manifest.request);
  const sources = validateResearchPublicProjection(await json('provenance/sources.json'));
  if (JSON.stringify(sources) !== serializeResearchPublicProjection(record.sources).trim()) throw new Error('research_export_sources_changed');
  validateResearchPublicProjection(await json(exportScientificReviewPath));
  validateResearchPublicProjection(await json(exportValidationPath));
  for (const file of record.files.filter(file => file.path.endsWith('.public.json'))) {
    signal.throwIfAborted();
    const input = await json(file.path);
    if ((input as {verification: string}).verification === 'public_file_projection') {
      const receipt = researchPublicFileProjectionSchema.parse(input);
      validateResearchPublicProjection(receipt.projection);
    } else validateResearchPublicProjection(input);
  }
  await verifyResearchCrateFiles(root, await json(researchCrateMetadataPath), record.files, signal);
}
