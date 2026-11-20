import assert from 'node:assert/strict';
import test from 'node:test';
import {PDFDocument, StandardFonts, degrees} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {stableNativeFusionValue, verifyScientificNativeFusion, verifyScientificNativeTextSource} from '../lib/scientific-native-fusion.mjs';
import {observeScientificPdfStructure} from '../adapters/scientific-pdf.mjs';

function fixture() {
  const block = {id: 'ocr-1', kind: 'paragraph', text: 'Precise native text', imagePath: null,
    locations: [{page: 1, bbox: [28, 28, 245, 47], coordinateOrigin: 'TOPLEFT'}]};
  const page = {page: 1, text: 'Precise native text', coordinateFrame: {kind: 'pdf', unit: 'raster-pixel', page: 1, width: 600, height: 800,
    coordinateOrigin: 'TOPLEFT', viewport: {transform: [1, 0, 0, -1, 0, 800], scale: 1,
      width: 600, height: 800, userUnit: 1, rotation: 0, viewBox: [0, 0, 600, 800]}},
  regions: [{id: block.id, type: 'text', text: 'precise native text', bbox: [28, 28, 245, 47], score: .82, imagePath: null}],
  nativeTextItems: [{id: 'native-1', page: 1, text: 'Precise native text', bbox: [30, 30, 240, 45]}],
  fusion: {version: 1, warnings: [], provenance: [{blockId: block.id, source: 'merged', confidence: .82,
    overlapGroupId: 'overlap:ocr-1', nativeItemIds: ['native-1'], status: 'selected',
    alternatives: [{source: 'native', text: block.text}, {source: 'ocr', text: 'precise native text'}]}]}};
  return {page, blocks: [block]};
}

test('independent fusion observation keeps raw OCR and selected native text separately', () => {
  const {page, blocks} = fixture();
  assert.equal(verifyScientificNativeFusion(page, blocks).representedItems, 1);
  const observation = observeScientificPdfStructure({status: 'parsed', failure: null, pageCount: 1,
    parserFingerprint: 'parser-4', artifacts: []}, {coordinateFrameContractVersion: 1, parserFingerprint: 'parser-4',
    pages: [page], blocks, assets: []});
  assert.equal(observation.pages[0].transcript, 'Precise native text');
  assert.equal(observation.pages[0].predictions[0].regionText, 'precise native text');
});

test('coherently changed selections, originals, owners, scores and missing native coverage reject', () => {
  const mutations = [
    f => {f.blocks[0].text = 'Invented'; f.page.fusion.provenance[0].alternatives[0].text = 'Invented';},
    f => {f.page.fusion.provenance[0].alternatives[1].text = 'Invented';},
    f => {f.page.nativeTextItems[0].bbox = [300, 300, 500, 320];},
    f => {f.page.fusion.provenance[0].confidence = .99;},
    f => {f.page.fusion.provenance[0].source = 'ocr';},
    f => {f.page.nativeTextItems.push({id: 'missing', page: 1, text: 'uncovered source', bbox: [30, 300, 200, 320]});},
  ];
  for (const mutate of mutations) {const f = fixture(); mutate(f);
    assert.throws(() => verifyScientificNativeFusion(f.page, f.blocks), /scientific_native_fusion_/);}
});

test('body disagreement must preserve the native source and the explicit warning', () => {
  const f = fixture(), p = f.page.fusion.provenance[0];
  f.blocks[0].text = 'Different scan'; f.page.regions[0].text = 'Different scan';
  p.source = 'ocr'; p.status = 'disputed'; p.alternatives[1].text = 'Different scan';
  f.page.fusion.warnings.push('recognition_disagreement:ocr-1');
  assert.throws(() => verifyScientificNativeFusion(f.page, f.blocks), /disputed_native_missing/);
  f.blocks.push({id: 'native-1', kind: 'paragraph', text: 'Precise native text', imagePath: null,
    locations: [{page: 1, bbox: [30, 30, 240, 45], coordinateOrigin: 'TOPLEFT'}]});
  f.page.fusion.provenance.push({blockId: 'native-1', source: 'native', confidence: null,
    overlapGroupId: 'overlap:ocr-1', nativeItemIds: ['native-1'], alternatives: [], status: 'disputed'});
  assert.equal(verifyScientificNativeFusion(f.page, f.blocks).representedItems, 1);
});

test('only the documented PDF.js loading-task font counter is ignored by content comparison', () => {
  const a = {fontName: 'g_d0_f1', text: 'source', bbox: [1, 2, 3, 4]};
  assert.deepEqual(stableNativeFusionValue(a), stableNativeFusionValue({...a, fontName: 'g_d12_f1'}));
  for (const changed of [{...a, text: 'changed'}, {...a, bbox: [1, 2, 3, 5]}, {...a, fontName: 'g_d12_f2'}]) {
    assert.notDeepEqual(stableNativeFusionValue(a), stableNativeFusionValue(changed));
  }
  assert.equal(stableNativeFusionValue({fontName: 'custom_font'}).fontName, 'custom_font');
});

test('fresh original PDF independently verifies saved native fields and geometry and rejects coherent corruption', async () => {
  const api = await importTypeScriptModule('src/main/plugins/research/pdf-native-text.ts', {platform: 'node'});
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([500, 600]); page.setCropBox(40, 60, 400, 480); page.setRotation(degrees(rotation));
    page.drawText('Original source', {x: 80, y: 400, font, size: 14});
  }
  const bytes = await doc.save(), first = getDocument({data: bytes.slice(), useSystemFonts: true, verbosity: 0});
  const second = getDocument({data: bytes.slice(), useSystemFonts: true, verbosity: 0});
  try {
    const a = await first.promise, b = await second.promise;
    for (let n = 1; n <= 4; n++) {
      const page = await a.getPage(n), original = await b.getPage(n), content = await page.getTextContent();
      const viewport = page.getViewport({scale: 3}), frame = {width: Math.round(viewport.width),
        height: Math.round(viewport.height), viewport};
      const saved = {page: n, coordinateFrame: frame,
        nativeTextItems: api.projectNativeTextItems(api.captureNativeTextItems(content, n), frame)};
      const fresh = await original.getTextContent();
      assert.equal(verifyScientificNativeTextSource(saved, fresh).sourceTextAndGeometryVerified, true);
      for (const mutate of [
        s => {s.nativeTextItems[0].text = 'changed';},
        s => {s.nativeTextItems[0].pdfQuad[0][0] += 1;},
        s => {s.nativeTextItems[0].bbox[0] += 1;},
        s => {s.nativeTextItems[0].rasterBbox[0] += 1;},
        s => {s.nativeTextItems[0].viewportClipped = true;},
        s => {s.nativeTextItems[0].fontName = 'g_d100_f999';},
        s => {s.nativeTextItems.splice(0, 1);},
      ]) {const changed = structuredClone(saved); mutate(changed);
        assert.throws(() => verifyScientificNativeTextSource(changed, fresh), /scientific_native_fusion_source_/);}
      page.cleanup(); original.cleanup();
    }
  } finally {await first.destroy(); await second.destroy();}
});
