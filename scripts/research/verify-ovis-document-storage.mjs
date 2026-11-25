/** Replay a pinned actual PDF/image capture through application result collection and repository publication. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from '../../tests/unit/fixtures/research-test-kit.mjs';

const {values} = parseArgs({options: {capture: {type: 'string'}, output: {type: 'string'}}, strict: true});
if (!values.capture || !values.output) throw new Error('--capture (verified actual source capture) and --output are required');
const hash = value => createHash('sha256').update(value).digest('hex');
const source = resolve(values.capture), output = resolve(values.output);
const reportBytes = await readFile(join(source, 'report.json')), original = JSON.parse(reportBytes);
assert.equal(original.status, 'passed'); assert.equal(original.process.exitCode, 0);
const sourceName = `source${extname(original.source.path).toLowerCase()}`, sourceBytes = await readFile(join(source, sourceName));
assert.equal(hash(sourceBytes), original.source.sha256);
const [writer, collector, irRepository] = await Promise.all(['ovis-parsed-document', 'document-files', 'paper-ir-repository']
  .map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'})));
await mkdir(output);
const summary = {status: 'running', captureReportSha256: hash(reportBytes), automaticAdoption: false,
  scope: 'Actual 8-bit capture through strict result contract, collection, SQLite publication and Paper IR readback', modules: {}};
let api, fixture;
try {
  for (const name of ['src/main/plugins/research/ovis-parsed-document.ts', 'src/main/plugins/research/ovis-paper-content.ts',
    'src/main/plugins/research/document-files.ts', 'src/main/plugins/research/document-repository.ts',
    'src/shared/schemas/research-production.ts', 'src/shared/schemas/research-documents.ts', 'src/shared/schemas/research-ovis.ts']) {
    summary.modules[name] = hash(await readFile(name));
  }
  await cp(join(source, 'artifact'), join(output, 'capture'), {recursive: true, errorOnExist: true, force: false});
  await writeFile(join(output, sourceName), sourceBytes, {flag: 'wx'});
  const parsed = await writer.writeOvisParsedDocument({directory: join(output, 'capture'), manifestSha256: original.manifestSha256,
    sourceHash: original.source.sha256, model: original.identity, signal: new AbortController().signal});
  const {data, coordinates} = await collector.collectDocumentContent(output, join(output, 'capture'), parsed);
  assert.equal(data.content.engine, 'ovisocr3-mlx'); assert.deepEqual(data.content.modelIdentity, original.identity);
  assert.equal(data.content.blocks.length, original.blocks); assert.equal(data.content.quality.status, 'review');
  assert.equal(data.content.sourceCapture.sha256, original.manifestSha256);
  api = await loadResearchTestApi(); fixture = createResearchFixture(api, 'reading', output);
  const {document} = fixture.repository.documents.import({id: 'ovis-storage-document', libraryItemId: null, projectId: fixture.project.id,
    filename: sourceName, mediaType: extname(sourceName) === '.pdf' ? 'application/pdf' : collector.documentMediaTypes[extname(sourceName)],
    sourcePath: sourceName, sourceHash: original.source.sha256, size: sourceBytes.length,
    entry: {metadata: {id: 'ovis-storage-literature', source: 'local', externalId: 'ovis-storage-verification', doi: null,
      title: 'Actual Ovis source capture storage verification', authors: [], abstract: null, publishedYear: null, citationCount: null,
      url: null, openAccessUrl: null, importedAt: new Date().toISOString(), updatedAt: new Date().toISOString()},
      bibliography: {citationKey: 'ovisStorageVerification', entryType: 'article', fields: {title: 'Actual Ovis source capture storage verification'},
        preambles: [], csl: null, title: 'Actual Ovis source capture storage verification', authors: [], doi: null,
        publishedYear: null, abstract: null, url: null}}
  }, false);
  const parseId = 'ovis-storage-parse', ir = fixture.repository.documents.buildPaperIR(document.id, parseId, data);
  const paperIR = await new irRepository.PaperIRRepository(output).publish(ir);
  fixture.repository.documents.begin(document.id, parseId);
  fixture.repository.documents.complete(document.id, parseId, {...data, paperIR, paperIRVersion: paperIR.version}, coordinates);
  assert.deepEqual(fixture.repository.documents.parsed(document.id, parseId).data.content, data.content);
  assert.deepEqual(fixture.repository.documents.coordinates(document.id, parseId).snapshot, coordinates);
  assert.deepEqual(await new irRepository.PaperIRRepository(output).read(paperIR), ir);
  assert.equal(hash(await readFile(join(source, 'artifact/manifest.json'))), original.manifestSha256);
  await writeFile(join(output, 'stored-content.json'), JSON.stringify(data) + '\n', {flag: 'wx'});
  await writeFile(join(output, 'coordinates.json'), JSON.stringify(coordinates) + '\n', {flag: 'wx'});
  Object.assign(summary, {status: 'passed', contractVersion: data.content.contractVersion,
    sourceHash: data.content.sourceHash, sourceCapture: data.content.sourceCapture, modelIdentity: data.content.modelIdentity,
    runtime: data.content.runtime, parserFingerprint: data.content.parserFingerprint, blocks: ir.blocks.length,
    equations: ir.equations.length, tables: ir.tables.length, cells: ir.tables.reduce((n, t) => n + t.cells.length, 0),
    figures: ir.figures.length, pages: coordinates.pages.map(page => page.page),
    sqlitePublicationAndReadback: true, paperIR, originalCaptureUnchanged: true, workerStarted: false});
} catch (error) {
  Object.assign(summary, {status: 'failed', error: {message: error.message, code: error.code}}); process.exitCode = 1;
} finally {
  if (fixture) {
    await fixture.repository.knowledgeJobs.shutdown(); await fixture.repository.paperCards.shutdown();
    await fixture.repository.wiki.shutdown(); fixture.close();
  }
  api?.dispose();
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
