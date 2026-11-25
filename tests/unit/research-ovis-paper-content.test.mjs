import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, symlink, rename, access} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let capture, adapter, content, builder, repository, validator;
before(async () => {
  [capture, adapter, content, builder, repository, validator] = await Promise.all([
    'ovis-pdf-artifact', 'ovis-document-adapter', 'ovis-paper-content', 'paper-ir-builder',
    'paper-ir-repository', 'paper-ir-validation'].map(name => importTypeScriptModule(
      `src/main/plugins/research/${name}.ts`, {platform: 'node',
        external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
});
const hash = value => createHash('sha256').update(value).digest('hex');
const model = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
const block = (category, content, bbox) => ({category, content, bbox});
const raw = JSON.stringify([
  block('paragraph_title', '2 Method', [50, 10, 950, 60]),
  block('text', 'Original prose [1]. Figure 1 and Eq. (2).', [50, 70, 950, 140]),
  block('display_formula', '$$x = y \\tag{2}$$', [50, 160, 950, 210]),
  block('text', 'where $x$ denotes the input.', [50, 220, 950, 260]),
  block('table', '<table><tr><th>F1 (%)</th></tr><tr><td>90 &amp; 91<script>bad()</script></td></tr></table>', [50, 280, 950, 400]),
  block('image', '<img src="../../outside.png">', [50, 420, 950, 650]),
  block('figure_title', 'Figure 1: Original caption.', [50, 660, 950, 700]),
  block('algorithm', 'Algorithm 1 Original\n1: Input\n2: Return output', [50, 710, 950, 780]),
  block('paragraph_title', 'References', [50, 790, 950, 840]),
  block('reference_content', '[1] Original author. Original paper.', [50, 850, 950, 900])
]);
async function fixture(operation, rawOutput = raw, pages = [2]) {
  const root = await mkdtemp('/private/tmp/roc-ovis-content-test-');
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) pdf.addPage([500, 700]).drawText(`Actual PDF page ${i}`, {x: 30, y: 600, font});
    const source = await pdf.save(), sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source);
    const controller = new AbortController(), directory = join(root, 'capture');
    await capture.createOvisPdfArtifact({projectRoot: root, sourcePath, outputDir: directory, pages,
      installation: {identity: model}, signal: controller.signal, timeoutMs: 60000,
      admission: {projectId: 'ovis-content-test', priority: 'user', resourceClass: 'parse'}}, async request => ({
      process: {exitCode: 0, stdout: '', stderr: ''}, pages: request.pages.map(({binding}) => {
        const output = typeof rawOutput === 'function' ? rawOutput(binding.frame.page) : rawOutput;
        return adapter.adaptOvisPage(Buffer.from(output), {protocolVersion: 1, sourceHash: binding.sourceHash, inputImageSha256: binding.inputImageSha256,
          page: binding.frame.page, width: binding.frame.width, height: binding.frame.height, model,
          rawSha256: hash(output), generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding);
      })}));
    const manifestPath = join(directory, 'manifest.json'), manifestBytes = await readFile(manifestPath);
    const request = {directory, manifestSha256: hash(manifestBytes), sourceHash: hash(source), model, signal: controller.signal};
    const manifest = JSON.parse(manifestBytes);
    const repin = async () => {
      const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(manifestPath, bytes); request.manifestSha256 = hash(bytes);
    };
    await operation({root, request, manifest, controller, repin});
  } finally {await rm(root, {recursive: true, force: true});}
}

test('source capture assembles exact prose, formula, table cells and candidate captions into persistent Paper IR', async () => {
  await fixture(async ({root, request, manifest}) => {
    const result = await content.readOvisPaperContent(request);
    assert.equal(result.sourceHash, request.sourceHash); assert.deepEqual(result.model, model);
    assert.equal(result.sourceManifestSha256, request.manifestSha256);
    assert.equal(result.pageCount, 3); assert.deepEqual(result.selectedPages, [2]);
    assert.equal(result.blocks.length, 10); assert.equal(result.assets.length, 3);
    assert.equal(result.content.includes('outside.png'), false); assert.equal(result.content.includes('<table>'), false);
    assert.equal(result.content.includes('bad()'), false); assert.ok(result.content.includes('90 & 91'));
    const formula = result.blocks.find(block => block.equation).equation;
    assert.equal(formula.rawLatex, '$$x = y \\tag{2}$$'); assert.equal(formula.equationNumber, '2');
    assert.equal(formula.variables[0].symbol, 'x');
    const table = result.blocks.find(block => block.table).table;
    assert.equal(table.rawHtml, JSON.parse(raw)[4].content); assert.equal(table.status, 'parsed');
    const figure = result.blocks.find(block => block.kind === 'figure');
    assert.equal(figure.text, ''); assert.equal(figure.imagePath, 'regions/page-2-ovis-6.png');
    assert.equal(figure.visual.objectNumber, null); assert.equal(figure.visual.captions.length, 1);
    assert.equal(figure.visual.captions[0].status, 'candidate');
    assert.ok(figure.visual.captions[0].signals.includes('ovis_unverified_geometry'));
    assert.equal(result.quality.status, 'review'); assert.equal(result.quality.pages[0].ocrCoverage, null);
    assert.ok(result.quality.pages[0].nativeTextCoverage > 0); assert.equal(result.quality.pages[0].readingOrderWarnings, null);
    const identity = {paperId: 'paper', documentId: 'doc', parseId: 'parse', knowledgeDocumentId: 'knowledge',
      sourceHash: result.sourceHash, parserFingerprint: result.parserFingerprint};
    const ir = builder.buildPaperIR({identity, content: result});
    assert.equal(ir.equations.length, 1); assert.equal(ir.tables[0].cells.length, 2);
    assert.equal(ir.figures.length, 1); assert.equal(ir.algorithms[0].steps.length, 3); assert.equal(ir.references.length, 1);
    assert.ok(ir.relations.some(relation => relation.type === 'caption_of' && relation.status === 'candidate'));
    for (const object of validator.paperIRObjects(ir)) {
      assert.deepEqual(object.sourceLocator.locations, [{page: 2, bbox: null, coordinateOrigin: null}]);
    }
    const receipt = await new repository.PaperIRRepository(root).publish(ir);
    assert.deepEqual(await new repository.PaperIRRepository(root).read(receipt), ir);
    assert.equal(hash(await readFile(join(request.directory, 'manifest.json'))), request.manifestSha256);
    assert.equal(JSON.parse(await readFile(join(request.directory, manifest.pages[0].evidence.path), 'utf8')).raw, raw);
    assert.deepEqual(await content.readOvisPaperContent(request), result);
  });
});

test('caller source/model pins and manifest hash reject drift before assembly', async () => {
  await fixture(async ({request}) => {
    for (const patch of [{manifestSha256: 'f'.repeat(64)}, {sourceHash: 'f'.repeat(64)},
      {model: {...model, installationReceiptSha256: 'f'.repeat(64)}}]) {
      await assert.rejects(content.readOvisPaperContent({...request, ...patch}));
    }
  });
});

test('noncontiguous actual pages retain cross-page equation references and never merge table cells across pages', async () => {
  await fixture(async ({request}) => {
    const result = await content.readOvisPaperContent(request);
    assert.deepEqual(result.selectedPages, [1, 3]);
    const equation = result.blocks.find(block => block.equation).equation;
    const reference = equation.references.find(value => value.evidence.locations[0].page === 3);
    assert.ok(reference); assert.equal(reference.evidence.text, 'Eq. (2)');
    assert.deepEqual(reference.evidence.locations, [{page: 3, bbox: null, coordinateOrigin: null}]);
    const tables = result.blocks.filter(block => block.table);
    assert.equal(tables.length, 2); assert.deepEqual(tables.map(block => block.table.source.page), [1, 3]);
    assert.ok(tables.every(block => block.table.rows.every(row => row.cells.every(cell => cell.bbox === null))));
    const ir = builder.buildPaperIR({content: result, identity: {paperId: 'paper', documentId: 'doc', parseId: 'parse',
      knowledgeDocumentId: 'knowledge', sourceHash: result.sourceHash, parserFingerprint: result.parserFingerprint}});
    assert.ok(ir.relations.some(relation => relation.toId === ir.equations[0].id && relation.type === 'references' &&
      relation.sourceLocator.locations[0].page === 3));
  }, page => page === 1 ? raw : JSON.stringify([
    block('text', 'We apply Eq. (2) here.', [50, 100, 900, 200]),
    block('table', '<table><tr><td>Separate page cell</td></tr></table>', [50, 400, 900, 600])
  ]), [1, 3]);
});

test('capture asset bytes, symlinks, crop identities, selection and generated paths cannot become source authority', async () => {
  await fixture(async ({root, request, manifest, repin}) => {
    const page = manifest.pages[0], saved = structuredClone(manifest);
    for (const entry of [page.image, page.evidence, ...page.crops]) {
      const path = join(request.directory, entry.path), original = await readFile(path);
      await writeFile(path, 'corrupt'); await assert.rejects(content.readOvisPaperContent(request), /artifact_changed/);
      await writeFile(path, original);
      const outside = join(root, 'outside'); await writeFile(outside, original); await rm(path); await symlink(outside, path);
      await assert.rejects(content.readOvisPaperContent(request), /symlink/);
      await rm(path); await writeFile(path, original); await rm(outside);
    }
    for (const mutate of [
      value => {value.selectedPages = [1];}, value => {value.pageCount = 1;},
      value => {value.pages[0].crops[0].blockId = 'page-1-ovis-5';},
      value => {value.pages[0].crops[0].rasterBox[0]++;},
      value => {value.pages[0].image.path = '../source.pdf';},
      value => {value.pages[0].crops[1].path = '../../outside.png';},
      value => {value.pages[0].crops.pop();}, value => {value.pages.push(value.pages[0]); value.selectedPages.push(2);}
    ]) {
      Object.assign(manifest, structuredClone(saved)); mutate(manifest); await repin();
      await assert.rejects(content.readOvisPaperContent(request));
    }
  });
});

test('derived saved blocks are ignored; raw EOS, image dimensions and evidence page bindings remain mandatory', async () => {
  await fixture(async ({request, manifest, repin}) => {
    const entry = manifest.pages[0].evidence, path = join(request.directory, entry.path);
    const original = JSON.parse(await readFile(path, 'utf8'));
    const save = async value => {
      const bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes);
      entry.bytes = bytes.length; entry.sha256 = hash(bytes); await repin();
    };
    await save({...original, blocks: [{text: 'invented', citationLocations: [{page: 1, bbox: [1, 2, 3, 4]}]}], warnings: []});
    const result = await content.readOvisPaperContent(request); assert.equal(result.blocks.length, 10);
    for (const mutate of [
      value => {value.frame.page = 1;}, value => {value.native.items[0].page = 1;},
      value => {value.generation.finishReason = 'length';}, value => {value.raw = '[]';},
      value => {value.frame.width++; value.frame.viewport.width++;},
      value => {value.inputImageSha256 = 'e'.repeat(64);}
    ]) {
      const value = structuredClone(original); mutate(value); await save(value);
      await assert.rejects(content.readOvisPaperContent(request));
    }
  });
});

test('cancelled or incomplete captures stay unpublished and preserve the original files', async () => {
  await fixture(async ({request, controller}) => {
    const manifest = join(request.directory, 'manifest.json'), partial = `${manifest}.part`;
    await rename(manifest, partial);
    await assert.rejects(content.readOvisPaperContent(request), error => error.code === 'ENOENT');
    await rename(partial, manifest); controller.abort();
    await assert.rejects(content.readOvisPaperContent(request), {name: 'AbortError'});
    await access(manifest);
  });
});

test('invalid table and formula content remain explicit review objects without fabricated cells or repairs', async () => {
  await fixture(async ({request}) => {
    const result = await content.readOvisPaperContent(request);
    assert.equal(result.blocks[0].table.status, 'invalid'); assert.deepEqual(result.blocks[0].table.rows, []);
    assert.equal(result.blocks[1].equation.status, 'invalid'); assert.equal(result.blocks[1].equation.rawLatex, '\\frac{x');
    assert.equal(result.quality.status, 'review'); assert.ok(result.quality.pages[0].tableWarnings > 0);
    assert.ok(result.quality.pages[0].formulaWarnings > 0);
  }, JSON.stringify([block('table', '<table><tr><td rowspan="99999">bad</td></tr></table>', [50, 100, 900, 400]),
    block('display_formula', '\\frac{x', [50, 500, 900, 600])]));
});
