import {existsSync, lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {hash, readJson, sha256} from '../../lib/common.mjs';
import {verifyScientificNativeTextSource} from '../../lib/scientific-native-fusion.mjs';

export function publicPdfArtifactPath(root, name) {
  root = resolve(root);
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(name) === name) {
    throw new Error('scientific_pdf_artifact_path_invalid');
  }
  for (let current = path; current !== root; current = resolve(current, '..')) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('scientific_pdf_artifact_path_invalid');
  }
  if (!lstatSync(path).isFile()) throw new Error('scientific_pdf_artifact_not_regular');
  return path;
}

function actualArtifacts(root, path = '') {
  return readdirSync(join(root, path), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? actualArtifacts(root, join(path, entry.name))
      : [{path: join(path, entry.name),
        sha256: sha256(readFileSync(publicPdfArtifactPath(root, join(path, entry.name))))}]);
}

/** Independent host check of locked PDF bytes, persisted artifacts and real
 * PDF.js viewport geometry. Geometry validity does not prove gold alignment. */
export async function verifyPublicPdfReceipt(root, sourceRoot, row, index, pin, modelManifest) {
  if (row.source !== pin.path || row.sourceHash !== pin.sha256 || row.modelManifest !== modelManifest
    || row.paperId !== pin.path.split('/').at(-1).replace(/\.pdf$/u, '')) {
    throw new Error('scientific_pdf_source_changed');
  }
  const source = readFileSync(publicPdfArtifactPath(sourceRoot, pin.path));
  if (source.length !== pin.bytes || sha256(source) !== pin.sha256) throw new Error('scientific_pdf_source_changed');
  if (hash(row) !== hash(readJson(publicPdfArtifactPath(root, `paper-${index}/receipt.json`)))) {
    throw new Error('scientific_pdf_receipt_changed');
  }
  const outputRoot = resolve(root, `paper-${index}/output`);
  const artifacts = existsSync(outputRoot) ? actualArtifacts(outputRoot) : [];
  if (!Array.isArray(row.artifacts) || hash(row.artifacts) !== row.artifactsHash
    || hash(row.artifacts) !== hash(artifacts)) {
    throw new Error('scientific_pdf_artifact_changed');
  }
  if (row.status === 'failed') {
    if (!row.failure?.code || row.result !== null || row.structured !== null || row.pageCount !== null
      || row.parseMode !== null || row.blocks !== null || row.parserFingerprint !== null) {
      throw new Error('scientific_pdf_failure_invalid');
    }
    return {paperId: row.paperId, status: 'failed', failureCode: row.failure.code,
      sourceVerified: true, geometryVerified: false, artifacts: artifacts.length,
      artifactsHash: row.artifactsHash};
  }
  if (row.status !== 'parsed' || row.failure !== null || row.result !== `paper-${index}/result.json`) {
    throw new Error('scientific_pdf_status_invalid');
  }
  const result = readJson(publicPdfArtifactPath(root, row.result));
  if (row.structured !== `paper-${index}/output/${result.artifacts.structuredContent}`) {
    throw new Error('scientific_pdf_structure_path_invalid');
  }
  const structured = readJson(publicPdfArtifactPath(root, row.structured));
  const {pages, coordinateFrameContractVersion, ...stored} = structured;
  const {sourceHash, ...parsed} = result;
  if (sourceHash !== pin.sha256 || hash(stored) !== hash(parsed)
    || row.parserFingerprint !== result.parserFingerprint || row.pageCount !== result.pageCount
    || row.parseMode !== result.parseMode || row.blocks !== result.blocks.length
    || result.device !== 'cpu' || result.tier !== 'complete'
    || ![modelManifest, ''].includes(result.modelManifest)
    || (result.modelManifest === '' && result.parseMode !== 'native-text')
    || coordinateFrameContractVersion !== 1 || pages.length !== result.pageCount) {
    throw new Error('scientific_pdf_result_invalid');
  }
  const loading = getDocument({data: new Uint8Array(source), useSystemFonts: true,
    isEvalSupported: false, verbosity: 0});
  try {
    const pdf = await loading.promise;
    if (pdf.numPages !== result.pageCount
      || hash(pages.map(page => page.page)) !== hash(Array.from({length: pdf.numPages}, (_, i) => i + 1))) {
      throw new Error('scientific_pdf_pages_invalid');
    }
    const frames = new Map();
    for (const page of pages) {
      const frame = page.coordinateFrame, actualPage = await pdf.getPage(page.page);
      if (frame?.kind !== 'pdf' || frame.page !== page.page || frame.unit !== 'raster-pixel'
        || frame.coordinateOrigin !== 'TOPLEFT' || !Number.isFinite(frame.viewport?.scale)
        || frame.viewport.scale <= 0) throw new Error('scientific_pdf_frame_invalid');
      const viewport = actualPage.getViewport({scale: frame.viewport.scale});
      const close = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;
      // Raster dimensions follow pdf-render.ts; the original floating viewport
      // and transform are checked independently below.
      if (!close(frame.width, Math.round(viewport.width)) || !close(frame.height, Math.round(viewport.height))
        || !close(frame.viewport.width, viewport.width) || !close(frame.viewport.height, viewport.height)
        || frame.viewport.rotation !== viewport.rotation || frame.viewport.userUnit !== viewport.userUnit
        || hash(frame.viewport.viewBox) !== hash(viewport.viewBox)
        || frame.viewport.transform.length !== 6
        || frame.viewport.transform.some((value, i) => !close(value, viewport.transform[i]))) {
        throw new Error('scientific_pdf_viewport_changed');
      }
      if (page.nativeTextItems !== undefined || page.fusion !== undefined) {
        verifyScientificNativeTextSource(page, await actualPage.getTextContent());
      }
      frames.set(page.page, frame); actualPage.cleanup();
    }
    const ids = new Set();
    let locations = 0;
    for (const block of result.blocks) {
      if (ids.has(block.id)) throw new Error('scientific_pdf_block_duplicate');
      ids.add(block.id);
      for (const location of block.locations ?? []) {
        const frame = frames.get(location.page), bbox = location.bbox;
        if (!frame || location.coordinateOrigin !== 'TOPLEFT' || bbox.length !== 4
          || bbox.some(value => !Number.isFinite(value)) || bbox[0] < 0 || bbox[1] < 0
          || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] > frame.width || bbox[3] > frame.height) {
          throw new Error('scientific_pdf_location_invalid');
        }
        locations++;
      }
      if (block.imagePath && !row.artifacts.some(artifact => artifact.path === block.imagePath)) {
        throw new Error('scientific_pdf_block_asset_missing');
      }
    }
    for (const asset of result.assets) {
      if (!row.artifacts.some(artifact => artifact.path === asset.path) || !frames.has(asset.page)) {
        throw new Error('scientific_pdf_asset_missing');
      }
    }
    return {paperId: row.paperId, status: 'parsed', sourceVerified: true, geometryVerified: true,
      pageCount: pdf.numPages, blocks: result.blocks.length, locations,
      artifacts: row.artifacts.length, artifactsHash: row.artifactsHash,
      resultHash: hash(result), parserFingerprint: result.parserFingerprint, parseMode: result.parseMode};
  } finally {await loading.destroy();}
}
