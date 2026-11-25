import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {researchDocumentLimits, researchParsedDocumentSchema} from '../../../shared/schemas/research-production';
import {paperQualityVersion, paperParseQualitySchema, type PaperParseQuality} from '../../../shared/schemas/research-paper-quality';
import {paperTableVersion} from '../../../shared/schemas/research-paper-table';
import {paperEquationVersion, latexNormalizationVersion} from '../../../shared/schemas/research-paper-equation';
import {paperVisualVersion, assertPaperVisualEvidence, type PaperVisual} from '../../../shared/schemas/research-paper-visual';
import type {PaperStructure} from '../../../shared/schemas/research-paper-structure';
import {researchDocumentCoordinateFrameSchema} from '../../../shared/schemas/research-document-coordinates';
import {adaptOvisPage, ovisModelIdentitySchema, type OvisModelIdentity, type OvisAdaptedPage} from './ovis-document-adapter';
import {readResearchFile, researchContentHash} from './research-files';
import {attachPaperTables} from './pdf-table-extractor';
import {attachPaperEquations} from './pdf-equation-extractor';
import {attachPaperVisuals} from './pdf-caption-linker';
import {assessPdfQuality, type QualityPage} from './pdf-quality-assessor';
import {boundsOfPoints} from './pdf-native-text';
import {buildPaperStructure, paperStructureVersion} from './paper-structure';

export const ovisPaperContentVersion = 'roc-ovis-paper-content/2';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const asset = z.object({path: z.string(), sha256: hash, bytes: z.number().int().positive()}).strict();
const manifestSchema = z.object({contractVersion: z.literal(1), status: z.literal('completed'), sourceHash: hash,
  pageCount: z.number().int().positive().max(10_000), selectedPages: z.array(z.number().int().positive()).min(1).max(500),
  model: ovisModelIdentitySchema, sourceVerification: z.literal('unverified'), process: z.unknown(),
  pages: z.array(z.object({page: z.number().int().positive(), image: asset, evidence: asset,
    crops: z.array(asset.extend({blockId: z.string(), rasterBox: box, verification: z.literal('unverified')}).strict())
      .max(researchDocumentLimits.maxAssets)}).strict()).min(1).max(500)
}).strict();
const nativeItem = z.object({page: z.number().int().positive(), text: z.string(),
  pdfQuad: z.array(z.tuple([z.number(), z.number()])).length(4).nullable()});
const evidenceSchema = z.object({protocolVersion: z.literal(1), sourceHash: hash, inputImageSha256: hash,
  frame: researchDocumentCoordinateFrameSchema, model: ovisModelIdentitySchema, raw: z.string(), rawSha256: hash,
  generation: z.unknown(), native: z.object({text: z.string(), items: z.array(nativeItem).max(100_000)})});
type Block = z.infer<typeof researchParsedDocumentSchema>['blocks'][number];
export type OvisPaperContent = {
  version: typeof ovisPaperContentVersion; sourceHash: string; sourceManifestSha256: string; model: OvisModelIdentity;
  parserFingerprint: string; pageCount: number; selectedPages: number[];
  sourceVerification: 'unverified'; content: string; blocks: Block[]; structure: PaperStructure; quality: PaperParseQuality;
  assets: z.infer<typeof researchParsedDocumentSchema>['assets']; warnings: string[];
};

/** Geometry may suggest a caption, but cannot promote generated coordinates or a relationship to verified evidence. */
function visualCandidates(blocks: Block[], pages: OvisAdaptedPage[]): Block[] {
  const candidates = new Map(pages.flatMap(page => page.blocks.map(block => [block.id, block.candidateRegion] as const)));
  const sources = new Map(blocks.map(block => [block.id, block]));
  const proposed = attachPaperVisuals(blocks.map(block => ({id: block.id, kind: block.kind, text: block.text,
    label: block.label, locator: block.locator, imagePath: block.imagePath,
    locations: [{page: block.locations[0]!.page, bbox: candidates.get(block.id)!.bbox, coordinateOrigin: 'TOPLEFT' as const}]})));
  const values = new Map(proposed.flatMap(block => {
    if (!block.visual) return [];
    const value: PaperVisual = {...block.visual,
      source: {...sources.get(block.id)!.locations[0]!, locator: block.locator}, objectNumber: null,
      captions: block.visual.captions.map(caption => ({...caption, status: 'candidate',
        signals: [...caption.signals, 'ovis_unverified_geometry'],
        evidence: {...caption.evidence, locations: sources.get(caption.evidence.blockId)!.locations}})),
      references: block.visual.references.map(reference => ({...reference, status: 'candidate',
        evidence: {...reference.evidence, locations: sources.get(reference.evidence.blockId)!.locations}})),
      warnings: [...new Set([...block.visual.warnings, 'research_ovis_content_unverified',
        ...(block.visual.captions.length ? ['research_visual_caption_candidate'] : [])])]};
    return [[block.id, value] as const];
  }));
  const result = blocks.map(block => values.has(block.id) ? {...block, visual: values.get(block.id)!} : block);
  assertPaperVisualEvidence(result);
  return result;
}

/** Read only a caller-pinned completed PDF/image capture. Never starts inference or registers a production parser. */
export async function readOvisPaperContent(input: {
  directory: string; manifestSha256: string; sourceHash: string; model: OvisModelIdentity; signal: AbortSignal;
}): Promise<OvisPaperContent> {
  input.signal.throwIfAborted();
  hash.parse(input.manifestSha256); hash.parse(input.sourceHash);
  const model = ovisModelIdentitySchema.parse(input.model);
  if (!isAbsolute(input.directory)) throw new Error('research_absolute_path_required');
  const info = await lstat(input.directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_ovis_artifact_directory_invalid');
  const root = await realpath(input.directory), limits = researchDocumentLimits;
  const bytes = await readResearchFile(root, 'manifest.json', limits.maxArtifactBytes);
  if (researchContentHash(bytes) !== input.manifestSha256) throw new Error('research_ovis_artifact_changed');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.sourceHash !== input.sourceHash || JSON.stringify(manifest.model) !== JSON.stringify(model) ||
      manifest.pages.length !== manifest.selectedPages.length || manifest.pages.some((page, index) =>
        page.page !== manifest.selectedPages[index] || page.page > manifest.pageCount ||
        index > 0 && page.page <= manifest.pages[index - 1]!.page)) throw new Error('research_ovis_source_binding_invalid');
  let totalBytes = bytes.length;
  const read = async (entry: z.infer<typeof asset>, path: string, limit: number): Promise<Buffer> => {
    input.signal.throwIfAborted();
    if (entry.path !== path || entry.bytes > limit) throw new Error('research_ovis_artifact_asset_invalid');
    totalBytes += entry.bytes;
    if (totalBytes > limits.maxTotalAssetBytes) throw new Error('research_document_asset_limit');
    const value = await readResearchFile(root, path, limit);
    input.signal.throwIfAborted();
    if (value.length !== entry.bytes || researchContentHash(value) !== entry.sha256) throw new Error('research_ovis_artifact_changed');
    return value;
  };
  const png = (data: Buffer, width: number, height: number): void => {
    if (data.length < 33 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) throw new Error('research_ovis_artifact_image_invalid');
  };
  const pages: OvisAdaptedPage[] = [], blocks: Block[] = [], assets: OvisPaperContent['assets'] = [];
  const qualityInputs: QualityPage[] = [];
  let sourceKind: 'pdf' | 'image' | undefined;
  for (const entry of manifest.pages) {
    const evidenceBytes = await read(entry.evidence, `evidence/page-${entry.page}.json`, limits.maxArtifactBytes);
    const evidence = evidenceSchema.parse(JSON.parse(evidenceBytes.toString('utf8'))), frame = evidence.frame;
    if (sourceKind !== undefined && sourceKind !== frame.kind || frame.page !== entry.page ||
        evidence.native.items.some(item => item.page !== entry.page) ||
        frame.kind === 'image' && (evidence.native.text !== '' || evidence.native.items.length !== 0)) {
      throw new Error('research_ovis_source_binding_invalid');
    }
    sourceKind = frame.kind;
    const page = adaptOvisPage(Buffer.from(evidence.raw, 'utf8'), {protocolVersion: evidence.protocolVersion,
      sourceHash: evidence.sourceHash, inputImageSha256: evidence.inputImageSha256, model: evidence.model,
      rawSha256: evidence.rawSha256, generation: evidence.generation, page: entry.page,
      width: frame.width, height: frame.height},
    {sourceHash: input.sourceHash, inputImageSha256: entry.image.sha256, frame, model});
    pages.push(page);
    png(await read(entry.image, `pages/page-${entry.page}.png`, limits.maxAssetBytes), frame.width, frame.height);
    assets.push({path: entry.image.path, kind: 'page', page: entry.page});
    const visual = page.blocks.filter(block => block.kind === 'figure' || block.kind === 'table');
    if (visual.length !== entry.crops.length) throw new Error('research_ovis_artifact_crop_invalid');
    for (const [index, block] of visual.entries()) {
      const crop = entry.crops[index]!, [x1, y1, x2, y2] = block.candidateRegion.bbox;
      const expected = [Math.floor(x1), Math.floor(y1), Math.ceil(x2), Math.ceil(y2)];
      if (crop.blockId !== block.id || !crop.rasterBox.every((value, i) => value === expected[i])) {
        throw new Error('research_ovis_artifact_crop_invalid');
      }
      png(await read(crop, `regions/${block.id}.png`, limits.maxAssetBytes), expected[2]! - expected[0]!, expected[3]! - expected[1]!);
      assets.push({path: crop.path, kind: block.kind as 'figure' | 'table', page: entry.page});
    }
    const rawBlocks: Block[] = page.blocks.map(block => ({id: block.id, kind: block.kind,
      label: block.category === 'figure_title' ? 'figure_caption' : block.category,
      text: block.kind === 'figure' ? '' : block.rawContent, locator: `page ${entry.page}`, locations: block.citationLocations,
      imagePath: block.kind === 'figure' || block.kind === 'table' ? `regions/${block.id}.png` : null}));
    const regions = [{regions: page.blocks.map(block => ({id: block.id,
      ...(block.kind === 'table' ? {rawHtml: block.rawContent} : {}),
      ...(block.kind === 'formula' ? {formula: block.rawContent} : {})}))}];
    const tables = attachPaperTables(rawBlocks, regions).map(block => block.table ? {...block,
      text: [block.table.caption, ...block.table.rows.map(row => row.cells.map(cell => cell.text).join('\t')),
        ...block.table.footnotes].filter(value => value !== null && value !== '').join('\n')} : block);
    blocks.push(...tables);
    if (blocks.length > limits.maxBlocks || assets.length > limits.maxAssets) throw new Error('research_document_structure_invalid');
    // The capture retains original PDF coordinates. Project using this exact raster's viewport.
    const nativeTextItems = frame.kind === 'pdf' ? evidence.native.items.map(item => {
      const [a, b, c, d, e, f] = frame.viewport.transform;
      return {page: item.page, text: item.text,
        bbox: item.pdfQuad === null ? null : boundsOfPoints(item.pdfQuad.map(([x, y]) =>
          [a * x + c * y + e, b * x + d * y + f]))};
    }) : undefined;
    qualityInputs.push({page: entry.page, coordinateFrame: frame, nativeTextItems, regions: []});
  }
  input.signal.throwIfAborted();
  const equations = attachPaperEquations(blocks, pages.map(page => ({regions: page.blocks.map(block => ({id: block.id,
    ...(block.kind === 'formula' ? {formula: block.rawContent} : {})}))})));
  const enriched = researchParsedDocumentSchema.shape.blocks.parse(visualCandidates(equations, pages));
  const qualityPages = assessPdfQuality({blocks: enriched, pages: qualityInputs}).pages.map(page => ({...page,
    status: 'review' as const, ocrCoverage: null, readingOrderWarnings: null,
    warnings: [...new Set([...page.warnings, 'research_ovis_content_unverified', 'quality_ocr_geometry_unverified',
      'quality_reading_observation_missing'])]}));
  return {version: ovisPaperContentVersion, sourceHash: input.sourceHash, sourceManifestSha256: input.manifestSha256,
    model, sourceVerification: 'unverified', pageCount: manifest.pageCount, selectedPages: manifest.selectedPages,
    parserFingerprint: researchContentHash(JSON.stringify({version: ovisPaperContentVersion, model,
      paperStructureVersion, paperTableVersion, paperEquationVersion, latexNormalizationVersion, paperVisualVersion,
      paperQualityVersion, selectedPages: manifest.selectedPages})),
    content: enriched.map(block => block.text).filter(text => text.trim()).join('\n\n'), blocks: enriched,
    structure: buildPaperStructure(enriched), assets,
    quality: paperParseQualitySchema.parse({version: paperQualityVersion,
      coverageDefinition: 'clipped-rectangle-union/measured-page-area', pages: qualityPages, status: 'review', failure: null}),
    warnings: [...new Set(pages.flatMap(page => page.warnings))]};
}
