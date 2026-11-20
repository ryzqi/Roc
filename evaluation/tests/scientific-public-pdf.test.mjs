import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import test from 'node:test';
import {PDFDocument} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {hash, sha256} from '../lib/common.mjs';
import {publicPdfArtifactPath, verifyPublicPdfReceipt} from '../adapters/scientific-public/pdf.mjs';

test('fractional PDF viewport verifies rounded raster dimensions and rejects a rehashed ceiling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roc-public-pdf-fractional-'));
  try {
    const sourceRoot = join(root, 'sources'), outputRoot = join(root, 'run');
    mkdirSync(join(sourceRoot, 'pdfs'), {recursive: true});
    mkdirSync(join(outputRoot, 'paper-0/output'), {recursive: true});
    const pdf = await PDFDocument.create();pdf.addPage([595.44, 841.68]);
    const bytes = await pdf.save(), pin = {path: 'pdfs/fractional.pdf', bytes: bytes.length, sha256: sha256(bytes)};
    writeFileSync(join(sourceRoot, pin.path), bytes);
    const loading = getDocument({data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0});
    let viewport;
    try {viewport = (await (await loading.promise).getPage(1)).getViewport({scale: 3});}
    finally {await loading.destroy();}
    const width = Math.round(viewport.width), height = Math.round(viewport.height);
    assert.equal(width, 1786);assert.equal(height, 2525);
    assert.notEqual(width, Math.ceil(viewport.width));assert.notEqual(height, Math.ceil(viewport.height));
    const frame = {kind: 'pdf', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width, height,
      viewport: {width: viewport.width, height: viewport.height, scale: viewport.scale,
        rotation: viewport.rotation, userUnit: viewport.userUnit,
        viewBox: viewport.viewBox, transform: viewport.transform}};
    const result = {sourceHash: pin.sha256, parserFingerprint: 'fractional-fingerprint', modelManifest: '',
      pageCount: 1, parseMode: 'native-text', device: 'cpu', tier: 'complete', content: 'Source',
      blocks: [{id: 'page-1', text: 'Source', imagePath: null,
        locations: [{page: 1, bbox: [0, 0, width, height], coordinateOrigin: 'TOPLEFT'}]}],
      assets: [], artifacts: {structuredContent: 'structured.json'}};
    const {sourceHash: _sourceHash, ...stored} = result;
    const structured = {...stored, coordinateFrameContractVersion: 1,
      pages: [{page: 1, coordinateFrame: frame}]};
    const save = () => {
      writeFileSync(join(outputRoot, 'paper-0/result.json'), JSON.stringify(result));
      writeFileSync(join(outputRoot, 'paper-0/output/structured.json'), JSON.stringify(structured));
      const artifacts = [{path: 'structured.json',
        sha256: sha256(readFileSync(join(outputRoot, 'paper-0/output/structured.json')))}];
      const row = {paperId: 'fractional', source: pin.path, sourceHash: pin.sha256, modelManifest: 'models',
        status: 'parsed', failure: null, result: 'paper-0/result.json', structured: 'paper-0/output/structured.json',
        parserFingerprint: result.parserFingerprint, pageCount: 1, parseMode: 'native-text', blocks: 1,
        artifacts, artifactsHash: hash(artifacts)};
      writeFileSync(join(outputRoot, 'paper-0/receipt.json'), JSON.stringify(row));return row;
    };
    const checked = await verifyPublicPdfReceipt(outputRoot, sourceRoot, save(), 0, pin, 'models');
    assert.equal(checked.geometryVerified, true);
    frame.width = Math.ceil(viewport.width);frame.height = Math.ceil(viewport.height);
    await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, save(), 0, pin, 'models'), /viewport_changed/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('original PDF verifier validates real geometry and rejects provenance or artifact tampering', async t => {
  const root = mkdtempSync(join(tmpdir(), 'roc-public-pdf-'));
  try {
    const sourceRoot = join(root, 'sources'), outputRoot = join(root, 'run');
    mkdirSync(join(sourceRoot, 'qasper/pdfs'), {recursive: true});
    mkdirSync(join(outputRoot, 'paper-0/output'), {recursive: true});
    const pdf = await PDFDocument.create();pdf.addPage([612, 792]);
    const bytes = await pdf.save(), pin = {path: 'qasper/pdfs/test.pdf', bytes: bytes.length, sha256: sha256(bytes)};
    writeFileSync(join(sourceRoot, pin.path), bytes);
    const result = {sourceHash: pin.sha256, parserFingerprint: 'test-fingerprint', modelManifest: '',
      pageCount: 1, parseMode: 'native-text', device: 'cpu', tier: 'complete', content: 'Test source',
      blocks: [{id: 'page-1', text: 'Test source', imagePath: null,
        locations: [{page: 1, bbox: [0, 0, 918, 1188], coordinateOrigin: 'TOPLEFT'}]}],
      assets: [], artifacts: {structuredContent: 'structured.json'}};
    const {sourceHash: _sourceHash, ...stored} = result;
    const structured = {...stored, coordinateFrameContractVersion: 1, pages: [{page: 1,
      coordinateFrame: {kind: 'pdf', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT',
        width: 918, height: 1188, viewport: {width: 918, height: 1188, scale: 1.5, rotation: 0,
          userUnit: 1, viewBox: [0, 0, 612, 792], transform: [1.5, 0, 0, -1.5, 0, 1188]}}}]};
    const save = () => {
      writeFileSync(join(outputRoot, 'paper-0/result.json'), JSON.stringify(result));
      writeFileSync(join(outputRoot, 'paper-0/output/structured.json'), JSON.stringify(structured));
      const artifacts = [{path: 'structured.json',
        sha256: sha256(readFileSync(join(outputRoot, 'paper-0/output/structured.json')))}];
      const row = {paperId: 'test', source: pin.path, sourceHash: pin.sha256, modelManifest: 'test-models',
        status: 'parsed', failure: null, result: 'paper-0/result.json', structured: 'paper-0/output/structured.json',
        parserFingerprint: result.parserFingerprint, pageCount: 1, parseMode: 'native-text', blocks: 1,
        artifacts, artifactsHash: hash(artifacts)};
      writeFileSync(join(outputRoot, 'paper-0/receipt.json'), JSON.stringify(row));return row;
    };
    const row = save();
    await t.test('real PDF viewport and complete block coordinates', async () => {
      const checked = await verifyPublicPdfReceipt(outputRoot, sourceRoot, row, 0, pin, 'test-models');
      assert.equal(checked.geometryVerified, true);assert.equal(checked.pageCount, 1);
      assert.equal(publicPdfArtifactPath(relative(process.cwd(), outputRoot), row.result),
        join(outputRoot, row.result));
    });
    await t.test('changing structured bytes without receipt hash is rejected', async () => {
      writeFileSync(join(outputRoot, 'paper-0/output/structured.json'), '{}');
      await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, row, 0, pin, 'test-models'), /artifact_changed/);
      save();
    });
    await t.test('self-consistent forged transform fails against original PDF geometry', async () => {
      structured.pages[0].coordinateFrame.viewport.transform[5] = 42;
      await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, save(), 0, pin, 'test-models'), /viewport_changed/);
      structured.pages[0].coordinateFrame.viewport.transform[5] = 1188;save();
    });
    await t.test('out-of-page coordinates fail even if all hashes are recomputed', async () => {
      result.blocks[0].locations[0].bbox[2] = 1000;
      await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, save(), 0, pin, 'test-models'), /location_invalid/);
      result.blocks[0].locations[0].bbox[2] = 918;save();
    });
    await t.test('source mismatch and escaped/symlinked paths are rejected', async () => {
      await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, {...row, sourceHash: 'altered'}, 0, pin, 'test-models'), /source_changed/);
      assert.throws(() => publicPdfArtifactPath(outputRoot, '../source.pdf'), /path_invalid/);
      symlinkSync(join(sourceRoot, pin.path), join(outputRoot, 'linked.pdf'));
      assert.throws(() => publicPdfArtifactPath(outputRoot, 'linked.pdf'), /path_invalid/);
    });
    await t.test('explicit failure has no fabricated geometry or page count', async () => {
      const failed = {...row, status: 'failed', failure: {code: 'test_failure'},
        result: null, structured: null, pageCount: null, blocks: null, parseMode: null,
        parserFingerprint: null};
      writeFileSync(join(outputRoot, 'paper-0/receipt.json'), JSON.stringify(failed));
      const checked = await verifyPublicPdfReceipt(outputRoot, sourceRoot, failed, 0, pin, 'test-models');
      assert.equal(checked.sourceVerified, true);assert.equal(checked.geometryVerified, false);
      assert.equal(checked.artifacts, 1);
      writeFileSync(join(outputRoot, 'paper-0/output/structured.json'), '{}');
      await assert.rejects(verifyPublicPdfReceipt(outputRoot, sourceRoot, failed, 0, pin, 'test-models'), /artifact_changed/);
    });
  } finally {rmSync(root, {recursive: true, force: true});}
});
