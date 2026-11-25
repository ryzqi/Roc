/** Actual PDF -> private Ovis Worker -> immutable source evidence; no production parser registration. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {installation: {type: 'string'}, 'source-relative': {type: 'string'},
  output: {type: 'string'}}, strict: true});
if (!values.installation || !values['source-relative'] || !values.output) {
  throw new Error('--installation, --source-relative (frozen corpus PDF) and --output are required');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(await readFile('evaluation/corpora/ovis-ocr/sources.lock.json', 'utf8'));
const source = lock.files.find(file => file.path === values['source-relative'] && file.path.endsWith('.pdf'));
assert.ok(source, 'PDF must belong to the frozen corpus');
const config = JSON.parse(await readFile('evaluation/ovis-evaluator/paired-inference.json', 'utf8'));
const installation = await realpath(values.installation), receiptBytes = await readFile(join(installation, 'receipt.json'));
assert.equal(hash(receiptBytes), config.installationReceiptSha256);
const receipt = JSON.parse(receiptBytes), inferenceScript = resolve(config.inferenceScriptPath);
assert.equal(hash(await readFile(inferenceScript)), config.inferenceScriptSha256);
const identity = {engine: 'ovisocr3-mlx', revision: config.modelRevision, quantization: '8bit', groupSize: 64,
  visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: config.installationReceiptSha256,
  inferenceSha256: config.inferenceScriptSha256, promptSha256: config.settings.promptSha256};
const options = {platform: 'node', external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'};
const {createOvisPdfArtifact} = await importTypeScriptModule('src/main/plugins/research/ovis-pdf-artifact.ts', options);
const {OvisModelStore} = await importTypeScriptModule('src/main/plugins/research/ovis-model-store.ts', {platform: 'node'});
const {runOvisDocumentPages} = await importTypeScriptModule('src/main/plugins/research/ovis-worker.ts', {platform: 'node'});
const {runResearchProcess} = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', {platform: 'node'});
const output = resolve(values.output), controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
await mkdir(output);
const summary = {status: 'running', automaticAdoption: false, performanceQualification: false, hostLoad: 'mixed-host-load',
  scope: 'Frozen scientific PDF through unregistered source artifact path; no gold quality or application claim',
  identity, source, modules: {}};
for (const name of ['ovis-pdf-artifact', 'ovis-model-store', 'ovis-worker', 'ovis-document-adapter', 'pdf-render']) {
  summary.modules[name] = hash(await readFile(`src/main/plugins/research/${name}.ts`));
}
let lease, request;
const store = new OvisModelStore({root: installation, pythonBase: receipt.python.basePrefix, inferenceScript, identity});
try {
  const original = resolve(lock.localSourceRoot, source.path);
  assert.equal(hash(await readFile(original)), source.sha256);
  const sourcePath = join(output, 'source.pdf');
  await copyFile(original, sourcePath);
  lease = await store.acquire(controller.signal);
  const artifact = await createOvisPdfArtifact({projectRoot: output, sourcePath, outputDir: join(output, 'artifact'), pages: null,
    installation: lease.installation, admission: {projectId: 'ovis-pdf-verification', priority: 'user', resourceClass: 'parse'},
    timeoutMs: 600000, signal: controller.signal}, async input => await runOvisDocumentPages(input, async value => {
      request = value; return await runResearchProcess(value);
    }));
  assert.equal(artifact.sourceHash, source.sha256);
  let blocks = 0, crops = 0;
  for (const page of artifact.pages) {
    for (const item of [page.image, page.evidence, ...page.crops]) {
      const bytes = await readFile(join(output, 'artifact', item.path));
      assert.equal(hash(bytes), item.sha256); assert.equal(bytes.length, item.bytes);
    }
    const evidence = JSON.parse(await readFile(join(output, 'artifact', page.evidence.path), 'utf8'));
    assert.equal(evidence.frame.kind, 'pdf'); assert.equal(evidence.frame.page, page.page);
    assert.equal(evidence.rawSha256, hash(evidence.raw));
    for (const block of evidence.blocks) {
      assert.equal(block.verification, 'unverified');
      assert.deepEqual(block.citationLocations, [{page: page.page, bbox: null, coordinateOrigin: null}]);
    }
    blocks += evidence.blocks.length; crops += page.crops.length;
  }
  for (const path of request.writablePaths) await assert.rejects(access(path), error => error.code === 'ENOENT');
  Object.assign(summary, {status: 'passed', pages: artifact.pages.length, blocks, crops, process: artifact.process,
    ownedWorkerDirectoriesRemoved: true, manifestSha256: hash(await readFile(join(output, 'artifact/manifest.json')))});
} catch (error) {
  Object.assign(summary, {status: 'failed', error: {message: error.message, code: error.code,
    stdout: error.stdout, stderr: error.stderr}, ownedWorkerDirectories: request?.writablePaths ?? []});
  process.exitCode = 1;
} finally {
  lease?.release(); assert.equal(store.busy, false);
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
