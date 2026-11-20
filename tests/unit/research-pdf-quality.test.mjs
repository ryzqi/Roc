import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let quality, parser, publication;
before(async () => {
  [quality, parser, publication] = await Promise.all([
    'src/main/plugins/research/pdf-quality-assessor.ts', 'src/main/plugins/research/document-parser.ts',
    'src/main/plugins/research/document-files.ts'].map(entry => importTypeScriptModule(entry,
      {platform: 'node', external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
});
const frame = {kind: 'image', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: 100, height: 100};
const pdfFrame = {...frame, kind: 'pdf', viewport: {width: 100, height: 100, scale: 1, rotation: 0,
  userUnit: 1, viewBox: [0, 0, 100, 100], transform: [1, 0, 0, -1, 0, 100]}};
const blocks = [{id: 'b', kind: 'paragraph', text: 'original', locator: 'page1',
  locations: [{page: 1, bbox: [0, 0, 100, 100], coordinateOrigin: 'TOPLEFT'}]}];
const fusion = {version: 1, duplicatedRegionCount: 0, warnings: [], provenance: []};
const assess = page => quality.assessPdfQuality({pages: [page], blocks}).pages[0];

test('native and OCR coverage use clipped union area over measured page, independent of characters', () => {
  const page = {page: 1, coordinateFrame: pdfFrame, fusion,
    nativeTextItems: [{page: 1, text: 'a', bbox: [-10, 0, 50, 100]}, {page: 1, text: 'long text', bbox: [25, 0, 75, 100]}],
    regions: [{id: 'r1', text: 'one', bbox: [0, 0, 50, 100]}, {id: 'r2', text: 'two', bbox: [25, 0, 75, 100]},
      {id: 'failed', text: 'discard', bbox: [0, 0, 100, 100], status: 'failed'}]};
  const result = assess(page);
  assert.equal(result.nativeTextCoverage, .75); assert.equal(result.ocrCoverage, .75);
  assert.equal(result.pageArea, 10000); assert.equal(result.status, 'review');
  assert.ok(result.warnings.includes('quality_region_recognition_failed'));
  page.regions.pop();
  assert.equal(assess(page).status, 'good');
  page.nativeTextItems[0].text = 'x'.repeat(100000);
  assert.equal(assess(page).nativeTextCoverage, .75);
});

test('rectangle sweep agrees with independent integer-cell union including nesting, overlap and clipping', () => {
  let seed = 18;
  const rand = n => {seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n;};
  for (let i = 0; i < 100; i++) {
    const boxes = Array.from({length: 15}, () => {
      const x = rand(12) - 2, y = rand(12) - 2; return [x, y, x + rand(8), y + rand(8)];
    });
    let expected = 0;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      if (boxes.some(b => b[0] <= x && b[2] > x && b[1] <= y && b[3] > y)) expected++;
    }
    assert.equal(quality.rectangleUnionArea(boxes, 10, 10), expected);
  }
  assert.throws(() => quality.rectangleUnionArea([[10, 0, 5, 1]], 10, 10), /box_invalid/);
  assert.throws(() => quality.rectangleUnionArea([[0, 0, Infinity, 1]], 10, 10));
});

test('missing native/fusion observations stay null; absent geometry, disputes, object warnings and failures remain explicit', () => {
  const old = assess({page: 1, coordinateFrame: pdfFrame, regions: []});
  assert.equal(old.nativeTextCoverage, null); assert.equal(old.duplicatedRegionCount, null);
  assert.equal(old.readingOrderWarnings, null); assert.equal(old.status, 'review');
  const page = {page: 1, coordinateFrame: pdfFrame, regions: [],
    nativeTextItems: [{page: 1, text: 'source', bbox: null}],
    fusion: {...fusion, duplicatedRegionCount: 1, warnings: ['native_geometry_unavailable', 'recognition_disagreement:b']}};
  const result = assess(page);
  assert.equal(result.nativeTextCoverage, null); assert.equal(result.readingOrderWarnings, 1);
  assert.ok(result.warnings.includes('quality_recognition_disagreement'));
  const failed = quality.assessPdfQuality({pages: [page], blocks, failure: 'original_parser_failure'});
  assert.equal(failed.status, 'failed'); assert.equal(failed.pages[0].failure, 'original_parser_failure');
  assert.equal(quality.assessPdfQuality({pages: [], blocks: [], failure: 'decode_failed'}).status, 'failed');
  assert.throws(() => assess({...page, nativeTextItems: [{page: 2, text: 'wrong', bbox: null}]}), /page_invalid/);
  const object = quality.assessPdfQuality({pages: [page], blocks: [...blocks,
    {...blocks[0], id: 't', kind: 'table'}, {...blocks[0], id: 'e', kind: 'formula'}]}).pages[0];
  assert.equal(object.tableWarnings, 1); assert.equal(object.formulaWarnings, 1);
});

test('actual native PDF and HTML parse publish quality; copied report corruption and omission reject', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-quality-')), root = await realpath(directory);
  try {
    for (const extension of ['pdf', 'html']) {
      const sourcePath = join(root, 'source.' + extension), outputDir = join(root, extension);
      await writeFile(sourcePath, extension === 'pdf' ? await readFile('tests/fixtures/research-workflow/source.pdf') :
        '<h1>Results</h1><p>Original scientific paragraph.</p><table><tr><td>cell</td></tr></table>');
      const parsed = await parser.parseResearchDocument({projectRoot: root, sourcePath, outputDir,
        options: {tier: 'compact', device: 'cpu', pageRange: '1'}, modelFiles: null, modelManifest: ''});
      assert.equal(parsed.quality.pages.length, 1);
      const collected = await publication.collectDocumentContent(root, outputDir, parsed);
      assert.deepEqual(collected.data.content.quality, parsed.quality);
      if (extension === 'pdf') {
        assert.ok(parsed.quality.pages[0].nativeTextCoverage > 0);
        const path = join(outputDir, parsed.artifacts.structuredContent), captured = JSON.parse(await readFile(path, 'utf8'));
        const changed = structuredClone(parsed); changed.quality.pages[0].nativeTextCoverage = .999;
        await writeFile(path, JSON.stringify({...captured, quality: changed.quality}));
        await assert.rejects(publication.collectDocumentContent(root, outputDir, changed), /quality_artifact_mismatch/);
        delete changed.quality;
        await assert.rejects(publication.collectDocumentContent(root, outputDir, changed), /quality_artifact_mismatch/);
        await writeFile(path, JSON.stringify(captured));
      } else assert.equal(parsed.quality.pages[0].nativeTextCoverage, null);
    }
  } finally {await rm(directory, {recursive: true, force: true});}
});
