/** Stress the application contract with saved 8-bit output. Synthetic capture envelopes are NOT new inference evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {inference: {type: 'string'}, output: {type: 'string'}, candidate: {type: 'string'}}, strict: true});
if (!values.inference || !values.output) throw new Error('--inference (completed 8bit report directory) and --output are required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inference = resolve(values.inference), output = resolve(values.output);
const bytes = await readFile(join(inference, 'report.json')), report = JSON.parse(bytes);
assert.ok(['completed', 'invalid-output'].includes(report.status)); assert.equal(report.variant, '8bit');
assert.ok(report.pages.length > 0); assert.equal(new Set(report.pages.map(page => page.id)).size, report.pages.length);
assert.equal(report.status, report.pages.every(page => page.valid === true) ? 'completed' : 'invalid-output');
const config = JSON.parse(await readFile('evaluation/ovis-evaluator/paired-inference.json'));
assert.equal(report.revision, config.modelRevision); assert.equal(report.receiptSha256, config.installationReceiptSha256);
assert.equal(report.promptSha256, config.settings.promptSha256);
let candidateSha256 = null;
if (values.candidate) {
  // Candidate decoders retain their own identity. Never relabel their output as
  // the original inference implementation to satisfy structural replay.
  const candidatePath = resolve(values.candidate);
  execFileSync('python3', ['-B', '-c', `
import hashlib,importlib.util,json,subprocess,sys
from pathlib import Path
root=Path.cwd().resolve(); path=Path(sys.argv[1]).resolve(); inference=Path(sys.argv[2]).resolve()
assert subprocess.check_output(['git','show','HEAD:'+path.relative_to(root).as_posix()])==path.read_bytes()
candidate=json.loads(path.read_text())
for item in candidate['identities'].values():
 assert hashlib.sha256((root/item['path']).read_bytes()).hexdigest()==item['sha256']
diagnostic=json.loads((inference.parent/'diagnostic.json').read_text())
report=json.loads((inference/'report.json').read_text())
spec=importlib.util.spec_from_file_location('candidate','scripts/research/score-ovis-candidate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.validate_candidate(candidate,diagnostic,report)
for path,expected in [(inference/'report.json',diagnostic['inferenceReportSha256']),
 (inference.parent/'infer-probe.py',diagnostic['probeSha256']),
 (inference.parent/'pages.json',diagnostic['pagesManifestSha256'])]:
 assert hashlib.sha256(path.read_bytes()).hexdigest()==expected
`, candidatePath, inference], {stdio: 'pipe'});
  candidateSha256 = hash(await readFile(candidatePath));
} else assert.equal(report.evaluatorSha256, config.inferenceScriptSha256);
const model = {engine: 'ovisocr3-mlx', revision: report.revision, quantization: '8bit', groupSize: 64,
  visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: report.receiptSha256,
  inferenceSha256: report.evaluatorSha256, promptSha256: report.promptSha256};
const names = ['ovis-source-artifact', 'ovis-document-adapter', 'ovis-parsed-document', 'document-files',
  'paper-ir-builder', 'paper-ir-repository', 'paper-ir-validation'];
const [capture, adapter, writer, collector, builder, repository, validator] = await Promise.all(names.map(name =>
  importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
    external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
const summary = {status: 'running', scope: 'Structural replay of saved 8-bit content through synthetic image captures, collection and Paper IR',
  sourceBindingQualification: false, qualityQualification: false, automaticAdoption: false, workerStarted: false,
  inferenceReportSha256: hash(bytes), candidateSha256, model, totalPages: report.pages.length, modules: {}, pages: []};
for (const name of [...names, 'ovis-paper-content', 'pdf-table-extractor', 'pdf-equation-extractor', 'pdf-caption-linker']) {
  summary.modules[name] = hash(await readFile(`src/main/plugins/research/${name}.ts`));
}
await mkdir(output);
const temporary = await mkdtemp(resolve('.runtime/ovis-structural-replay-'));
try {
  for (const page of report.pages) {
    controller.signal.throwIfAborted();
    const entry = {id: page.id, status: 'running', inference: {valid: page.valid,
      errors: page.errors, termination: page.termination, generationTokens: page.generationTokens}};
    summary.pages.push(entry);
    const root = await mkdtemp(join(temporary, 'page-'));
    try {
      assert.match(page.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
      const image = await readFile(page.image), raw = await readFile(join(inference, `${page.id}.raw.txt`));
      const tokens = await readFile(join(inference, `${page.id}.tokens.json`));
      assert.equal(hash(image), page.sha256); assert.equal(hash(raw), page.rawSha256);
      Object.assign(entry, {sourceSha256: page.sha256, rawSha256: page.rawSha256, tokensSha256: hash(tokens)});
      if (page.valid !== true) throw new Error('research_ovis_replay_invalid_model_output');
      assert.equal(page.termination.truncated, false);
      const generation = {finishReason: page.termination.finishReason, generationTokens: page.generationTokens,
        tokenIds: JSON.parse(tokens)};
      const frame = {kind: 'image', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: page.width, height: page.height};
      const originalBinding = {sourceHash: page.sha256, inputImageSha256: page.sha256, frame, model};
      const envelope = {protocolVersion: 1, sourceHash: page.sha256, inputImageSha256: page.sha256,
        page: 1, width: page.width, height: page.height, model, rawSha256: page.rawSha256, generation};
      const original = adapter.adaptOvisPage(raw, envelope, originalBinding);
      assert.equal(original.blocks.length, page.blockCount);
      assert.deepEqual(original.blocks.toSorted((a, b) => a.rawIndex - b.rawIndex)
        .map(block => ({category: block.category, content: block.rawContent, bbox: block.candidateRegion.normalizedBox})),
      JSON.parse(await readFile(join(inference, `${page.id}.parsed.json`))));
      const extension = extname(page.image).toLowerCase();
      assert.ok(['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(extension));
      const sourcePath = join(root, `source${extension}`), directory = join(root, 'capture');
      await copyFile(page.image, sourcePath);
      // Source raster normalization can change bytes. These newly bound envelopes
      // are fixtures for structural coverage, never actual Worker capture evidence.
      const manifest = await capture.createOvisSourceArtifact({projectRoot: root, sourcePath, outputDir: directory,
        sourceKind: 'image', pages: null, installation: {identity: model}, timeoutMs: 60000, signal: controller.signal,
        admission: {projectId: 'ovis-structural-replay', priority: 'user', resourceClass: 'parse'}}, async request => ({
        process: {syntheticStructuralReplay: true, originalInputSha256: page.sha256, inferenceReportSha256: hash(bytes)},
        pages: request.pages.map(({binding}) => {
          assert.equal(binding.sourceHash, page.sha256); assert.deepEqual(binding.frame, frame);
          return adapter.adaptOvisPage(raw, {...envelope, inputImageSha256: binding.inputImageSha256}, binding);
        })
      }));
      const manifestSha256 = hash(await readFile(join(directory, 'manifest.json')));
      const parsed = await writer.writeOvisParsedDocument({directory, manifestSha256, sourceHash: page.sha256,
        model, signal: controller.signal});
      assert.equal(parsed.blocks.length, original.blocks.length);
      for (const block of parsed.blocks) {
        const rawBlock = original.blocks.find(value => value.id === block.id); assert.ok(rawBlock);
        if (block.table) assert.equal(block.table.rawHtml, rawBlock.rawContent.trim() ? rawBlock.rawContent : null);
        else if (block.equation) assert.equal(block.equation.rawLatex, rawBlock.rawContent.trim() ? rawBlock.rawContent : null);
        else assert.equal(block.text, block.kind === 'figure' ? '' : rawBlock.rawContent);
        if (block.visual) assert.ok(block.visual.captions.every(caption => caption.status === 'candidate'));
      }
      const {data, coordinates} = await collector.collectDocumentContent(root, directory, parsed, controller.signal);
      assert.ok(coordinates); assert.deepEqual(data.content.modelIdentity, model);
      assert.equal(data.content.quality.status, 'review');
      const ir = builder.buildPaperIR({content: data.content, identity: {paperId: page.id, documentId: page.id,
        knowledgeDocumentId: page.id, parseId: page.id, sourceHash: page.sha256, parserFingerprint: data.content.parserFingerprint}});
      const objects = validator.paperIRObjects(ir);
      for (const object of objects) assert.deepEqual(object.sourceLocator.locations, [{page: 1, bbox: null, coordinateOrigin: null}]);
      const store = new repository.PaperIRRepository(root), receipt = await store.publish(ir);
      assert.deepEqual(await store.read(receipt), ir);
      assert.equal(ir.blocks.length, original.blocks.length);
      assert.equal(hash(await readFile(join(directory, 'manifest.json'))), manifestSha256);
      assert.equal(JSON.parse(await readFile(join(directory, manifest.pages[0].evidence.path))).raw, raw.toString('utf8'));
      Object.assign(entry, {status: 'passed', blocks: ir.blocks.length, equations: ir.equations.length, tables: ir.tables.length,
        cells: ir.tables.reduce((count, table) => count + table.cells.length, 0), figures: ir.figures.length,
        candidateCaptions: ir.relations.filter(relation => relation.type === 'caption_of' && relation.status === 'candidate').length,
        objects: objects.length, paperIRSha256: receipt.sha256, syntheticRasterSha256: manifest.pages[0].image.sha256});
    } catch (error) {
      Object.assign(entry, {status: 'failed', error: {message: error.message, code: error.code}});
    } finally {await rm(root, {recursive: true, force: true});}
    console.log(JSON.stringify({page: page.id, status: entry.status, completed: summary.pages.length, total: report.pages.length}));
  }
  assert.equal(hash(await readFile(join(inference, 'report.json'))), summary.inferenceReportSha256);
  summary.status = summary.pages.every(page => page.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  summary.status = 'failed'; summary.error = {message: error.message, code: error.code};
} finally {
  await rm(temporary, {recursive: true, force: true}); summary.temporaryRemoved = true;
  if (summary.status !== 'passed') process.exitCode = 1;
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: summary.status, total: summary.totalPages,
    passed: summary.pages.filter(page => page.status === 'passed').length, temporaryRemoved: true}));
}
