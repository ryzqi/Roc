import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, writeFile, access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let capture, adapter, writer, collector, repository, schema, storage, api;
before(async () => {
  [capture, adapter, writer, collector, repository, schema, storage] = await Promise.all([
    ...['ovis-source-artifact', 'ovis-document-adapter', 'ovis-parsed-document', 'document-files', 'paper-ir-repository']
      .map(name => `src/main/plugins/research/${name}.ts`),
    'src/shared/schemas/research-production.ts', 'src/shared/schemas/research-documents.ts'
  ].map(path => importTypeScriptModule(path, {platform: 'node',
    external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
  api = await loadResearchTestApi();
});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const model = {engine: 'ovisocr3-mlx', revision: '702a71f233a208be050b12779ee29fdd1eb2dab3', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
const raw = JSON.stringify([
  {category: 'text', content: 'Measured content, Eq. (1).', bbox: [50, 50, 900, 200]},
  {category: 'display_formula', content: '$$x = 1 \\tag{1}$$', bbox: [50, 210, 900, 300]},
  {category: 'table', content: '<table><tr><td>Cell evidence</td></tr></table>', bbox: [50, 310, 900, 600]},
  {category: 'image', content: '<img src="invented.png">', bbox: [50, 610, 900, 900]}
]);
async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-ovis-result-test-');
  try {
    const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage([200, 300]);
    const bytes = await pdf.save(), sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, bytes);
    const directory = join(root, 'capture'), signal = new AbortController().signal;
    await capture.createOvisSourceArtifact({projectRoot: root, sourcePath, outputDir: directory, pages: [1, 3], sourceKind: 'pdf',
      installation: {identity: model}, signal, timeoutMs: 60000,
      admission: {projectId: 'ovis-result-test', priority: 'user', resourceClass: 'parse'}}, async request => ({
      process: {exitCode: 0, stdout: '', stderr: ''}, pages: request.pages.map(({binding}) =>
        adapter.adaptOvisPage(Buffer.from(raw), {protocolVersion: 1, sourceHash: binding.sourceHash,
          inputImageSha256: binding.inputImageSha256, page: binding.frame.page, width: binding.frame.width,
          height: binding.frame.height, model, rawSha256: hash(raw),
          generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding))}));
    const manifestBytes = await readFile(join(directory, 'manifest.json'));
    const request = {directory, sourceHash: hash(bytes), model, signal, manifestSha256: hash(manifestBytes)};
    await operation({root, directory, request, bytes});
    assert.equal(hash(await readFile(join(directory, 'manifest.json'))), request.manifestSha256);
  } finally {await rm(root, {recursive: true, force: true});}
}

test('Ovis result preserves model and capture identity through collection, SQLite and Paper IR publication', async () => {
  await fixture(async ({root, directory, request, bytes}) => {
    const parsed = await writer.writeOvisParsedDocument(request);
    const {data, coordinates} = await collector.collectDocumentContent(root, directory, parsed);
    assert.equal(data.content.engine, 'ovisocr3-mlx'); assert.equal(data.content.device, 'metal');
    assert.deepEqual(data.content.modelIdentity, model); assert.deepEqual(data.content.sourceCapture, parsed.sourceCapture);
    assert.deepEqual(data.content.runtime, {python: '3.14.10', mlx: '0.32.5', 'mlx-vlm': '0.8.1'});
    assert.equal(data.content.modelManifest, model.installationReceiptSha256);
    assert.deepEqual(coordinates.pages.map(page => page.page), [1, 3]);
    assert.equal(coordinates.parseHash, hash(JSON.stringify(data.content)));
    assert.equal(coordinates.artifact.sha256, hash(await readFile(join(directory, parsed.artifacts.structuredContent))));
    assert.ok(data.content.blocks.every(block => block.locations.every(location => location.bbox === null)));
    for (const block of data.content.blocks.filter(block => block.table || block.visual)) {
      assert.ok(data.content.assets.some(asset => asset.id === block.imageAssetId));
      assert.equal((block.table ?? block.visual).assetId, block.imageAssetId);
    }
    const f = createResearchFixture(api, 'reading', root);
    try {
      const {document} = f.repository.documents.import({id: 'ovis-document', libraryItemId: null, projectId: f.project.id,
        filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: request.sourceHash, size: bytes.length,
        entry: {metadata: {id: 'ovis-literature', source: 'local', externalId: 'ovis-fixture', doi: null,
          title: 'Ovis contract fixture', authors: ['Fixture'], abstract: null, publishedYear: 2026, citationCount: null,
          url: null, openAccessUrl: null, importedAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z'},
          bibliography: {citationKey: 'ovis2026', entryType: 'article', fields: {title: 'Ovis contract fixture'}, preambles: [],
            csl: null, title: 'Ovis contract fixture', authors: ['Fixture'], doi: null, publishedYear: 2026, abstract: null, url: null}}
      }, false);
      const ir = f.repository.documents.buildPaperIR(document.id, 'parse-1', data);
      const paperIR = await new repository.PaperIRRepository(root).publish(ir);
      f.repository.documents.begin(document.id, 'parse-1');
      f.repository.documents.complete(document.id, 'parse-1', {...data, paperIR, paperIRVersion: paperIR.version}, coordinates);
      assert.deepEqual(f.repository.documents.parsed(document.id, 'parse-1').data.content, data.content);
      assert.deepEqual(f.repository.documents.coordinates(document.id, 'parse-1').snapshot, coordinates);
      assert.deepEqual(await new repository.PaperIRRepository(root).read(paperIR), ir);
      assert.equal(ir.equations.length, 2); assert.equal(ir.tables.length, 2); assert.equal(ir.figures.length, 2);
      f.repository.documents.begin(document.id, 'parse-2');
      const nextDirectory = join(root, 'next-capture');
      await cp(directory, nextDirectory, {recursive: true, errorOnExist: true, force: false});
      await writeFile(join(nextDirectory, 'evidence/page-1.json'), '{}');
      await assert.rejects(collector.collectDocumentContent(root, nextDirectory, parsed), /research_ovis_artifact_changed/);
      f.repository.documents.fail(document.id, 'parse-2', 'research_ovis_artifact_changed', false);
      assert.equal(f.repository.documents.get(document.id).currentParseId, 'parse-1');
      assert.equal(f.repository.documents.runs(document.id)[0].status, 'failed');
      assert.equal(f.repository.documents.runs(document.id)[0].error, 'research_ovis_artifact_changed');
      assert.deepEqual(f.repository.documents.parsed(document.id, 'parse-1').data.content, data.content);
      assert.deepEqual((await collector.collectDocumentContent(root, directory, parsed)).data.content, data.content);
    } finally {
      await f.repository.knowledgeJobs.shutdown(); await f.repository.paperCards.shutdown(); await f.repository.wiki.shutdown(); f.close();
    }
  });
});

test('new parse and storage contracts reject incomplete, mixed, downgraded or contradictory identities', async () => {
  await fixture(async ({root, directory, request}) => {
    const parsed = await writer.writeOvisParsedDocument(request);
    const {data} = await collector.collectDocumentContent(root, directory, parsed);
    for (const patch of [{contractVersion: 5}, {engine: 'paddleocr.js'}, {device: 'cpu'}, {tier: 'compact'},
      {parseMode: 'native-text'}, {modelIdentity: undefined}, {sourceCapture: undefined}, {quality: undefined},
      {modelManifest: 'f'.repeat(64)}, {modelIdentity: {...model, quantization: '4bit'}},
      {sourceCapture: {path: '../manifest.json', sha256: request.manifestSha256}},
      {runtime: {...parsed.runtime, mlx: 'wrong'}}, {parserVersion: 'roc-ovis-parser/0'}]) {
      assert.equal(schema.researchParsedDocumentSchema.safeParse({...parsed, ...patch}).success, false, JSON.stringify(patch));
      assert.equal(storage.researchDocumentContentSchema.safeParse({...data.content, ...patch}).success, false, JSON.stringify(patch));
    }
  });
});

test('consistent tampering of result and all derived files cannot replace original OCR content or frames', async () => {
  await fixture(async ({root, directory, request}) => {
    const parsed = await writer.writeOvisParsedDocument(request), forged = structuredClone(parsed);
    forged.blocks[0].text = 'Forged content'; forged.content = forged.blocks.filter(block => block.text.trim()).map(block => block.text).join('\n\n');
    const value = JSON.parse(await readFile(join(directory, parsed.artifacts.structuredContent)));
    const altered = JSON.stringify({...value, ...forged}) + '\n';
    await writeFile(join(directory, parsed.artifacts.middleJson), altered);
    await writeFile(join(directory, parsed.artifacts.structuredContent), altered);
    await writeFile(join(directory, parsed.artifacts.markdown), forged.content);
    await assert.rejects(collector.collectDocumentContent(root, directory, forged), /research_ovis_result_capture_mismatch/);
  });
});

test('middle, markdown and structured files are each verified, including captured page transforms', async () => {
  await fixture(async ({root, directory, request}) => {
    const parsed = await writer.writeOvisParsedDocument(request);
    for (const path of Object.values(parsed.artifacts)) {
      const original = await readFile(join(directory, path));
      await writeFile(join(directory, path), Buffer.concat([original, Buffer.from(' ')]));
      await assert.rejects(collector.collectDocumentContent(root, directory, parsed), /research_ovis_result_artifact_mismatch/);
      await writeFile(join(directory, path), original);
    }
    const path = join(directory, parsed.artifacts.structuredContent), value = JSON.parse(await readFile(path));
    value.pages[0].frame.viewport.transform[4] += 1;
    await writeFile(path, JSON.stringify(value) + '\n');
    await assert.rejects(collector.collectDocumentContent(root, directory, parsed), /research_ovis_result_artifact_mismatch/);
  });
});

test('cancelled writes and existing outputs preserve the raw capture and completed artifacts', async () => {
  await fixture(async ({directory, request}) => {
    await assert.rejects(writer.writeOvisParsedDocument({...request, signal: AbortSignal.abort()}));
    await assert.rejects(access(join(directory, 'artifacts')), {code: 'ENOENT'});
    const parsed = await writer.writeOvisParsedDocument(request);
    const before = await readFile(join(directory, parsed.artifacts.structuredContent));
    await assert.rejects(writer.writeOvisParsedDocument(request), {code: 'EEXIST'});
    assert.deepEqual(await readFile(join(directory, parsed.artifacts.structuredContent)), before);
  });
});

test('cancellation after the first derived write removes the owned directory and allows a clean retry', async () => {
  await fixture(async ({directory, request}) => {
    const controller = new AbortController(), signal = controller.signal;
    let observedWrite = false;
    signal.throwIfAborted = () => {
      if (existsSync(join(directory, 'artifacts/middle.json'))) {observedWrite = true; controller.abort();}
      AbortSignal.prototype.throwIfAborted.call(signal);
    };
    await assert.rejects(writer.writeOvisParsedDocument({...request, signal}), {name: 'AbortError'});
    assert.equal(observedWrite, true);
    await assert.rejects(access(join(directory, 'artifacts')), {code: 'ENOENT'});
    await access(join(directory, 'manifest.json'));
    const parsed = await writer.writeOvisParsedDocument(request);
    assert.equal(parsed.sourceCapture.sha256, request.manifestSha256);
  });
});
