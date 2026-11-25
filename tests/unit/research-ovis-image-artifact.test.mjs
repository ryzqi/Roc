import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {materializeArchitectureCorpus} from '../fixtures/architecture-repair/materialize.mjs';
let capture, adapter, assembler;
before(async () => {
  [capture, adapter, assembler] = await Promise.all(['ovis-source-artifact', 'ovis-document-adapter', 'ovis-paper-content']
    .map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
      external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
});
const hash = value => createHash('sha256').update(value).digest('hex');
const signal = new AbortController().signal;
const identity = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
function respond(request) {
  return {process: {exitCode: 0, stdout: '', stderr: ''}, pages: request.pages.map(({binding}) => {
    const raw = JSON.stringify([{category: 'text', content: `Actual image page ${binding.frame.page}`, bbox: [0, 0, 999, 999]},
      {category: 'image', content: '<img src="../../outside">', bbox: [0, 0, 999, 999]}]);
    return adapter.adaptOvisPage(Buffer.from(raw), {protocolVersion: 1, sourceHash: binding.sourceHash,
      inputImageSha256: binding.inputImageSha256, page: binding.frame.page, width: binding.frame.width,
      height: binding.frame.height, model: identity, rawSha256: hash(raw),
      generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding);
  })};
}
async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-ovis-image-test-');
  try {
    const input = {sourceKind: 'image', projectRoot: root, sourcePath: join(root, 'source.png'), outputDir: join(root, 'capture'),
      pages: null, installation: {identity}, signal, timeoutMs: 60000,
      admission: {projectId: 'ovis-image-test', priority: 'user', resourceClass: 'parse'}};
    await operation({root, input});
  } finally {await rm(root, {recursive: true, force: true});}
}
async function readContent(input, manifest) {
  return assembler.readOvisPaperContent({directory: input.outputDir,
    manifestSha256: hash(await readFile(join(input.outputDir, 'manifest.json'))), sourceHash: manifest.sourceHash, model: identity, signal});
}

for (const format of ['png', 'jpeg', 'webp', 'bmp']) test(`${format} captures measured pixels and assembles page-only image sources`, async () => {
  await fixture(async ({root, input}) => {
    const canvas = createCanvas(40, 30), context = canvas.getContext('2d');
    let bytes;
    try {
      context.fillStyle = '#fff'; context.fillRect(0, 0, 40, 30);
      context.fillStyle = '#000'; context.fillRect(10, 5, 15, 20);
      if (format === 'bmp') {
        // A real 24-bit, one-pixel BMP with a padded row; no encoder-specific fixtures.
        bytes = Buffer.alloc(58); bytes.write('BM'); bytes.writeUInt32LE(58, 2); bytes.writeUInt32LE(54, 10);
        bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(1, 22);
        bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(4, 34);
        bytes.set([20, 40, 60], 54);
      } else bytes = await canvas.encode(format);
    } finally {canvas.width = 0; canvas.height = 0;}
    input.sourcePath = join(root, `source.${format}`); await writeFile(input.sourcePath, bytes);
    const result = await capture.createOvisSourceArtifact(input, respond);
    assert.equal(result.sourceHash, hash(bytes)); assert.equal(result.pageCount, 1);
    assert.deepEqual(result.selectedPages, [1]);
    const evidence = JSON.parse(await readFile(join(input.outputDir, result.pages[0].evidence.path)));
    assert.equal(evidence.frame.kind, 'image'); assert.deepEqual(evidence.native, {text: '', items: []});
    const original = await loadImage(bytes), page = await loadImage(await readFile(join(input.outputDir, result.pages[0].image.path)));
    assert.equal(page.width, original.width); assert.equal(page.height, original.height);
    const pixelCanvas = createCanvas(page.width, page.height);
    try {
      const ctx = pixelCanvas.getContext('2d'); ctx.drawImage(original, 0, 0);
      const before = ctx.getImageData(0, 0, page.width, page.height).data;
      ctx.clearRect(0, 0, page.width, page.height); ctx.drawImage(page, 0, 0);
      assert.deepEqual(ctx.getImageData(0, 0, page.width, page.height).data, before);
    } finally {pixelCanvas.width = 0; pixelCanvas.height = 0;}
    const content = await readContent(input, result);
    assert.equal(content.blocks.length, 2); assert.equal(content.blocks[1].text, '');
    assert.deepEqual(content.blocks[1].locations, [{page: 1, bbox: null, coordinateOrigin: null}]);
    assert.equal(content.quality.pages[0].nativeTextCoverage, 0);
    assert.equal(content.quality.pages[0].ocrCoverage, null); assert.equal(content.quality.pages[0].readingOrderWarnings, null);
    assert.ok(content.quality.pages[0].warnings.includes('quality_reading_observation_missing'));
    const evidencePath = join(input.outputDir, result.pages[0].evidence.path);
    evidence.native.text = 'invented native text';
    const changed = Buffer.from(JSON.stringify(evidence)); await writeFile(evidencePath, changed);
    result.pages[0].evidence = {...result.pages[0].evidence, bytes: changed.length, sha256: hash(changed)};
    await writeFile(join(input.outputDir, 'manifest.json'), JSON.stringify(result));
    await assert.rejects(readContent(input, result), /source_binding_invalid/);
  });
});

test('multi-page TIFF selection retains actual page numbers and malformed TIFF never starts inference', async () => {
  await fixture(async ({root, input}) => {
    const corpusRoot = join(root, 'corpus'); await mkdir(corpusRoot);
    const corpus = await materializeArchitectureCorpus(corpusRoot, {fileCounts: []});
    input.sourcePath = join(root, 'source.tiff'); input.pages = [2];
    await copyFile(corpus.documents.tiff['multipage-rgb'], input.sourcePath);
    const result = await capture.createOvisSourceArtifact(input, respond);
    assert.equal(result.pageCount, 2); assert.deepEqual(result.selectedPages, [2]);
    assert.equal(result.pages[0].image.path, 'pages/page-2.png');
    const content = await readContent(input, result);
    assert.equal(content.blocks[0].text, 'Actual image page 2'); assert.equal(content.quality.pages[0].page, 2);
    for (const name of ['oversized-ifd', 'malformed-ifd']) {
      await copyFile(corpus.documents.tiff[name], input.sourcePath);
      input.outputDir = join(root, name);
      await assert.rejects(capture.createOvisSourceArtifact(input, () => assert.fail('inference started')), /image_too_large/);
      await assert.rejects(access(input.outputDir), {code: 'ENOENT'});
    }
  });
});

test('image page ranges, source changes and cancellation never publish partial captures', async () => {
  await fixture(async ({root, input}) => {
    const canvas = createCanvas(16, 16);
    const source = await canvas.encode('png'); canvas.width = 0; canvas.height = 0;
    await writeFile(input.sourcePath, source);
    for (const pages of [[], [2], [1, 1], [0]]) {
      await assert.rejects(capture.createOvisSourceArtifact({...input, pages}, () => assert.fail('inference started')), /page_range_invalid/);
      await assert.rejects(access(input.outputDir), {code: 'ENOENT'});
    }
    await assert.rejects(capture.createOvisSourceArtifact(input, async request => {
      await writeFile(input.sourcePath, 'changed'); return respond(request);
    }), /source_changed/);
    await assert.rejects(access(input.outputDir), {code: 'ENOENT'});
    await writeFile(input.sourcePath, source);
    const controller = new AbortController();
    await assert.rejects(capture.createOvisSourceArtifact({...input, signal: controller.signal}, request => {
      controller.abort(); return respond(request);
    }), {name: 'AbortError'});
    await assert.rejects(access(input.outputDir), {code: 'ENOENT'});
    await assert.rejects(capture.createOvisSourceArtifact({...input, sourceKind: 'pdf'}, () => assert.fail('inference started')));
    await assert.rejects(access(input.outputDir), {code: 'ENOENT'});
  });
});
