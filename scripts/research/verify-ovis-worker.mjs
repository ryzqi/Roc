/** Run the unregistered Ovis Worker through the production process supervisor. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {installation: {type: 'string'}, 'reference-inference': {type: 'string'},
  output: {type: 'string'}}, strict: true});
if (!values.installation || !values['reference-inference'] || !values.output) {
  throw new Error('--installation, --reference-inference and --output are required');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const installation = await realpath(values.installation), inferenceScript = resolve('resources/ovis-ocr/infer.py');
const source = 'src/main/plugins/research/ovis-worker.ts';
const {runOvisDocumentPages} = await importTypeScriptModule(source, {platform: 'node'});
const {runResearchProcess} = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', {platform: 'node'});
const receiptBytes = await readFile(join(installation, 'receipt.json')), receipt = JSON.parse(receiptBytes);
const referenceBytes = await readFile(join(values['reference-inference'], 'report.json')), reference = JSON.parse(referenceBytes);
assert.equal(reference.status, 'completed'); assert.equal(reference.variant, '8bit');
const page = reference.pages.at(-1);
const identity = {engine: 'ovisocr3-mlx', revision: reference.revision, quantization: '8bit', groupSize: 64,
  visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: hash(receiptBytes),
  inferenceSha256: hash(await readFile(inferenceScript)), promptSha256: reference.promptSha256};
assert.equal(identity.installationReceiptSha256, reference.receiptSha256);
assert.equal(identity.inferenceSha256, reference.evaluatorSha256);
const frame = {kind: 'image', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: page.width, height: page.height};
const output = resolve(values.output);
await mkdir(output);
const summary = {status: 'running', automaticAdoption: false, performanceQualification: false, hostLoad: 'mixed-host-load',
  scope: 'One real PNG page through the unregistered production Worker wrapper; no PDF or full application claim',
  wrapperSha256: hash(await readFile(source)), referenceReportSha256: hash(referenceBytes), identity};
let request;
try {
  const result = await runOvisDocumentPages({installation: {root: installation, pythonBase: receipt.python.basePrefix,
    inferenceScript, identity}, pages: [{imagePath: page.image,
    binding: {sourceHash: page.sha256, inputImageSha256: page.sha256, frame, model: identity}}],
    admission: {projectId: 'ovis-wrapper-verification', priority: 'user', resourceClass: 'parse'},
    timeoutMs: 600000, signal: new AbortController().signal}, async value => {
    request = value;
    return await runResearchProcess(value);
  });
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].raw, await readFile(join(values['reference-inference'], `${page.id}.raw.txt`), 'utf8'));
  for (const path of request.writablePaths) await assert.rejects(access(path), error => error.code === 'ENOENT');
  await writeFile(join(output, 'adapted-page.json'), JSON.stringify(result.pages[0], null, 2) + '\n', {flag: 'wx'});
  Object.assign(summary, {status: 'passed', inputImageSha256: page.sha256, rawSha256: result.pages[0].rawSha256,
    blocks: result.pages[0].blocks.length, process: result.process, ownedDirectoriesRemoved: true});
} catch (error) {
  Object.assign(summary, {status: 'failed', error: {message: error.message, code: error.code,
    stderr: error.stderr, stdout: error.stdout}, ownedDirectories: request?.writablePaths ?? []});
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
