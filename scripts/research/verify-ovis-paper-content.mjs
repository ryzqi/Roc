/** Replay a pinned, actual Ovis PDF capture through the unregistered content assembler and durable Paper IR. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {capture: {type: 'string'}, output: {type: 'string'}}, strict: true});
if (!values.capture || !values.output) throw new Error('--capture (verified actual PDF/image capture) and --output are required');
const hash = value => createHash('sha256').update(value).digest('hex');
const capture = resolve(values.capture), output = resolve(values.output);
const reportBytes = await readFile(join(capture, 'report.json')), original = JSON.parse(reportBytes);
assert.equal(original.status, 'passed'); assert.equal(original.process.exitCode, 0);
assert.equal(hash(await readFile(join(capture, `source${extname(original.source.path).toLowerCase()}`))), original.source.sha256);
const modules = await Promise.all(['ovis-paper-content', 'paper-ir-builder', 'paper-ir-repository', 'paper-ir-validation']
  .map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'})));
const [assembler, builder, repository, validator] = modules;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
await mkdir(output);
const summary = {status: 'running', captureReportSha256: hash(reportBytes), automaticAdoption: false,
  scope: 'Replay actual source-bound 8-bit capture into Paper IR; no gold quality or production adoption claim', modules: {}};
for (const name of ['ovis-paper-content', 'ovis-document-adapter', 'paper-ir-builder', 'paper-ir-validation',
  'pdf-table-extractor', 'pdf-equation-extractor', 'pdf-caption-linker', 'pdf-quality-assessor']) {
  summary.modules[name] = hash(await readFile(`src/main/plugins/research/${name}.ts`));
}
try {
  const content = await assembler.readOvisPaperContent({directory: join(capture, 'artifact'),
    manifestSha256: original.manifestSha256, sourceHash: original.source.sha256, model: original.identity, signal: controller.signal});
  assert.equal(content.blocks.length, original.blocks); assert.equal(content.quality.status, 'review');
  assert.ok(content.quality.pages.every(page => page.status === 'review' && page.ocrCoverage === null));
  const sourceManifest = JSON.parse(await readFile(join(capture, 'artifact/manifest.json')));
  const rawByBlock = new Map();
  for (const page of sourceManifest.pages) {
    const evidence = JSON.parse(await readFile(join(capture, 'artifact', page.evidence.path)));
    JSON.parse(evidence.raw).forEach((region, index) => rawByBlock.set(`page-${page.page}-ovis-${index + 1}`, region));
  }
  for (const block of content.blocks) {
    const raw = rawByBlock.get(block.id); assert.ok(raw);
    if (block.equation) assert.equal(block.equation.rawLatex, raw.content.trim() ? raw.content : null);
    else if (block.table) assert.equal(block.table.rawHtml, raw.content.trim() ? raw.content : null);
    else if (block.kind === 'figure') assert.equal(block.text, '');
    else assert.equal(block.text, raw.content);
    if (block.visual) assert.ok(block.visual.captions.every(caption => caption.status === 'candidate'));
  }
  const identity = {paperId: 'ovis-verification-paper', documentId: 'ovis-verification-document',
    parseId: `ovis:${content.sourceManifestSha256}`, knowledgeDocumentId: 'ovis-verification-knowledge',
    sourceHash: content.sourceHash, parserFingerprint: content.parserFingerprint};
  const ir = builder.buildPaperIR({identity, content});
  for (const object of validator.paperIRObjects(ir)) {
    assert.equal(object.sourceLocator.locations.length, 1);
    assert.ok(content.selectedPages.includes(object.sourceLocator.locations[0].page));
    assert.equal(object.sourceLocator.locations[0].bbox, null);
    assert.equal(object.sourceLocator.locations[0].coordinateOrigin, null);
  }
  const receipt = await new repository.PaperIRRepository(output).publish(ir);
  assert.deepEqual(await new repository.PaperIRRepository(output).read(receipt), ir);
  assert.equal(hash(await readFile(join(capture, 'artifact/manifest.json'))), original.manifestSha256);
  await writeFile(join(output, 'content.json'), JSON.stringify(content) + '\n', {flag: 'wx'});
  Object.assign(summary, {status: 'passed', sourceHash: content.sourceHash, sourceManifestSha256: content.sourceManifestSha256,
    blocks: ir.blocks.length, equations: ir.equations.length, tables: ir.tables.length,
    cells: ir.tables.reduce((count, table) => count + table.cells.length, 0), figures: ir.figures.length,
    candidateCaptions: ir.relations.filter(relation => relation.type === 'caption_of' && relation.status === 'candidate').length,
    objects: validator.paperIRObjects(ir).length, receipt, quality: content.quality,
    sourceCaptureUnchanged: true, workerStarted: false});
} catch (error) {
  Object.assign(summary, {status: 'failed', error: {message: error.message, code: error.code}}); process.exitCode = 1;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
