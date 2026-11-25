/** Validate a complete preparation transaction and load its exact output in the worker. */
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {output: {type: 'string'}, installation: {type: 'string'},
  'reference-inference': {type: 'string'}}, strict: true});
if (!values.output || !values.installation || !values['reference-inference']) throw new Error('--output, --installation and --reference-inference required');
const output = resolve(values.output); await mkdir(output);
const referenceRoot = await realpath(values.installation), referenceInference = await realpath(values['reference-inference']);
const module = name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'});
const {ResearchPythonRuntimeStore} = await module('python-runtime-store');
const {runPythonInstallerProcess} = await module('python-installer-process');
const {prepareOvisInstallation} = await module('ovis-installation');
const {ovisDownloadAssets} = await module('ovis-downloads');
const {OvisModelStore, inspectOvisInstallation} = await module('ovis-model-store');
const {runOvisDocumentPages} = await module('ovis-worker');
const {downloadVerified, fileSha256} = await importTypeScriptModule('scripts/research/download-asset.ts', {platform: 'node'});
const root = await realpath(await mkdtemp('/private/tmp/roc-ovis-transaction-check-'));
const signal = new AbortController().signal;
const report = {status: 'running', checks: [], ownedDirectoriesRemoved: false,
  wrapperSha256: await fileSha256('src/main/plugins/research/ovis-installation.ts'),
  scope: 'Fresh preparation, verified receipt, real one-page inference, retry/cancellation and corruption cleanup; no parser adoption'};
const unprovenExit = error => ['research_process_completion_failed', 'research_process_kill_failed',
  'research_process_supervision_failed'].includes(error?.code);
let safeToClean = true;
try {
  const reference = JSON.parse(await readFile(join(referenceInference, 'report.json'), 'utf8'));
  const referenceReceipt = JSON.parse(await readFile(join(referenceRoot, 'receipt.json'), 'utf8'));
  await inspectOvisInstallation({root: referenceRoot, pythonBase: referenceReceipt.python.basePrefix,
    inferenceScript: await realpath('resources/ovis-ocr/infer.py'), identity: {engine: 'ovisocr3-mlx', revision: reference.revision,
      quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
      installationReceiptSha256: reference.receiptSha256, inferenceSha256: reference.evaluatorSha256, promptSha256: reference.promptSha256}}, signal);
  const runtime = await new ResearchPythonRuntimeStore(join(root, 'python-tools'), runPythonInstallerProcess,
    async (url, hash, target, options) => {
      await copyFile(resolve('.runtime/research-toolchain-p2-probe', url.endsWith('uv-aarch64-apple-darwin.tar.gz')
        ? 'uv.tar.gz' : 'python.tar.gz'), target, constants.COPYFILE_EXCL);
      return await downloadVerified(url, hash, target, options);
    }).prepare('3.14.10', 'ovis-transaction-check', signal);
  const parent = join(root, 'installations'), cache = join(root, 'wheels'); await mkdir(parent); await mkdir(cache);
  const assets = new Map(ovisDownloadAssets().map(asset => [asset.url, asset]));
  const download = async (url, hash, target, options) => {
    const asset = assets.get(url);
    if (asset.path.startsWith('source/')) await copyFile(join(referenceRoot, asset.path), target,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    else {
      const local = join(cache, basename(target));
      try {await copyFile(local, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);}
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await downloadVerified(url, hash, target, options);
        await copyFile(target, local, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      }
    }
    return await downloadVerified(url, hash, target, options);
  };
  let lastPhase;
  const input = {runtime, parent, specification: await realpath('resources/ovis-ocr'), signal, projectId: 'ovis-transaction-check',
    onProgress: progress => {if (progress.phase !== lastPhase) {console.log(progress.phase); lastPhase = progress.phase;}}};
  const prepared = await prepareOvisInstallation(input, download), installedRoot = prepared.installation.root;
  assert.equal(prepared.qualityQualified, false);
  assert.deepEqual(await readdir(parent), [basename(installedRoot)]);
  await assert.rejects(access(join(installedRoot, 'scratch')), {code: 'ENOENT'});
  report.checks.push({name: 'complete-generation-verified-without-temporary-downloads', entries: prepared.entries,
    bytes: prepared.bytes, identity: prepared.installation.identity});
  const store = new OvisModelStore(prepared.installation), lease = await store.acquire(signal);
  const page = reference.pages.at(-1), frame = {kind: 'image', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT',
    width: page.width, height: page.height};
  console.log('inference');
  let parsed;
  try {
    parsed = await runOvisDocumentPages({installation: lease.installation, signal, timeoutMs: 600000,
      admission: {projectId: 'ovis-transaction-check', priority: 'user', resourceClass: 'parse'},
      pages: [{imagePath: page.image, binding: {sourceHash: page.sha256, inputImageSha256: page.sha256, frame,
        model: lease.installation.identity}}]});
  } finally {lease.release();}
  assert.equal(store.busy, false);
  assert.equal(parsed.pages[0].raw, await readFile(join(referenceInference, `${page.id}.raw.txt`), 'utf8'));
  report.checks.push({name: 'fresh-installation-worker-output-matches-reference', process: parsed.process,
    rawSha256: parsed.pages[0].rawSha256});
  console.log('cancel-and-retry');
  const controller = new AbortController(); let cancellationError;
  try {
    await prepareOvisInstallation({...input, signal: controller.signal,
      onProgress: progress => {if (progress.phase === 'converting') controller.abort(new Error('cancelled-before-conversion'));}}, download);
  } catch (error) {if (unprovenExit(error)) throw error; cancellationError = error;}
  assert.equal(cancellationError?.message, 'cancelled-before-conversion');
  assert.deepEqual(await readdir(parent), [basename(installedRoot)]);
  await inspectOvisInstallation(prepared.installation, signal);
  report.checks.push({name: 'cancelled-new-attempt-cleans-only-owned-generation', passed: true});
  await assert.rejects(prepareOvisInstallation(input, async (_url, _hash, target) => writeFile(target, 'damaged')),
    /integrity_failed/);
  assert.deepEqual(await readdir(parent), [basename(installedRoot)]);
  report.checks.push({name: 'damaged-download-attempt-preserves-successful-generation', passed: true});
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = {message: error.message, code: error.code, cause: error.cause, stdout: error.stdout, stderr: error.stderr};
  safeToClean = !unprovenExit(error); process.exitCode = 1;
} finally {
  if (safeToClean) {await rm(root, {recursive: true}); report.ownedDirectoriesRemoved = true;} else report.retainedRoot = root;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: report.status, checks: report.checks.map(check => check.name), error: report.error}));
}
