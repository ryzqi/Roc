import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, degrees} from 'pdf-lib';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let pdfApi, nativeApi;
before(async () => {
  pdfApi = await importTypeScriptModule('src/main/plugins/research/pdf-render.ts', {
    platform: 'node', external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'});
  nativeApi = await importTypeScriptModule('src/main/plugins/research/pdf-native-text.ts', {platform: 'node'});
});
test('native item bounds use the actual raster viewport for rotation, CropBox and PDF origin', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([500, 600]); page.setCropBox(40, 60, 400, 480); page.setRotation(degrees(rotation));
    page.drawText('Source text with coordinates', {x: 80, y: 400, font, size: 14});
  }
  const bytes = await doc.save();
  await pdfApi.withResearchPdf(bytes, async pdf => {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      try {
        const raw = await pdfApi.extractResearchPdfPageNativeText(page, n);
        const layout = pdfApi.measureResearchPdfPage({page, pageNumber: n, pageCount: pdf.numPages, text: raw.text, scale: 3});
        const items = nativeApi.projectNativeTextItems(raw.items, layout.coordinateFrame);
        const item = items.find(i => i.text.includes('Source text'));
        assert.equal(item.page, n); assert.equal(item.transform[4], 80); assert.equal(item.transform[5], 400);
        assert.equal(item.fontSize, 14); assert.equal(item.direction, 'ltr'); assert.equal(item.geometry, 'font-metrics');
        assert.ok(item.bbox[0] > 0 && item.bbox[1] > 0 && item.bbox[2] < layout.width && item.bbox[3] < layout.height);
        const viewport = page.getViewport({scale: 3});
        const points = item.pdfQuad.map(([x, y]) => viewport.convertToViewportPoint(x, y));
        const expected = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
          Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
        assert.deepEqual(item.bbox, expected);
      } finally {page.cleanup();}
    }
  });
});
test('unknown font metrics and invalid transforms remain explicit without substring geometry', () => {
  const raw = {str: 'test', transform: [10, 0, 0, 10, 30, 40], width: 20, height: 10,
    dir: 'ltr', fontName: 'missing', hasEOL: true};
  const items = nativeApi.captureNativeTextItems({items: [raw, {...raw, transform: [NaN]}], styles: {}}, 2);
  assert.equal(items[0].geometry, 'font-box-fallback'); assert.equal(items[1].geometry, 'unavailable');
  assert.equal(items[1].pdfQuad, null); assert.equal(items[1].bbox, null); assert.equal(items[0].hasEOL, true);
});

test('CropBox clips published bounds while original PDF and unclipped raster geometry survive', () => {
  const raw = {str: 'partially cropped', transform: [10, 0, 0, 10, -10, 20], width: 30, height: 10,
    dir: 'ltr', fontName: 'f', hasEOL: false};
  const captured = nativeApi.captureNativeTextItems({items: [raw, {...raw, str: 'outside', transform: [10, 0, 0, 10, -50, 20]}],
    styles: {f: {ascent: .8, descent: -.2, fontFamily: 'serif', vertical: false}}}, 1);
  const items = nativeApi.projectNativeTextItems(captured, {width: 100, height: 100, viewport: {transform: [1, 0, 0, -1, 0, 100]}});
  assert.deepEqual(items[0].pdfBbox, [-10, 18, 20, 28]); assert.deepEqual(items[0].rasterBbox, [-10, 72, 20, 82]);
  assert.deepEqual(items[0].bbox, [0, 72, 20, 82]); assert.equal(items[0].viewportClipped, true);
  assert.equal(items[1].bbox, null); assert.equal(items[1].viewportClipped, true); assert.equal(items[1].text, 'outside');
});
