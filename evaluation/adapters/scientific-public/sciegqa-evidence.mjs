import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {getDocument, version as pdfjsVersion} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {hash, ROOT, sha256} from '../../lib/common.mjs';

/** Independent source correspondence observations, never production predictions
 * or a replacement for human review. Fix these rules before the complete run. */
export const sciegqaEvidenceContract = {
  version: 'sciegqa-original-pdf-image-correspondence/1', pdfjsVersion,
  canvasVersion: '1.0.13', scale: 1, publishedDpi: 300,
  dimensionTolerancePixels: 1, inkThreshold: 200, inkTolerancePixels: 1,
  minInkPixels: 32, minDirectionalInkRecall: 0.98, maxRgbMeanAbsolute: 0.05,
  acceptance: 'fixed-frame-visual-correspondence-candidate',
  humanLocatorReview: false,
  mapperHash: sha256(readFileSync(new URL(import.meta.url))),
};

export function compareSciegqaPixels(pdfPixels, imagePixels, width, height,
  bbox = [0, 0, 1, 1]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * height > 10_000_000 || pdfPixels.length !== width * height * 4
    || imagePixels.length !== pdfPixels.length || !Array.isArray(bbox) || bbox.length !== 4
    || bbox.some(n => !Number.isFinite(n))
    || !(0 <= bbox[0] && bbox[0] < bbox[2] && bbox[2] <= 1
      && 0 <= bbox[1] && bbox[1] < bbox[3] && bbox[3] <= 1)) {
    throw new Error('scientific_sciegqa_pixel_input_invalid');
  }
  // Fixed absolute positions; never search for a shift, another page or a crop.
  const roi = [Math.floor(bbox[0] * width), Math.floor(bbox[1] * height),
    Math.ceil(bbox[2] * width), Math.ceil(bbox[3] * height)];
  const [x0, y0, x1, y1] = roi, count = (x1 - x0) * (y1 - y0);
  const bits = pixels => {
    const values = new Uint8Array(width * height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4, alpha = pixels[i + 3] / 255;
      const gray = (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722)
        * alpha + 255 * (1 - alpha);
      values[y * width + x] = gray < sciegqaEvidenceContract.inkThreshold ? 1 : 0;
    }
    return values;
  };
  const a = bits(pdfPixels), b = bits(imagePixels);
  const directional = (source, target) => {
    let ink = 0, matched = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (source[y * width + x]) {
      ink++;
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= x0 && x + dx < x1 && y + dy >= y0 && y + dy < y1
          && target[(y + dy) * width + x + dx]) {found = true; break;}
      }
      if (found) matched++;
    }
    return {ink, matched, recall: ink ? matched / ink : null};
  };
  const pdf = directional(a, b), image = directional(b, a);
  let difference = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const overWhite = p => p[i + c] * p[i + 3] / 255 + 255 - p[i + 3];
      difference += Math.abs(overWhite(pdfPixels) - overWhite(imagePixels));
    }
  }
  const rgbMeanAbsolute = difference / (count * 3 * 255);
  const sufficientInk = Math.min(pdf.ink, image.ink) >= sciegqaEvidenceContract.minInkPixels;
  const candidate = sufficientInk
    && Math.min(pdf.recall, image.recall) >= sciegqaEvidenceContract.minDirectionalInkRecall
    && rgbMeanAbsolute <= sciegqaEvidenceContract.maxRgbMeanAbsolute;
  return {roi, pdf, image, rgbMeanAbsolute, sufficientInk,
    status: candidate ? 'visual-correspondence-candidate'
      : sufficientInk ? 'visual-correspondence-mismatch' : 'insufficient-visible-content'};
}

export function sciegqaPdfRegion(viewport, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(n => !Number.isFinite(n))
    || !(0 <= bbox[0] && bbox[0] < bbox[2] && bbox[2] <= 1
      && 0 <= bbox[1] && bbox[1] < bbox[3] && bbox[3] <= 1)) {
    throw new Error('scientific_sciegqa_region_invalid');
  }
  const quad = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
    .map(([x, y]) => [x * viewport.width, y * viewport.height]);
  return {viewportQuad: quad, pdfQuad: quad.map(([x, y]) => viewport.convertToPdfPoint(x, y)),
    granularity: 'published-semantic-region', humanLocatorReview: false};
}

function verifiedBytes(root, pin, assetPath) {
  const bytes = readFileSync(assetPath(root, pin.path));
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
    throw new Error('scientific_sciegqa_correspondence_source_changed');
  }
  return bytes;
}

/** Whole released PDF/image page sets, with region-level observations. No
 * fuzzy text match, model inference or inferred human identities. */
export async function observeSciegqaPaper(root, paper, regions, assetPath) {
  const identity = {id: paper.id, sourceHash: paper.pdf?.sha256 ?? null};
  if (!paper.pdf) return {...identity, status: 'missing-original-pdf', pages: []};
  const loading = getDocument({
    data: new Uint8Array(verifiedBytes(root, paper.pdf, assetPath)), isEvalSupported: false,
    useSystemFonts: true, disableFontFace: true, verbosity: 0,
    standardFontDataUrl: join(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules/pdfjs-dist/cmaps') + '/', cMapPacked: true,
    wasmUrl: join(ROOT, 'node_modules/pdfjs-dist/wasm') + '/',
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 256) throw new Error('scientific_sciegqa_correspondence_page_budget');
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), viewport = page.getViewport({scale: sciegqaEvidenceContract.scale});
      const imagePin = paper.images.find(image => image.page === n);
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      const base = {page: n, frame: {width: viewport.width, height: viewport.height,
        scale: viewport.scale, rotation: viewport.rotation, userUnit: viewport.userUnit,
        viewBox: viewport.viewBox, transform: viewport.transform},
      imageHash: imagePin?.sha256 ?? null, width, height};
      try {
        if (!imagePin) {pages.push({...base, status: 'missing-original-image', regions: []}); continue;}
        if (width * height > 10_000_000) throw new Error('scientific_sciegqa_correspondence_pixel_budget');
        const dpiScale = sciegqaEvidenceContract.publishedDpi / 72;
        const geometry = Math.abs(imagePin.width - viewport.width * dpiScale) <= 1
          && Math.abs(imagePin.height - viewport.height * dpiScale) <= 1;
        const image = await loadImage(verifiedBytes(root, imagePin, assetPath));
        if (image.width !== imagePin.width || image.height !== imagePin.height) {
          throw new Error('scientific_sciegqa_correspondence_dimensions_changed');
        }
        const pdfCanvas = createCanvas(width, height), imageCanvas = createCanvas(width, height);
        const imageContext = imageCanvas.getContext('2d');
        imageContext.fillStyle = 'white'; imageContext.fillRect(0, 0, width, height);
        imageContext.drawImage(image, 0, 0, width, height);
        await page.render({canvas: pdfCanvas, canvasContext: pdfCanvas.getContext('2d'), viewport}).promise;
        const a = pdfCanvas.getContext('2d').getImageData(0, 0, width, height).data;
        const b = imageContext.getImageData(0, 0, width, height).data;
        const comparison = compareSciegqaPixels(a, b, width, height);
        const candidate = geometry && comparison.status === 'visual-correspondence-candidate';
        const observations = regions.filter(region => region.page === n).map(region => {
          const local = compareSciegqaPixels(a, b, width, height, region.normalizedBbox);
          const matched = candidate && local.status === 'visual-correspondence-candidate';
          return {id: region.id, normalizedBbox: region.normalizedBbox, comparison: local,
            status: matched ? 'visual-correspondence-candidate' : 'unqualified-source-region',
            // Coordinates remain candidates; failed comparisons never get an accepted locator.
            candidatePdfRegion: matched ? sciegqaPdfRegion(viewport, region.normalizedBbox) : null};
        });
        pages.push({...base, imageGeometryMatches300Dpi: geometry, comparison,
          status: candidate ? 'visual-correspondence-candidate' : 'unqualified-source-page',
          regions: observations});
      } catch (error) {
        // Source corruption is not an observation; fail the reconstruction.
        if (/source_changed|dimensions_changed/.test(error.message)) throw error;
        pages.push({...base, status: 'page-observation-failed', failure: error.message, regions: []});
      } finally {page.cleanup();}
    }
    return {...identity, status: 'observed-unreviewed', pdfPages: pdf.numPages,
      imagePages: paper.images.length, extraImages: paper.images.filter(p => p.page > pdf.numPages)
        .map(p => p.page), pages};
  } finally {await loading.destroy();}
}

export function verifySciegqaObservation(actual, reconstructed) {
  if (hash(actual) !== hash(reconstructed)) throw new Error('scientific_sciegqa_correspondence_artifact_changed');
}
