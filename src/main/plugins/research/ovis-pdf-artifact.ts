import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {researchDocumentLimits} from '../../../shared/schemas/research-production';
import {adaptOvisPage, type OvisAdaptedPage, type OvisSourceBinding} from './ovis-document-adapter';
import {runOvisDocumentPages, type OvisWorkerInput, type OvisWorkerResult} from './ovis-worker';
import {hashResearchFile, prepareResearchJob} from './research-job';
import {extractResearchPdfPageNativeText, renderResearchPdfPage, withResearchPdf} from './pdf-render';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const unprovenExitCodes = new Set(['research_process_kill_failed', 'research_process_supervision_failed',
  'research_process_completion_failed']);
type Asset = {path: string; sha256: string; bytes: number};
type PageArtifact = {page: number; image: Asset; evidence: Asset;
  crops: Array<Asset & {blockId: string; rasterBox: [number, number, number, number]; verification: 'unverified'}>};
export type OvisPdfArtifact = {
  contractVersion: 1; status: 'completed'; sourceHash: string; pageCount: number; selectedPages: number[];
  model: OvisWorkerInput['installation']['identity']; pages: PageArtifact[];
  sourceVerification: 'unverified'; process: OvisWorkerResult['process'];
};
export type OvisPdfArtifactInput = Pick<OvisWorkerInput, 'installation' | 'admission' | 'timeoutMs' | 'signal'> & {
  projectRoot: string; sourcePath: string; outputDir: string;
  /** Actual one-based PDF pages, strictly ascending. Null selects the entire PDF. */
  pages: readonly number[] | null;
};

/** Retain source-bound PDF evidence for qualification. Not a registered parser or Paper IR publication. */
export async function createOvisPdfArtifact(input: OvisPdfArtifactInput,
  run: (request: OvisWorkerInput) => Promise<OvisWorkerResult> = runOvisDocumentPages
): Promise<OvisPdfArtifact> {
  input.signal.throwIfAborted();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('research_ovis_request_invalid');
  const job = await prepareResearchJob({...input, maxSourceBytes: 512 * 1024 ** 2, sourceExtensions: ['.pdf']});
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
    const source = await readFile(job.source);
    if (hash(source) !== job.sourceHash) throw new Error('research_source_changed_during_parse');
    const requests: OvisWorkerInput['pages'][number][] = [];
    const rendered: Array<{image: Asset; native: Awaited<ReturnType<typeof extractResearchPdfPageNativeText>>}> = [];
    const pageCount = await withResearchPdf(source, async pdf => {
      const selected = input.pages === null ? Array.from({length: pdf.numPages}, (_, i) => i + 1) : [...input.pages];
      if (!selected.length || selected.length > 500 || selected.some((page, index) =>
        !Number.isSafeInteger(page) || page < 1 || page > pdf.numPages || (index > 0 && page <= selected[index - 1]))) {
        throw new Error('research_parse_page_range_invalid');
      }
      for (const number of selected) {
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
          rendered.push({image: {path: `pages/page-${number}.png`, sha256, bytes: image.pngBytes}, native});
        } finally {page.cleanup();}
      }
      return pdf.numPages;
    });
    signal.throwIfAborted();
    const result = await run({...input, pages: requests, signal});
    signal.throwIfAborted();
    if (result.pages.length !== requests.length) throw new Error('research_ovis_worker_report_invalid');
    await mkdir(join(job.output, 'evidence'), {mode: 0o700});
    await mkdir(join(job.output, 'regions'), {mode: 0o700});
    const artifacts: PageArtifact[] = [];
    let blockCount = 0, assetCount = requests.length;
    for (const [index, request] of requests.entries()) {
      signal.throwIfAborted();
      const returned = result.pages[index];
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
      const evidence = await store(`evidence/page-${page.frame.page}.json`, Buffer.from(JSON.stringify({
        ...page, native: rendered[index].native
      }) + '\n'), researchDocumentLimits.maxArtifactBytes);
      artifacts.push({page: page.frame.page, image: rendered[index].image, evidence, crops});
    }
    signal.throwIfAborted();
    if (await hashResearchFile(job.source) !== job.sourceHash) throw new Error('research_source_changed_during_parse');
    const artifact: OvisPdfArtifact = {contractVersion: 1, status: 'completed', sourceHash: job.sourceHash, pageCount,
      selectedPages: artifacts.map(page => page.page), model: input.installation.identity, pages: artifacts,
      sourceVerification: 'unverified', process: result.process};
    await store('manifest.json.part', Buffer.from(JSON.stringify(artifact) + '\n'), researchDocumentLimits.maxArtifactBytes);
    signal.throwIfAborted();
    // This is the sole completion marker. Consumers must require it before treating the directory as an artifact.
    await rename(join(job.output, 'manifest.json.part'), join(job.output, 'manifest.json'));
    return artifact;
  } catch (error) {
    if (error instanceof Error && 'code' in error && unprovenExitCodes.has(String(error.code))) safeToClean = false;
    if (safeToClean) {
      try {await rm(job.output, {recursive: true, force: true});}
      catch (cleanup) {throw new AggregateError([error, cleanup], 'research_ovis_artifact_cleanup_failed', {cause: error});}
    }
    throw error;
  } finally {clearTimeout(timer);}
}
