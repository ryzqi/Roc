import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import {z} from 'zod';
import {assertDocumentReadingLinks} from '../../../shared/schemas/research-document-reading';
import {assertPaperStructure, paperStructureSchema} from '../../../shared/schemas/research-paper-structure';
import {attachPaperTables} from './pdf-table-extractor';
import {attachPaperEquations} from './pdf-equation-extractor';
import {attachPaperVisuals} from './pdf-caption-linker';
import {assessPdfQuality} from './pdf-quality-assessor';
import {verifyOvisParsedDocument} from './ovis-parsed-document';
import {paperParseQualitySchema} from '../../../shared/schemas/research-paper-quality';
import { researchDocumentLimits, researchParsedBlocksSchema, researchParsedDocumentSchema } from '../../../shared/schemas/research-production';
import {storedDocumentContentSchema, type StoredDocumentContent} from './document-repository';
import { readResearchFile, researchContentHash, researchRelativePath } from './research-files';
import {researchCoordinateFrameContractVersion, researchDocumentCoordinateFrameSchema, researchDocumentCoordinateSnapshotSchema,
  type ResearchDocumentCoordinateSnapshot} from '../../../shared/schemas/research-document-coordinates';

export const maximumDocumentBytes = researchDocumentLimits.maxTotalAssetBytes;
// MiddleJson / Markdown 工件上限：P0 实测 15 页论文约 2 MB，留足两页扫描件余量。
export const maximumArtifactBytes = researchDocumentLimits.maxArtifactBytes;
export const documentMediaTypes: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.webp': 'image/webp'
};

export async function documentStorageRoot(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_library_storage_unavailable');
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('research_library_storage_symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('research_library_storage_invalid');
  return await realpath(path);
}

export type CollectedDocumentContent = {data: StoredDocumentContent; coordinates: ResearchDocumentCoordinateSnapshot | null};

export async function collectDocumentContent(root: string, output: string, input: z.infer<typeof researchParsedDocumentSchema>): Promise<CollectedDocumentContent> {
  const parsed = researchParsedDocumentSchema.parse(input);
  const ovis = parsed.engine === 'ovisocr3-mlx' ? await verifyOvisParsedDocument(output, parsed) : null;
  const requiresTables = Number(parsed.parserVersion.match(/^roc-research-parser\/(\d+)$/u)?.[1] ?? 0) >= 6;
  const requiresEquations = Number(parsed.parserVersion.match(/^roc-research-parser\/(\d+)$/u)?.[1] ?? 0) >= 7;
  const requiresVisuals = Number(parsed.parserVersion.match(/^roc-research-parser\/(\d+)$/u)?.[1] ?? 0) >= 8;
  const requiresQuality = Number(parsed.parserVersion.match(/^roc-research-parser\/(\d+)$/u)?.[1] ?? 0) >= 9;
  if (requiresQuality && !parsed.quality) throw new Error('research_document_quality_artifact_mismatch');
  if (requiresTables && parsed.blocks.some(block => block.kind === 'table' && !block.table)) {
    throw new Error('research_document_table_artifact_mismatch');
  }
  if (requiresEquations && parsed.blocks.some(block => block.kind === 'formula' && !block.equation)) {
    throw new Error('research_document_equation_artifact_mismatch');
  }
  if (requiresVisuals && parsed.blocks.some(block => ['figure', 'table'].includes(block.kind) && !block.visual)) {
    throw new Error('research_document_visual_artifact_mismatch');
  }
  assertDocumentReadingLinks(parsed.blocks);
  if (parsed.structure) assertPaperStructure(parsed.structure, parsed.blocks);
  if (parsed.assets.length > researchDocumentLimits.maxAssets || new Set(parsed.blocks.map((block) => block.id)).size !== parsed.blocks.length) {
    throw new Error('research_document_structure_invalid');
  }
  if (parsed.content !== parsed.blocks.filter((block) => block.text.trim()).map((block) => block.text).join('\n\n')) {
    throw new Error('research_document_content_mismatch');
  }
  const assets: StoredDocumentContent['content']['assets'] = [];
  const files: Record<string, string> = {};
  const idsByPath = new Map<string, string>();
  let size = 0;
  for (const asset of parsed.assets) {
    const path = researchRelativePath(asset.path);
    if (idsByPath.has(path) || (asset.page !== null && asset.page > parsed.pageCount)) throw new Error('research_document_asset_invalid');
    const bytes = await readResearchFile(output, path, researchDocumentLimits.maxAssetBytes);
    const sha256 = researchContentHash(bytes);
    if (ovis !== null && (ovis.assetIntegrity[path]?.sha256 !== sha256 || ovis.assetIntegrity[path]?.size !== bytes.length)) {
      throw new Error('research_ovis_artifact_changed');
    }
    size += bytes.length;
    if (size > maximumDocumentBytes) throw new Error('research_document_assets_too_large');
    if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('research_document_asset_format_invalid');
    const id = `asset_${assets.length}`;
    idsByPath.set(path, id);
    files[id] = path;
    assets.push({ id, kind: asset.kind, page: asset.page, size: bytes.length, sha256 });
  }
  const blocks = parsed.blocks.map(({ imagePath, ...block }) => {
    if (!block.locator.trim() || block.locations.some((location) => location.page > parsed.pageCount)) throw new Error('research_document_location_invalid');
    const imageAssetId = imagePath === null ? null : idsByPath.get(imagePath);
    if (imageAssetId === undefined) throw new Error('research_document_asset_unlisted');
    return { ...block, imageAssetId, ...(block.table ? {table: {...block.table, assetId: imageAssetId}} : {}),
      ...(block.equation ? {equation: {...block.equation, assetId: imageAssetId}} : {}),
      ...(block.visual ? {visual: {...block.visual, assetId: imageAssetId}} : {}) };
  });
  // 工件是发布的一部分：缺件不能被当成一次完整成功（提案 §7/§8）。
  const [, , structured] = await Promise.all([parsed.artifacts.middleJson, parsed.artifacts.markdown, parsed.artifacts.structuredContent].map(path =>
    readResearchFile(output, researchRelativePath(path), maximumArtifactBytes)));
  const data = storedDocumentContentSchema.parse({
    outputPath: researchRelativePath(relative(root, output)),
    files,
    content: {...parsed, blocks, assets}
  });
  if (ovis !== null) {
    if (researchContentHash(structured) !== ovis.structuredSha256) throw new Error('research_ovis_artifact_changed');
    return {data, coordinates: researchDocumentCoordinateSnapshotSchema.parse({
      contractVersion: researchCoordinateFrameContractVersion, sourceHash: parsed.sourceHash,
      parseHash: researchContentHash(JSON.stringify(data.content)),
      artifact: {path: parsed.artifacts.structuredContent, sha256: researchContentHash(structured), size: structured.length},
      pages: ovis.frames.map(frame => ({page: frame.page, frame}))
    })};
  }
  const value: unknown = JSON.parse(structured.toString('utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('research_document_coordinate_artifact_invalid');
  if (parsed.structure && (!('structure' in value) ||
      JSON.stringify(paperStructureSchema.parse(value.structure)) !== JSON.stringify(parsed.structure))) {
    throw new Error('research_document_structure_artifact_mismatch');
  }
  if (!('coordinateFrameContractVersion' in value)) {
    if (requiresTables) throw new Error('research_document_coordinate_artifact_invalid');
    return {data, coordinates: null};
  }
  const captured = z.object({
    coordinateFrameContractVersion: z.literal(researchCoordinateFrameContractVersion), parserFingerprint: z.string(),
    content: z.string(), blocks: researchParsedBlocksSchema,
    pages: z.array(z.object({page: z.number().int().positive(), text: z.string(), regions: z.array(z.unknown()),
      coordinateFrame: researchDocumentCoordinateFrameSchema.nullable(),
      nativeTextItems: z.array(z.unknown()).optional(), fusion: z.unknown().optional()}).strict()).max(500)
  }).parse(value);
  if (captured.parserFingerprint !== parsed.parserFingerprint || captured.content !== parsed.content ||
      JSON.stringify(captured.blocks) !== JSON.stringify(parsed.blocks)) throw new Error('research_document_coordinate_artifact_mismatch');
  // Reconstruct current objects from the preserved recognizer output; equal copies alone are insufficient.
  if ((requiresTables || parsed.blocks.some(block => block.table)) &&
      JSON.stringify(attachPaperTables(parsed.blocks, captured.pages)) !== JSON.stringify(parsed.blocks)) {
    throw new Error('research_document_table_artifact_mismatch');
  }
  if ((requiresEquations || parsed.blocks.some(block => block.equation)) &&
      JSON.stringify(attachPaperEquations(parsed.blocks, captured.pages)) !== JSON.stringify(parsed.blocks)) {
    throw new Error('research_document_equation_artifact_mismatch');
  }
  if ((requiresVisuals || parsed.blocks.some(block => block.visual)) &&
      JSON.stringify(attachPaperVisuals(parsed.blocks)) !== JSON.stringify(parsed.blocks)) {
    throw new Error('research_document_visual_artifact_mismatch');
  }
  if (parsed.quality && (!('quality' in value) ||
      JSON.stringify(paperParseQualitySchema.parse(value.quality)) !== JSON.stringify(parsed.quality) ||
      JSON.stringify(assessPdfQuality({pages: captured.pages, blocks: parsed.blocks})) !== JSON.stringify(parsed.quality))) {
    throw new Error('research_document_quality_artifact_mismatch');
  }
  if (captured.pages.some(page => (page.coordinateFrame === null) !== (parsed.parseMode === 'html'))) {
    throw new Error('research_document_coordinate_artifact_invalid');
  }
  const coordinates = researchDocumentCoordinateSnapshotSchema.parse({
    contractVersion: researchCoordinateFrameContractVersion, sourceHash: parsed.sourceHash, parseHash: researchContentHash(JSON.stringify(data.content)),
    artifact: {path: parsed.artifacts.structuredContent, sha256: researchContentHash(structured), size: structured.length},
    pages: captured.pages.map(page => ({page: page.page, frame: page.coordinateFrame}))
  });
  return {data, coordinates};
}
