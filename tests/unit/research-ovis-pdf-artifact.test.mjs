import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb} from 'pdf-lib';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, adapter;
before(async () => {
  api = await importTypeScriptModule('src/main/plugins/research/ovis-pdf-artifact.ts', {platform: 'node',
    external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'});
  adapter = await importTypeScriptModule('src/main/plugins/research/ovis-document-adapter.ts', {platform: 'node'});
});
const hash = value => createHash('sha256').update(value).digest('hex');
const absent = path => assert.rejects(access(path), error => error.code === 'ENOENT');
const identity = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c',
  quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
  installationReceiptSha256: 'a'.repeat(64), inferenceSha256: 'b'.repeat(64),
  promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-ovis-pdf-test-');
  try {
    const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
    for (const rotation of [0, 90, 180, 270]) {
      const page = doc.addPage([240, 300]);
      page.setCropBox(20, 30, 200, 240); page.setRotation(degrees(rotation));
      page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
      page.drawText(`Original page ${rotation}`, {x: 35, y: 220, size: 12, font});
      page.drawRectangle({x: 40, y: 80, width: 100, height: 100, color: rgb(.8, .2, .1)});
    }
    const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, await doc.save());
    const controller = new AbortController();
    await operation({root, controller, input: {projectRoot: root, sourcePath, outputDir: join(root, 'parsed'),
      pages: null, installation: {root, pythonBase: root, inferenceScript: join(root, 'unused.py'), identity},
      signal: controller.signal, timeoutMs: 60000,
      admission: {projectId: 'ovis-pdf-fixture', priority: 'user', resourceClass: 'parse'}}});
  } finally {await rm(root, {recursive: true, force: true});}
}
const raw = JSON.stringify([
  {category: 'text', content: 'Generated text is not source text.', bbox: [10, 20, 900, 120]},
  {category: 'display_formula', content: '\\frac{x}{y}', bbox: [20, 140, 800, 200]},
  {category: 'table', content: '<table><tr><td>42</td></tr></table>', bbox: [100, 250, 500, 500]},
  {category: 'image', content: '<img src="/outside/never-read.png">', bbox: [150, 550, 650, 800]}
]);
function respond(request) {
  return {process: {exitCode: 0, stdout: '', stderr: ''}, pages: request.pages.map(({binding}) =>
    adapter.adaptOvisPage(Buffer.from(raw), {protocolVersion: 1, sourceHash: binding.sourceHash,
      inputImageSha256: binding.inputImageSha256, page: binding.frame.page, width: binding.frame.width,
      height: binding.frame.height, model: binding.model, rawSha256: hash(raw),
      generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding))};
}
async function pixels(image) {
  const canvas = createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return {width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data};
  } finally {canvas.width = 0; canvas.height = 0;}
}

test('real rotated/cropped PDF binds actual rasters, preserves raw/native evidence and crops only source pixels', async () => {
  await fixture(async ({input}) => {
    let calls = 0;
    const result = await api.createOvisPdfArtifact(input, async request => {calls++; return respond(request);});
    assert.equal(calls, 1); assert.equal(result.pageCount, 4); assert.deepEqual(result.selectedPages, [1, 2, 3, 4]);
    assert.equal(result.sourceHash, hash(await readFile(input.sourcePath)));
    assert.deepEqual(JSON.parse(await readFile(join(input.outputDir, 'manifest.json'), 'utf8')), result);
    await absent(join(input.outputDir, 'manifest.json.part'));
    for (const page of result.pages) {
      const evidenceBytes = await readFile(join(input.outputDir, page.evidence.path));
      assert.equal(hash(evidenceBytes), page.evidence.sha256);
      const evidence = JSON.parse(evidenceBytes);
      assert.equal(evidence.raw, raw); assert.deepEqual(evidence.generation.tokenIds, [17, 248046]);
      assert.equal(evidence.frame.viewport.rotation, (page.page - 1) * 90);
      assert.equal(evidence.frame.viewport.userUnit, 2);
      assert.deepEqual(evidence.frame.viewport.viewBox, [20, 30, 220, 270]);
      assert.ok(evidence.native.text.includes('Original page'));
      for (const block of evidence.blocks) {
        assert.equal(block.verification, 'unverified');
        assert.deepEqual(block.citationLocations, [{page: page.page, bbox: null, coordinateOrigin: null}]);
      }
      const rasterBytes = await readFile(join(input.outputDir, page.image.path));
      assert.equal(hash(rasterBytes), evidence.inputImageSha256);
      const raster = await pixels(await loadImage(rasterBytes));
      assert.equal(page.crops.length, 2);
      for (const crop of page.crops) {
        const bytes = await readFile(join(input.outputDir, crop.path)); assert.equal(hash(bytes), crop.sha256);
        const image = await pixels(await loadImage(bytes)), [x1, y1, x2, y2] = crop.rasterBox;
        assert.equal(image.width, x2 - x1); assert.equal(image.height, y2 - y1);
        for (let row = 0; row < image.height; row++) {
          assert.deepEqual(image.data.slice(row * image.width * 4, (row + 1) * image.width * 4),
            raster.data.slice(((row + y1) * raster.width + x1) * 4, ((row + y1) * raster.width + x2) * 4));
        }
      }
    }
  });
});

test('noncontiguous selection preserves PDF page numbers; preexisting output is never overwritten', async () => {
  await fixture(async ({input}) => {
    const result = await api.createOvisPdfArtifact({...input, pages: [2, 4]}, respond);
    assert.deepEqual(result.selectedPages, [2, 4]);
    const before = await readFile(join(input.outputDir, 'manifest.json'));
    await assert.rejects(api.createOvisPdfArtifact(input, respond), /research_output_already_exists/);
    assert.deepEqual(await readFile(join(input.outputDir, 'manifest.json')), before);
  });
});

test('invalid selection, partial output, changed source or raster, and cancellation leave no completion artifact', async () => {
  await fixture(async ({input, controller}) => {
    for (const pages of [[], [0], [5], [2, 1], [1, 1]]) {
      await assert.rejects(api.createOvisPdfArtifact({...input, pages}, () => assert.fail('must not start worker')),
        /research_parse_page_range_invalid/);
      await absent(input.outputDir);
    }
    const original = await readFile(input.sourcePath);
    for (const mode of ['partial', 'source', 'raster', 'raw', 'cancel']) {
      await assert.rejects(api.createOvisPdfArtifact({...input, pages: [1]}, async request => {
        const result = respond(request);
        if (mode === 'partial') result.pages = [];
        if (mode === 'source') await writeFile(input.sourcePath, 'changed PDF');
        if (mode === 'raster') await writeFile(request.pages[0].imagePath, 'changed PNG');
        if (mode === 'raw') result.pages[0].raw = '[]';
        if (mode === 'cancel') controller.abort();
        return result;
      }));
      await absent(input.outputDir); await writeFile(input.sourcePath, original);
    }
  });
});

test('derived worker blocks are reconstructed from bound raw output, never trusted on their own', async () => {
  await fixture(async ({input}) => {
    const artifact = await api.createOvisPdfArtifact({...input, pages: [1]}, request => {
      const result = respond(request); result.pages[0].blocks = []; return result;
    });
    const evidence = JSON.parse(await readFile(join(input.outputDir, artifact.pages[0].evidence.path), 'utf8'));
    assert.equal(evidence.blocks.length, 4); assert.equal(artifact.pages[0].crops.length, 2);
  });
});

test('unproven worker exit retains its source rasters for recovery, without a success marker', async () => {
  await fixture(async ({input}) => {
    for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
      await assert.rejects(api.createOvisPdfArtifact({...input, pages: [1]}, async () => {throw Object.assign(new Error(code), {code});}),
        error => error.code === code);
      await access(join(input.outputDir, 'pages/page-1.png'));
      await absent(join(input.outputDir, 'manifest.json'));
      // The fixture contains no process; only the test may remove this retained recovery directory.
      await rm(input.outputDir, {recursive: true});
    }
  });
});
