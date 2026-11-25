import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let reading, links, paper, fuse, parser, collect, production;
before(async () => {
  [reading, links, paper, fuse] = await Promise.all(['src/main/plugins/research/pdf-document-reading.ts',
    'src/shared/schemas/research-document-reading.ts', 'src/main/plugins/research/paper-ir.ts',
    'src/main/plugins/research/pdf-layout-merge.ts'].map(entry => importTypeScriptModule(entry, {platform: 'node'})));
  const options = {platform: 'node', external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'],
    tempDir: '.runtime/tmp'};
  [parser, collect, production] = await Promise.all(['src/main/plugins/research/document-parser.ts',
    'src/main/plugins/research/document-files.ts', 'src/shared/schemas/research-production.ts']
    .map(entry => importTypeScriptModule(entry, options)));
});
const pages = (...numbers) => numbers.map(page => ({page, coordinateFrame: {kind: 'pdf', width: 600, height: 800}}));
const block = (id, text, page, bbox, extra = {}) => ({id, text, kind: 'paragraph', label: 'Native text', locator: `page${page}`,
  imagePath: null, locations: [{page, bbox, coordinateOrigin: 'TOPLEFT'}], ...extra});
const identity = {paperId: 'paper', parseId: 'parse', sourceHash: 'a'.repeat(64)};
const strip = blocks => blocks.map(({reading: _reading, ...block}) => block);

test('repeated margins and counters retain exact sources; one-off body near edge is preserved', () => {
  const input = [block('h1', 'A study of models', 1, [30, 20, 570, 35], {kind: 'heading'}),
    block('b1', 'Original body.', 1, [30, 180, 280, 220]),
    block('n1', '1', 1, [290, 765, 300, 780]),
    block('h2', 'A study of models', 2, [30, 20, 570, 35], {kind: 'heading'}),
    block('b2', 'Only on this page.', 2, [30, 70, 280, 79]),
    block('n2', '2', 2, [290, 765, 300, 780])];
  const result = reading.annotatePdfDocumentReading(input, pages(1, 2));
  assert.deepEqual(strip(result), input);
  assert.deepEqual(result.map(b => b.reading.role), ['page_header', 'body', 'page_number', 'page_header', 'body', 'page_number']);
  const chunks = paper.paperBlocks(result, identity);
  assert.equal(chunks.length, input.length);
  assert.ok(chunks.every(chunk => chunk.section === null)); // running titles cannot create sections
  assert.equal(result[1].reading.ruleScore, null);
});

test('cross-page open sentence links last right column to first left column past margins', () => {
  const input = [block('a', 'The method learns', 1, [320, 690, 570, 710]),
    block('foot', '1', 1, [290, 770, 300, 780]),
    block('head', '2', 2, [290, 20, 300, 30]),
    block('b', 'representations without labels.', 2, [30, 100, 280, 120])];
  const result = reading.annotatePdfDocumentReading(input, pages(1, 2));
  assert.equal(result[0].reading.continuesTo, 'b'); assert.equal(result[3].reading.continuesFrom, 'a');
  assert.deepEqual(strip(result), input);
  const chunks = paper.paperBlocks(result, identity);
  assert.deepEqual(chunks[0].semantic.relatedBlockIds, ['b']);
  assert.deepEqual(chunks[3].semantic.relatedBlockIds, ['a']);
});

test('completed sentences, page gaps, captions, titles and absent geometry cannot create continuation', () => {
  for (const change of ['sentence', 'gap', 'caption', 'heading', 'geometry', 'page-only']) {
    const left = block('a', change === 'sentence' ? 'The method learns.' : 'The method learns', 1, [30, 690, 280, 710]);
    const right = block('b', 'representations without labels.', change === 'gap' ? 3 : 2, [30, 100, 280, 120],
      change === 'caption' ? {text: 'Figure 1: The model.'} : change === 'heading' ? {text: '2 Method'} : {});
    if (change === 'geometry') right.locations = [];
    if (change === 'page-only') right.locations = [{page: 2, bbox: null, coordinateOrigin: null}];
    const result = reading.annotatePdfDocumentReading([left, right], pages(1, 2, 3));
    assert.ok(result.every(b => b.reading.continuesFrom === null && b.reading.continuesTo === null), change);
  }
});

test('caption role is anchored or layout-derived and is separate from visual object', () => {
  const input = [block('fig', 'axis labels', 1, [30, 200, 280, 400], {kind: 'figure'}),
    block('cap', 'Figure 1: Results on the dataset.', 1, [30, 405, 280, 420]),
    block('ocr', 'Comparison of methods', 1, [320, 405, 570, 420], {label: 'table_caption'}),
    block('body', 'As shown in Figure 1, accuracy improves.', 1, [30, 450, 280, 470])];
  assert.deepEqual(reading.annotatePdfDocumentReading(input, pages(1)).map(b => b.reading.role),
    ['object', 'caption', 'caption', 'body']);
  assert.equal(reading.startsScientificCaption('Figure 1 shows the architecture.'), false);
  assert.equal(reading.startsScientificCaption('表 2：实验结果。'), true);
});

test('native caption does not merge with the adjacent completed body paragraph', () => {
  const items = ['Figure 1: Model performance.', 'The following body remains searchable.'].map((text, i) =>
    ({id: `n${i}`, text, itemIndex: i, page: 1, fontSize: 10, direction: 'ltr', bbox: [30, 100 + i * 15, 280, 110 + i * 15]}));
  const result = fuse.fusePdfPage({page: 1, width: 600, nativeItems: items, regions: []});
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks.map(b => b.text), items.map(item => item.text));
});

test('publication rejects dangling, nonreciprocal, cross-gap and object continuation references', () => {
  const result = reading.annotatePdfDocumentReading([block('a', 'The method learns', 1, [30, 690, 280, 710]),
    block('b', 'representations.', 2, [30, 100, 280, 120])], pages(1, 2));
  for (const mutate of [b => b[0].reading.continuesTo = 'missing', b => b[1].reading.continuesFrom = null,
    b => b[1].locations[0].page = 3, b => b[1].reading.role = 'caption']) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => links.assertDocumentReadingLinks(changed), /research_document_reading_link_invalid/u);
  }
  assert.throws(() => links.researchBlockReadingSchema.parse({...result[0].reading, version: 2}));
});

test('real two-page PDF parser publishes reciprocal links and collect validates exact artifacts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-document-reading-')));
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const page = pdf.addPage([600, 800]);
      page.drawText('RUNNING TITLE', {x: 30, y: 770, font, size: 10});
      page.drawText(i === 0 ? 'The method learns' : 'representations without labels.', {x: 30, y: i === 0 ? 100 : 700, font, size: 10});
      page.drawText(String(i + 1), {x: 290, y: 25, font, size: 10});
    }
    const sourcePath = join(root, 'paper.pdf'), outputDir = join(root, 'output');
    await writeFile(sourcePath, await pdf.save());
    const parsed = await parser.parseResearchDocument({projectRoot: root, sourcePath, outputDir,
      options: {tier: 'compact', device: 'cpu', pageRange: ''}, modelFiles: null, modelManifest: ''});
    assert.equal(parsed.parserVersion, production.researchParserVersion);
    const headers = parsed.blocks.filter(b => b.reading.role === 'page_header');
    assert.equal(headers.length, 2);
    const body = parsed.blocks.filter(b => b.reading.role === 'body');
    assert.equal(body.length, 2);
    assert.equal(body[0].reading.continuesTo, body[1].id);
    assert.equal(body[1].reading.continuesFrom, body[0].id);
    const collected = await collect.collectDocumentContent(root, outputDir, parsed);
    assert.deepEqual(collected.data.content.blocks.map(({imageAssetId: _image, ...b}) => b.reading), parsed.blocks.map(b => b.reading));
    assert.equal(parsed.structure.version, 1);
    assert.deepEqual(collected.data.content.structure, parsed.structure);
    const structured = JSON.parse(await readFile(join(outputDir, parsed.artifacts.structuredContent), 'utf8'));
    assert.deepEqual(structured.blocks, parsed.blocks);
    assert.deepEqual(structured.structure, parsed.structure);
    const semanticForgery = structuredClone(parsed);
    const semantic = semanticForgery.structure.blocks.find(b => b.semantic.status === 'unknown');
    semantic.semantic = {version: 1, classifierVersion: 'forged', status: 'classified',
      roles: [{role: 'result', confidence: .9, source: 'rule', signals: []}]};
    await assert.rejects(collect.collectDocumentContent(root, outputDir, semanticForgery), /research_document_structure_artifact_mismatch/u);
    const forged = structuredClone(parsed); forged.blocks.find(b => b.reading.continuesTo).reading.continuesTo = 'missing';
    await assert.rejects(collect.collectDocumentContent(root, outputDir, forged), /research_document_reading_link_invalid/u);
  } finally {await rm(root, {recursive: true, force: true});}
});
