import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {researchDocumentLimits} from '../../../shared/schemas/research-production';
import {adaptOvisPage, type OvisAdaptedPage, type OvisSourceBinding} from './ovis-document-adapter';
import {runOvisDocumentPages, type OvisWorkerInput, type OvisWorkerResult} from './ovis-worker';
import {hashResearchFile, prepareResearchJob} from './research-job';
import {extractResearchPdfPageNativeText, renderResearchPdfPage, withResearchPdf} from './pdf-render';
import {decodeRasterDocument, imagePng} from './research-raster';
import {hasUnprovenResearchProcessExit} from './process-exit-state';
import {readResearchFile} from './research-files';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
type Asset = {path: string; sha256: string; bytes: number};
type PageArtifact = {page: number; image: Asset; evidence: Asset;
  crops: Array<Asset & {blockId: string; rasterBox: [number, number, number, number]; verification: 'unverified'}>};
export type OvisSourceArtifact = {
  contractVersion: 1; status: 'completed'; sourceHash: string; pageCount: number; selectedPages: number[];
  model: OvisWorkerInput['installation']['identity']; pages: PageArtifact[];
  sourceVerification: 'unverified'; process: OvisWorkerResult['process'];
};
export type OvisSourceArtifactInput = Pick<OvisWorkerInput, 'installation' | 'admission' | 'timeoutMs' | 'signal'> & {
  projectRoot: string; sourcePath: string; outputDir: string; sourceKind: 'pdf' | 'image';
  /** Actual one-based PDF or image pages, strictly ascending. Null selects all pages. */
  pages: readonly number[] | null;
};

/** Capture source-bound evidence before producing Paper IR and publishing a document. */
export async function createOvisSourceArtifact(input: OvisSourceArtifactInput,
  run: (request: OvisWorkerInput) => Promise<OvisWorkerResult> = runOvisDocumentPages
): Promise<OvisSourceArtifact> {
  input.signal.throwIfAborted();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('research_ovis_request_invalid');
  if (input.sourceKind !== 'pdf' && input.sourceKind !== 'image') throw new Error('research_ovis_source_kind_invalid');
  const job = await prepareResearchJob({...input, maxSourceBytes: 512 * 1024 ** 2,
    sourceExtensions: input.sourceKind === 'pdf' ? ['.pdf'] : ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']});
  // Exclusive creation protects an existing successful artifact, including a concurrent creator.
  await mkdir(job.output, {mode: 0o700});
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), input.timeoutMs);
  timer.unref();
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  let safeToClean = true, totalBytes = 0;
  const account = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > researchDocumentLimits.maxTotalAssetBytes) throw new Error('research_document_asset_limit');
  };
  const store = async (path: string, bytes: Uint8Array, limit = researchDocumentLimits.maxAssetBytes): Promise<Asset> => {
    signal.throwIfAborted();
    if (bytes.byteLength > limit) throw new Error('research_document_asset_too_large');
    account(bytes.byteLength);
    await writeFile(join(job.output, path), bytes, {flag: 'wx', mode: 0o600});
    return {path, sha256: hash(bytes), bytes: bytes.byteLength};
  };
  try {
    signal.throwIfAborted();
    const requests: OvisWorkerInput['pages'][number][] = [];
    const rendered: Array<{image: Asset; native: Asset | null}> = [];
    await mkdir(join(job.output, 'native'), {mode: 0o700});
    const selection = (pageCount: number): number[] => {
      const selected = input.pages === null ? Array.from({length: pageCount}, (_, i) => i + 1) : [...input.pages];
      if (!selected.length || selected.length > 500 || selected.some((page, index) =>
        !Number.isSafeInteger(page) || page < 1 || page > pageCount || (index > 0 && page <= selected[index - 1]))) {
        throw new Error('research_parse_page_range_invalid');
      }
      return selected;
    };
    // Keep source bytes and PDF/image decoder state out of the inference/consumption lifetime.
    const pageCount = await (async () => {
      const source = await readFile(job.source);
      if (hash(source) !== job.sourceHash) throw new Error('research_source_changed_during_parse');
      return input.sourceKind === 'pdf' ? await withResearchPdf(source, async pdf => {
        for (const number of selection(pdf.numPages)) {
          signal.throwIfAborted();
          const page = await pdf.getPage(number);
          try {
            const native = await extractResearchPdfPageNativeText(page, number);
            signal.throwIfAborted();
            const image = await renderResearchPdfPage(page, number, pdf.numPages, join(job.output, 'pages'), 2, true,
              researchDocumentLimits.maxAssetBytes, {includeRgbaImage: false, text: native.text});
            signal.throwIfAborted();
            if (!image.path) throw new Error('research_pdf_ocr_raster_missing');
            account(image.pngBytes);
            const sha256 = await hashResearchFile(image.path);
            const binding: OvisSourceBinding = {sourceHash: job.sourceHash, inputImageSha256: sha256,
              frame: image.coordinateFrame, model: input.installation.identity};
            requests.push({imagePath: image.path, binding});
            const nativeAsset = await store(`native/page-${number}.json`, Buffer.from(JSON.stringify(native)),
              researchDocumentLimits.maxArtifactBytes);
            rendered.push({image: {path: `pages/page-${number}.png`, sha256, bytes: image.pngBytes}, native: nativeAsset});
          } finally {page.cleanup();}
        }
        return pdf.numPages;
      }) : await (async () => {
        const document = await decodeRasterDocument(source, extname(job.source));
        await mkdir(join(job.output, 'pages'), {mode: 0o700});
        for (const number of selection(document.pageCount)) {
          signal.throwIfAborted();
          const raster = await document.page(number);
          const image = await store(`pages/page-${number}.png`, await imagePng(raster));
          requests.push({imagePath: join(job.output, image.path), binding: {sourceHash: job.sourceHash,
            inputImageSha256: image.sha256, model: input.installation.identity,
            frame: {kind: 'image', page: number, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT',
              width: raster.width, height: raster.height}}});
          rendered.push({image, native: null});
        }
        return document.pageCount;
      })();
    })();
    signal.throwIfAborted();
    await mkdir(join(job.output, 'evidence'), {mode: 0o700});
    await mkdir(join(job.output, 'regions'), {mode: 0o700});
    const artifacts: PageArtifact[] = [];
    let blockCount = 0, assetCount = requests.length;
    const consume = async (returned: OvisAdaptedPage, index: number): Promise<void> => {
      signal.throwIfAborted();
      const request = requests[index];
      if (!request || index !== artifacts.length) throw new Error('research_ovis_worker_report_invalid');
      // Reconstruct derived blocks from raw evidence; a modified candidate object is never persisted as authority.
      const page: OvisAdaptedPage = adaptOvisPage(Buffer.from(returned.raw, 'utf8'), {
        protocolVersion: returned.protocolVersion, sourceHash: returned.sourceHash, inputImageSha256: returned.inputImageSha256,
        page: returned.frame.page, width: returned.frame.width, height: returned.frame.height,
        model: returned.model, rawSha256: returned.rawSha256, generation: returned.generation
      }, request.binding);
      blockCount += page.blocks.length;
      if (blockCount > researchDocumentLimits.maxBlocks) throw new Error('research_document_block_limit');
      const imageBytes = await readFile(request.imagePath);
      if (hash(imageBytes) !== request.binding.inputImageSha256) throw new Error('research_ovis_input_changed');
      const crops: PageArtifact['crops'] = [];
      const visualBlocks = page.blocks.filter(block => block.kind === 'figure' || block.kind === 'table');
      if (visualBlocks.length) {
        const raster = await loadImage(imageBytes);
        if (raster.width !== page.frame.width || raster.height !== page.frame.height) throw new Error('research_ovis_input_changed');
        for (const block of visualBlocks) {
          signal.throwIfAborted();
          if (++assetCount > researchDocumentLimits.maxAssets) throw new Error('research_document_asset_limit');
          const [x1, y1, x2, y2] = block.candidateRegion.bbox;
          const rasterBox: [number, number, number, number] = [Math.floor(x1), Math.floor(y1), Math.ceil(x2), Math.ceil(y2)];
          const [left, top, right, bottom] = rasterBox;
          const canvas = createCanvas(right - left, bottom - top);
          try {
            canvas.getContext('2d').drawImage(raster, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top);
            const asset = await store(`regions/${block.id}.png`, await canvas.encode('png'));
            crops.push({...asset, blockId: block.id, rasterBox, verification: 'unverified'});
          } finally {canvas.width = 0; canvas.height = 0;}
        }
      }
      const nativeAsset = rendered[index].native;
      let native: Awaited<ReturnType<typeof extractResearchPdfPageNativeText>> = {text: '', items: []};
      if (nativeAsset) {
        const bytes = await readResearchFile(job.output, nativeAsset.path, nativeAsset.bytes);
        if (hash(bytes) !== nativeAsset.sha256) throw new Error('research_ovis_input_changed');
        native = JSON.parse(bytes.toString('utf8'));
      }
      const evidence = await store(`evidence/page-${page.frame.page}.json`, Buffer.from(JSON.stringify({
        ...page, native
      }) + '\n'), researchDocumentLimits.maxArtifactBytes);
      if (nativeAsset) {
        await rm(join(job.output, nativeAsset.path));
        totalBytes -= nativeAsset.bytes;
      }
      artifacts.push({page: page.frame.page, image: rendered[index].image, evidence, crops});
    };
    const result = await run({...input, pages: requests, signal, onPage: consume});
    signal.throwIfAborted();
    // Injected/replay Workers may still return pages; production uses the bounded consumer above.
    if (result.pages.length) {
      if (artifacts.length || result.pages.length !== requests.length) throw new Error('research_ovis_worker_report_invalid');
      for (const [index, page] of result.pages.entries()) await consume(page, index);
    }
    if (artifacts.length !== requests.length) throw new Error('research_ovis_worker_report_invalid');
    await rm(join(job.output, 'native'), {recursive: true});
    signal.throwIfAborted();
    if (await hashResearchFile(job.source) !== job.sourceHash) throw new Error('research_source_changed_during_parse');
    const artifact: OvisSourceArtifact = {contractVersion: 1, status: 'completed', sourceHash: job.sourceHash, pageCount,
      selectedPages: artifacts.map(page => page.page), model: input.installation.identity, pages: artifacts,
      sourceVerification: 'unverified', process: result.process};
    await store('manifest.json.part', Buffer.from(JSON.stringify(artifact) + '\n'), researchDocumentLimits.maxArtifactBytes);
    signal.throwIfAborted();
    // This is the sole completion marker. Consumers must require it before treating the directory as an artifact.
    await rename(join(job.output, 'manifest.json.part'), join(job.output, 'manifest.json'));
    return artifact;
  } catch (error) {
    if (hasUnprovenResearchProcessExit(error)) safeToClean = false;
    if (safeToClean) {
      try {await rm(job.output, {recursive: true, force: true});}
      catch (cleanup) {throw new AggregateError([error, cleanup], 'research_ovis_artifact_cleanup_failed', {cause: error});}
    }
    throw error;
  } finally {clearTimeout(timer);}
}
