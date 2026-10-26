import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';

import UTIF from 'utif';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { materializeArchitectureCorpus } from '../fixtures/architecture-repair/materialize.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = join(repositoryRoot, 'tests/fixtures/architecture-repair');
const corpus = JSON.parse(await readFile(join(fixtureRoot, 'corpus.json'), 'utf8'));
const { readBibtex } = await importTypeScriptModule('src/main/plugins/research/bibliography.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { persistedTaskEventSchema } = await importTypeScriptModule('src/shared/schemas/task-event.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { extractResearchTemplate } = await importTypeScriptModule('src/main/plugins/research/template-archive.ts', {
  platform: 'node',
  external: ['yauzl'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { modelPackManifest } = await importTypeScriptModule('src/main/plugins/research/model-catalog.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { renderResearchPdfPage, withResearchPdf } = await importTypeScriptModule('src/main/plugins/research/pdf-render.ts', {
  platform: 'node',
  external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { decodeRasterDocument, parseResearchDocument } = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
  platform: 'node',
  external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
});

function vectorOnlyPdf() {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>',
    pdfStream('0 0 72 72 re f')
  ]);
}

function textOnlyPdf({ includeVector = false } = {}) {
  const words = Array.from({ length: 100 }, (_, index) => `evidence${index}`);
  const lines = Array.from({ length: 10 }, (_, index) => words.slice(index * 10, index * 10 + 10).join(' '));
  const textStream = `BT\n/F1 8 Tf\n40 760 Td\n${lines.map((line) => `(${line}) Tj\n0 -12 Td`).join('\n')}\nET`;
  const stream = includeVector ? `${textStream}\n0 0 72 72 re f` : textStream;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    pdfStream(stream),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]);
}

function rasterOnlyPdf() {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    pdfStream('q 72 0 0 72 0 0 cm /Im0 Do Q'),
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream'
  ]);
}

function pdfStream(stream) {
  return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
}

function buildPdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function zipEntries(archive) {
  const entries = [];
  let offset = archive.readUInt32LE(archive.length - 6);
  while (archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: archive.readUInt16LE(offset + 10),
      crc: archive.readUInt32LE(offset + 16),
      compressedSize: archive.readUInt32LE(offset + 20),
      uncompressedSize: archive.readUInt32LE(offset + 24),
      externalAttributes: archive.readUInt32LE(offset + 38),
      localOffset: archive.readUInt32LE(offset + 42)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipMember(archive, entry) {
  const localNameLength = archive.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = archive.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(compressed) : compressed;
}

test('architecture repair corpus stays internally consistent', async () => {
  assert.equal(corpus.version, 1);

  const bibliography = readBibtex(await readFile(join(repositoryRoot, corpus.bibliography.path), 'utf8'));
  assert.deepEqual(bibliography.map((entry) => entry.citationKey), corpus.bibliography.entries);
  assert.equal(bibliography[0].preambles[0], 'Proceedings of the Roc Data Workshop');
  assert.equal(bibliography[1].fields.crossref, 'roc-workshop-2025');
  assert.equal(bibliography[1].fields.customresearchfield, 'must survive parse and export');
  assert.equal(bibliography[2].fields.eprinttype, 'arxiv');

  const pdf = await readFile(join(repositoryRoot, corpus.documents.pdf.path));
  assert.equal(createHash('sha256').update(pdf).digest('hex'), corpus.documents.pdf.sha256);
  assert.equal(corpus.documents.tiff.find((item) => item.id === 'multipage-rgb').pages.length, 2);
  assert.equal(corpus.documents.tiff.find((item) => item.id === 'deflate-rgb-page').compression, 'deflate');

  assert.ok(corpus.archives.rejectionCases.some((item) => item.id === 'corrupt-crc'));
  assert.ok(corpus.archives.limitCases.some((item) => item.target === 'template-import' && item.entryCount === 5001));
  assert.equal(corpus.longSession.eventCount, 420);
  assert.equal(corpus.longSession.retainedWindow, 400);
  assert.deepEqual(corpus.fileTree.generatedFileCounts, [1000, 10000, 50000]);
});

test('architecture repair corpus materializes reusable ZIP, TIFF, history, and file-tree inputs', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-corpus-'));
  try {
    const materialized = await materializeArchitectureCorpus(temporaryRoot, { fileCounts: [3] });

    const validArchive = await readFile(materialized.archives['valid-members.zip']);
    const validEntries = zipEntries(validArchive);
    assert.deepEqual(validEntries.map((entry) => entry.name), corpus.archives.validMembers.map((entry) => entry.path));
    assert.deepEqual(validEntries.map((entry) => entry.method), [8, 0, 8, 8]);
    const sourceEntry = validEntries[0];
    const sourceBytes = readZipMember(validArchive, sourceEntry);
    assert.equal((crc32(sourceBytes) >>> 0), sourceEntry.crc);

    const corruptArchive = await readFile(materialized.archives['corrupt-crc.zip']);
    const corruptEntry = zipEntries(corruptArchive)[0];
    assert.notEqual((crc32(readZipMember(corruptArchive, corruptEntry)) >>> 0), corruptEntry.crc);
    const truncatedArchive = await readFile(materialized.archives['truncated-member.zip']);
    const truncatedEntry = zipEntries(truncatedArchive)[0];
    assert.throws(() => readZipMember(truncatedArchive, truncatedEntry));
    const collisionArchive = await readFile(materialized.archives['case-collision.zip']);
    assert.deepEqual(zipEntries(collisionArchive).map((entry) => entry.name), ['Figures/Plot.svg', 'figures/plot.svg']);
    const symlinkArchive = await readFile(materialized.archives['symlink-member.zip']);
    assert.equal(zipEntries(symlinkArchive)[0].externalAttributes >>> 16, 0o120777);

    const memberLimitArchive = await readFile(materialized.archives['template-import-too-many-members.zip']);
    assert.equal(memberLimitArchive.readUInt16LE(memberLimitArchive.length - 12), 5001);
    const exportLimitArchive = await readFile(materialized.archives['export-writer-too-many-files.zip']);
    assert.equal(exportLimitArchive.readUInt16LE(exportLimitArchive.length - 12), 10001);
    const compressionBomb = await readFile(materialized.archives['template-import-compression-bomb-over-file-limit.zip']);
    const compressionBombEntry = zipEntries(compressionBomb)[0];
    assert.equal(compressionBombEntry.uncompressedSize, 67_108_865);
    assert.ok(compressionBombEntry.compressedSize < 100_000);

    const multipageBytes = await readFile(materialized.documents.tiff['multipage-rgb']);
    const pages = UTIF.decode(multipageBytes);
    assert.equal(pages.length, 2);
    for (const page of pages) UTIF.decodeImage(multipageBytes, page);
    assert.deepEqual(Array.from(UTIF.toRGBA8(pages[0])), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(UTIF.toRGBA8(pages[1])), [255, 255, 255, 255]);
    const oversizedIfd = await readFile(materialized.documents.tiff['oversized-ifd']);
    const [oversizedPage] = UTIF.decode(oversizedIfd);
    assert.equal(oversizedPage.t256[0], 5001);
    assert.equal(oversizedPage.t257[0], 5000);
    const malformedIfd = await readFile(materialized.documents.tiff['malformed-ifd']);
    const [malformedPage] = UTIF.decode(malformedIfd);
    assert.deepEqual(malformedPage.t256, []);
    assert.throws(() => UTIF.decodeImage(malformedIfd, malformedPage));

    const history = (await readFile(materialized.history, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(history.length, corpus.longSession.eventCount);
    assert.ok(history.every((event) => persistedTaskEventSchema.safeParse(event).success));
    assert.deepEqual(history.filter((event) => event.type === 'tool_call').map((event) => event.sequence), Array.from({ length: 42 }, (_, index) => (index + 1) * 10));
    assert.equal((await readdir(materialized.fileTree[0])).length, 3);
    assert.equal(await readFile(join(materialized.fileTree[0], 'file-000002.txt'), 'utf8'), 'corpus:2\n');

    const cliOutputRoot = join(temporaryRoot, 'cli-output');
    await mkdir(cliOutputRoot);
    const cliResult = spawnSync(process.execPath, [join(fixtureRoot, 'materialize.mjs'), cliOutputRoot, '--file-counts=0'], { encoding: 'utf8' });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(cliResult.stdout), { output: await realpath(cliOutputRoot), archiveCount: 15, fileCounts: [0] });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('native-text PDF stages preserve page evidence without allocating an OCR raster', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-pdf-stages-'));
  try {
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);
    const sourcePath = join(projectRoot, 'native-text.pdf');
    const outputDir = join(projectRoot, 'parsed');
    await writeFile(sourcePath, await readFile(join(repositoryRoot, corpus.documents.pdf.path)));
    const stages = [];

    const parsed = await parseResearchDocument({
      projectRoot,
      sourcePath,
      outputDir,
      options: { tier: 'compact', device: 'cpu', pageRange: '1' },
      modelFiles: null,
      modelManifest: modelPackManifest('compact'),
      onStage: (event) => stages.push(event)
    });

    assert.equal(parsed.parseMode, 'native-text');
    assert.ok(parsed.content.length > 0);
    assert.deepEqual(parsed.assets.map((asset) => ({ kind: asset.kind, page: asset.page })), [{ kind: 'page', page: 1 }]);
    const pagePng = await readFile(join(outputDir, parsed.assets[0].path));
    assert.deepEqual(pagePng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(pagePng.byteLength > 0);
    const middle = JSON.parse(await readFile(join(outputDir, parsed.artifacts.middleJson), 'utf8'));
    assert.equal(middle.content, parsed.content);
    assert.equal(middle.pages[0].page, 1);
    assert.ok(parsed.blocks.every((block) => block.locations.every((location) => location.page === 1)));
    assert.ok(stages.some((event) => event.stage === 'native-text'));
    assert.ok(stages.some((event) => event.stage === 'page-render'));
    assert.ok(stages.some((event) => event.stage === 'page-png-encode'));
    assert.ok(stages.some((event) => event.stage === 'page-write'));
    assert.equal(stages.some((event) => event.stage === 'ocr-raster'), false);
    assert.equal(stages.some((event) => event.stage === 'ocr-inference'), false);
    assert.ok(stages.findIndex((event) => event.stage === 'native-text') < stages.findIndex((event) => event.stage === 'page-render'));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('OCR raster bytes match the rendered page after its PNG evidence is written', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-pdf-raster-'));
  try {
    const outputDir = join(temporaryRoot, 'pages');
    const stages = [];
    const rendered = await withResearchPdf(rasterOnlyPdf(), async (pdf) => {
      const page = await pdf.getPage(1);
      try {
        return await renderResearchPdfPage(page, 1, pdf.numPages, outputDir, 1.5, true, 1024 * 1024, {
          includeRgbaImage: true,
          onStage: (event) => stages.push(event)
        });
      } finally {
        page.cleanup();
      }
    });

    assert.ok(rendered.image);
    assert.equal(rendered.image.width, rendered.width);
    assert.equal(rendered.image.height, rendered.height);
    assert.equal(rendered.image.data.byteLength, rendered.width * rendered.height * 4);
    assert.ok(rendered.image.data.some((value) => value !== 0));
    const pagePng = await readFile(rendered.path);
    assert.deepEqual(pagePng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(pagePng.byteLength > 0);
    assert.ok(stages.findIndex((event) => event.stage === 'page-write') < stages.findIndex((event) => event.stage === 'ocr-raster'));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('visual-only PDF retains OCR raster routing and removes output when its model pack is unavailable', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-pdf-ocr-route-'));
  try {
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);
    const sourcePath = join(projectRoot, 'vector-only.pdf');
    const outputDir = join(projectRoot, 'parsed');
    await writeFile(sourcePath, vectorOnlyPdf());
    const stages = [];

    await assert.rejects(parseResearchDocument({
      projectRoot,
      sourcePath,
      outputDir,
      options: { tier: 'compact', device: 'cpu', pageRange: '1' },
      modelFiles: null,
      modelManifest: modelPackManifest('compact'),
      onStage: (event) => stages.push(event)
    }), (error) => error.code === 'research_model_pack_required');

    assert.ok(stages.some((event) => event.stage === 'ocr-raster'));
    assert.equal(stages.some((event) => event.stage === 'ocr-inference'), false);
    await assert.rejects(access(outputDir), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('text-only, scanned and mixed PDF pages retain their existing OCR routing decisions', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-pdf-routing-'));
  try {
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);
    const modelFiles = {
      detection: join(projectRoot, 'missing', 'detection.onnx'),
      recognition: join(projectRoot, 'missing', 'recognition.onnx'),
      dictionary: join(projectRoot, 'missing', 'dictionary.txt'),
      layout: join(projectRoot, 'missing', 'layout.onnx'),
      table: join(projectRoot, 'missing', 'table.onnx')
    };
    const parse = (sourcePath, outputDir, onStage) => parseResearchDocument({
      projectRoot,
      sourcePath,
      outputDir,
      options: { tier: 'compact', device: 'cpu', pageRange: '1' },
      modelFiles,
      modelManifest: modelPackManifest('compact'),
      onStage
    });

    const textPath = join(projectRoot, 'text-only.pdf');
    const textOutput = join(projectRoot, 'text-output');
    await writeFile(textPath, textOnlyPdf());
    const textStages = [];
    const textResult = await parse(textPath, textOutput, (event) => textStages.push(event));
    assert.equal(textResult.parseMode, 'native-text');
    assert.ok(textResult.content.length >= 600);
    assert.equal(textResult.blocks[0].locations[0].page, 1);
    const textMiddle = JSON.parse(await readFile(join(textOutput, textResult.artifacts.middleJson), 'utf8'));
    assert.equal(textMiddle.pages[0].page, 1);
    assert.equal(textMiddle.pages[0].text, textResult.content);
    assert.ok(textStages.some((event) => event.stage === 'visual-inspection'));
    assert.equal(textStages.some((event) => event.stage === 'ocr-raster'), false);
    assert.equal(textStages.some((event) => event.stage === 'ocr-inference'), false);
    assert.equal(textStages.some((event) => event.stage === 'model-validation'), false);
    assert.equal(textStages.some((event) => event.stage === 'model-initialization'), false);

    for (const [fixture, bytes] of [['scanned', rasterOnlyPdf()], ['mixed', textOnlyPdf({ includeVector: true })]]) {
      const sourcePath = join(projectRoot, `${fixture}.pdf`);
      const outputDir = join(projectRoot, `${fixture}-output`);
      const stages = [];
      await writeFile(sourcePath, bytes);
      await assert.rejects(parse(sourcePath, outputDir, (event) => stages.push(event)), (error) => error.code === 'ENOENT');
      assert.ok(stages.some((event) => event.stage === 'ocr-raster'), fixture);
      assert.ok(stages.some((event) => event.stage === 'model-validation'), fixture);
      assert.equal(stages.some((event) => event.stage === 'model-initialization'), false, fixture);
      assert.equal(stages.some((event) => event.stage === 'ocr-inference'), false, fixture);
      if (fixture === 'mixed') assert.ok(stages.some((event) => event.stage === 'visual-inspection'));
      await assert.rejects(access(outputDir), { code: 'ENOENT' });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template import verifies CRC and normalizes truncated archive failures with output cleanup', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-template-archive-'));
  try {
    const corpusRoot = join(temporaryRoot, 'corpus');
    await mkdir(corpusRoot);
    const materialized = await materializeArchitectureCorpus(corpusRoot, { fileCounts: [] });
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);

    const validSource = join(projectRoot, 'valid-members.zip');
    await writeFile(validSource, await readFile(materialized.archives['valid-members.zip']));
    const validOutput = join(projectRoot, 'valid-output');
    const validResult = await extractResearchTemplate({ projectRoot, sourcePath: validSource, outputDir: validOutput });
    assert.equal(validResult.fileCount, 4);
    assert.equal(await readFile(join(validOutput, 'main.tex'), 'utf8'), corpus.archives.validMembers[0].content);
    assert.equal(await readFile(join(validOutput, 'empty.txt'), 'utf8'), '');

    const corruptSource = join(projectRoot, 'corrupt-crc.zip');
    await writeFile(corruptSource, await readFile(materialized.archives['corrupt-crc.zip']));
    const corruptOutput = join(projectRoot, 'corrupt-output');
    await assert.rejects(
      extractResearchTemplate({ projectRoot, sourcePath: corruptSource, outputDir: corruptOutput }),
      (error) => error.code === 'research_template_archive_crc_mismatch'
    );
    await assert.rejects(access(corruptOutput), { code: 'ENOENT' });

    const truncatedSource = join(projectRoot, 'truncated-member.zip');
    await writeFile(truncatedSource, await readFile(materialized.archives['truncated-member.zip']));
    const truncatedOutput = join(projectRoot, 'truncated-output');
    await assert.rejects(
      extractResearchTemplate({ projectRoot, sourcePath: truncatedSource, outputDir: truncatedOutput }),
      (error) => error.code === 'research_template_archive_entry_invalid'
    );
    await assert.rejects(access(truncatedOutput), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('research TIFF parser rejects invalid dimensions before pixel decode and cleans output', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-tiff-preflight-'));
  try {
    const corpusRoot = join(temporaryRoot, 'corpus');
    await mkdir(corpusRoot);
    const materialized = await materializeArchitectureCorpus(corpusRoot, { fileCounts: [] });
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);
    const modelFiles = {
      detection: '/unused/detection.onnx',
      recognition: '/unused/recognition.onnx',
      dictionary: '/unused/dictionary.txt',
      layout: '/unused/layout.onnx',
      table: '/unused/table.onnx'
    };
    const parse = (sourcePath, outputDir) => parseResearchDocument({
      projectRoot,
      sourcePath,
      outputDir,
      options: { tier: 'compact', device: 'cpu', pageRange: '1' },
      modelFiles,
      modelManifest: modelPackManifest('compact')
    });

    for (const fixture of ['oversized-ifd', 'malformed-ifd']) {
      const sourcePath = join(projectRoot, `${fixture}.tif`);
      const outputDir = join(projectRoot, `${fixture}-output`);
      await writeFile(sourcePath, await readFile(materialized.documents.tiff[fixture]));
      await assert.rejects(parse(sourcePath, outputDir), (error) => error.code === 'research_image_too_large');
      await assert.rejects(access(outputDir), { code: 'ENOENT' });
    }

    const multipagePath = join(projectRoot, 'multipage-rgb.tif');
    await writeFile(multipagePath, await readFile(materialized.documents.tiff['multipage-rgb']));
    const multipage = await decodeRasterDocument(multipagePath);
    assert.equal(multipage.pageCount, 2);
    assert.deepEqual(Array.from((await multipage.page(1)).data), [0, 0, 0, 255]);
    assert.deepEqual(Array.from((await multipage.page(2)).data), [255, 255, 255, 255]);

    const compressedPath = join(projectRoot, 'deflate-rgb-page.tif');
    await writeFile(compressedPath, await readFile(materialized.documents.tiff['deflate-rgb-page']));
    assert.equal(UTIF.decode(await readFile(compressedPath))[0].t259[0], 8);
    const compressed = await decodeRasterDocument(compressedPath);
    assert.deepEqual(Array.from((await compressed.page(1)).data), [10, 20, 30, 255, 40, 50, 60, 255]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('architecture repair corpus refuses repository aliases and unbounded file-tree counts', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-corpus-'));
  try {
    const repositoryAlias = join(temporaryRoot, 'repository-alias');
    await symlink(repositoryRoot, repositoryAlias, 'dir');
    const unsafeOutput = join(repositoryAlias, `.architecture-corpus-${process.pid}`);
    await assert.rejects(materializeArchitectureCorpus(repositoryAlias, { fileCounts: [] }), /corpus_output_must_be_outside_repository/);
    await assert.rejects(materializeArchitectureCorpus(unsafeOutput, { fileCounts: [] }), { code: 'ENOENT' });
    await assert.rejects(access(unsafeOutput), { code: 'ENOENT' });

    const oversizedOutput = join(temporaryRoot, 'oversized-count');
    await assert.rejects(materializeArchitectureCorpus(oversizedOutput, { fileCounts: [50_001] }), /invalid_file_tree_count/);
    await assert.rejects(access(oversizedOutput), { code: 'ENOENT' });

    const occupiedOutput = join(temporaryRoot, 'occupied-output');
    await mkdir(occupiedOutput);
    const sentinelPath = join(occupiedOutput, 'preserve.txt');
    await writeFile(sentinelPath, 'keep existing contents');
    await assert.rejects(materializeArchitectureCorpus(occupiedOutput, { fileCounts: [] }), /corpus_output_must_be_empty/);
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep existing contents');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
