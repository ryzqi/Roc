import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {degrees, PDFDocument, rgb} from 'pdf-lib';
import {compareSciegqaPixels, observeSciegqaPaper, sciegqaPdfRegion,
  verifySciegqaObservation} from '../adapters/scientific-public/sciegqa-evidence.mjs';
import {publicPdfArtifactPath} from '../adapters/scientific-public/pdf.mjs';
import {sha256} from '../lib/common.mjs';

const pixels = (width, height, box) => {
  const bytes = new Uint8ClampedArray(width * height * 4).fill(255);
  if (box) for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const i = (y * width + x) * 4; bytes[i] = bytes[i + 1] = bytes[i + 2] = 0;
  }
  return bytes;
};

test('identical visible source pixels are candidates; blank pages never qualify', () => {
  const visible = pixels(100, 100, [20, 20, 40, 40]);
  const exact = compareSciegqaPixels(visible, visible, 100, 100);
  assert.equal(exact.status, 'visual-correspondence-candidate');
  assert.equal(exact.pdf.recall, 1);
  assert.equal(exact.image.recall, 1);
  assert.equal(exact.rgbMeanAbsolute, 0);
  const white = pixels(100, 100);
  assert.equal(compareSciegqaPixels(white, white, 100, 100).status, 'insufficient-visible-content');
  assert.equal(compareSciegqaPixels(white, visible, 100, 100).status, 'insufficient-visible-content');
});

test('shifted content, missing evidence and wrong pages cannot pass fixed coordinates', () => {
  const a = pixels(100, 100, [20, 20, 40, 40]), b = pixels(100, 100, [60, 60, 80, 80]);
  assert.equal(compareSciegqaPixels(a, b, 100, 100).status, 'visual-correspondence-mismatch');
  assert.equal(compareSciegqaPixels(a, b, 100, 100, [.2, .2, .4, .4]).status, 'insufficient-visible-content');
});

test('region-level comparisons detect omissions even when full-page overlap is high', () => {
  const a = pixels(100, 100, [0, 0, 50, 90]), b = pixels(100, 100, [0, 0, 50, 90]);
  for (let y = 70; y < 80; y++) for (let x = 70; x < 80; x++) {
    const i = (y * 100 + x) * 4; a[i] = a[i + 1] = a[i + 2] = 0;
  }
  assert.equal(compareSciegqaPixels(a, b, 100, 100, [.7, .7, .8, .8]).status,
    'insufficient-visible-content');
});

test('transparent black is composited over white; malformed frames and regions reject', () => {
  const transparent = pixels(100, 100, [0, 0, 100, 100]);
  for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
  assert.equal(compareSciegqaPixels(transparent, transparent, 100, 100).status,
    'insufficient-visible-content');
  for (const bbox of [[0, 0, 0, 1], [-1, 0, 1, 1], [0, 0, 2, 1], [0, NaN, 1, 1]]) {
    assert.throws(() => compareSciegqaPixels(transparent, transparent, 100, 100, bbox), /input_invalid/);
    assert.throws(() => sciegqaPdfRegion({}, bbox), /region_invalid/);
  }
  assert.throws(() => compareSciegqaPixels(transparent.subarray(4), transparent, 100, 100), /input_invalid/);
});

async function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sciegqa-evidence-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const pdf = await PDFDocument.create(), page = pdf.addPage([120, 160]);
  page.setCropBox(10, 20, 100, 120); page.setRotation(degrees(90));
  page.drawRectangle({x: 25, y: 45, width: 40, height: 50, color: rgb(0, 0, 0)});
  const bytes = await pdf.save(); writeFileSync(join(root, 'source.pdf'), bytes);
  const loading = getDocument({data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0});
  let viewport;
  try {
    const document = await loading.promise, actual = await document.getPage(1);
    viewport = actual.getViewport({scale: 300 / 72});
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await actual.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
    writeFileSync(join(root, 'page.png'), canvas.toBuffer('image/png'));
  } finally {await loading.destroy();}
  const image = readFileSync(join(root, 'page.png'));
  const paper = {id: 'synthetic-paper', pdf: {path: 'source.pdf', bytes: bytes.length, sha256: sha256(bytes)},
    images: [{path: 'page.png', page: 1, bytes: image.length, sha256: sha256(image),
      width: Math.ceil(viewport.width), height: Math.ceil(viewport.height)}]};
  return {root: resolve(root), paper};
}

test('real rotated CropBox render maps candidates through original PDF transform', async t => {
  const {root, paper} = await sourceFixture(t);
  const result = await observeSciegqaPaper(root, paper,
    [{id: 'published-region', page: 1, normalizedBbox: [.1, .1, .9, .9]}], publicPdfArtifactPath);
  assert.equal(result.pages[0].status, 'visual-correspondence-candidate');
  assert.equal(result.pages[0].frame.rotation, 90);
  assert.deepEqual(result.pages[0].frame.viewBox, [10, 20, 110, 140]);
  const region = result.pages[0].regions[0].candidatePdfRegion;
  assert.ok(region);
  assert.equal(region.humanLocatorReview, false);
  for (let i = 0; i < 4; i++) {
    const [x, y] = region.pdfQuad[i], [a, b, c, d, e, f] = result.pages[0].frame.transform;
    assert.ok(Math.abs(region.viewportQuad[i][0] - (a * x + c * y + e)) < 1e-8);
    assert.ok(Math.abs(region.viewportQuad[i][1] - (b * x + d * y + f)) < 1e-8);
  }
  const repeated = await observeSciegqaPaper(root, paper,
    [{id: 'published-region', page: 1, normalizedBbox: [.1, .1, .9, .9]}], publicPdfArtifactPath);
  verifySciegqaObservation(result, repeated);
  const changed = structuredClone(result);
  changed.pages[0].regions[0].candidatePdfRegion.pdfQuad[0][0]++;
  assert.throws(() => verifySciegqaObservation(changed, repeated), /artifact_changed/);
});

test('missing page images stay explicit and source tampering aborts observation', async t => {
  const {root, paper} = await sourceFixture(t);
  const missing = await observeSciegqaPaper(root, {...paper, images: []}, [], publicPdfArtifactPath);
  assert.equal(missing.pages[0].status, 'missing-original-image');
  assert.deepEqual(missing.pages[0].regions, []);
  writeFileSync(join(root, 'page.png'), Buffer.from('corrupt'));
  await assert.rejects(observeSciegqaPaper(root, paper, [], publicPdfArtifactPath), /source_changed/);
  writeFileSync(join(root, 'source.pdf'), Buffer.from('corrupt'));
  await assert.rejects(observeSciegqaPaper(root, paper, [], publicPdfArtifactPath), /source_changed/);
});
