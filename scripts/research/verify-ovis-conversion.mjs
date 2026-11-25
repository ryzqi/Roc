/** Reconvert official weights using fresh offline packages and the production supervisor. */
import assert from 'node:assert/strict';
import {constants, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {output: {type: 'string'}, installation: {type: 'string'}}, strict: true});
if (!values.output || !values.installation) throw new Error('--output and --installation required');
const output = resolve(values.output); await mkdir(output);
const installation = await realpath(values.installation);
const {ResearchPythonRuntimeStore} = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', {platform: 'node'});
const {ovisDownloadAssets, withOvisDownloads} = await importTypeScriptModule('src/main/plugins/research/ovis-downloads.ts', {platform: 'node'});
const {installOvisPackages} = await importTypeScriptModule('src/main/plugins/research/ovis-package-installer.ts', {platform: 'node'});
const {convertOvisModel} = await importTypeScriptModule('src/main/plugins/research/ovis-conversion.ts', {platform: 'node'});
const {runResearchProcess} = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', {platform: 'node'});
const {downloadVerified, fileSha256} = await importTypeScriptModule('scripts/research/download-asset.ts', {platform: 'node'});
const {inspectOvisInstallation} = await importTypeScriptModule('src/main/plugins/research/ovis-model-store.ts', {platform: 'node'});
const {runPythonInstallerProcess} = await importTypeScriptModule('src/main/plugins/research/python-installer-process.ts', {platform: 'node'});
const root = await realpath(await mkdtemp('/private/tmp/roc-ovis-conversion-check-'));
const report = {status: 'running', checks: [], ownedDirectoriesRemoved: false,
  scope: 'Fresh managed runtime, offline wheels, isolated official-to-8bit conversion and tensor equality; no parser adoption',
  converterWrapperSha256: await fileSha256('src/main/plugins/research/ovis-conversion.ts')};
let safeToClean = true;
const signal = new AbortController().signal;
const unprovenExit = error => ['research_process_completion_failed', 'research_process_kill_failed',
  'research_process_supervision_failed'].includes(error?.code);

async function tensorInventory(path) {
  const handle = await open(path, 'r');
  let metadata, offset;
  try {
    const size = Buffer.alloc(8); await handle.read(size, 0, 8, 0);
    const length = Number(size.readBigUInt64LE()); assert.ok(length > 0 && length < 32 * 1024 ** 2);
    const bytes = Buffer.alloc(length); await handle.read(bytes, 0, length, 8);
    metadata = JSON.parse(bytes.toString('utf8')); offset = 8 + length;
  } finally {await handle.close();}
  const result = {};
  for (const name of Object.keys(metadata).sort()) {
    if (name === '__metadata__') continue;
    const value = metadata[name], [start, end] = value.data_offsets, hash = createHash('sha256');
    for await (const chunk of createReadStream(path, {start: offset + start, end: offset + end - 1})) hash.update(chunk);
    result[name] = {dtype: value.dtype, shape: value.shape, sha256: hash.digest('hex')};
  }
  return result;
}

try {
  // Bind the reference to the previously frozen inference report, not a self-declared receipt.
  const frozen = JSON.parse(await readFile('.artifacts/research-toolchain-p3/paired-347/original-bf16/report.json', 'utf8'));
  const receipt = JSON.parse(await readFile(join(installation, 'receipt.json'), 'utf8'));
  await inspectOvisInstallation({root: installation, pythonBase: receipt.python.basePrefix,
    inferenceScript: await realpath('resources/ovis-ocr/infer.py'), identity: {engine: 'ovisocr3-mlx', revision: frozen.revision,
      quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
      installationReceiptSha256: frozen.receiptSha256, inferenceSha256: frozen.evaluatorSha256, promptSha256: frozen.promptSha256}}, signal);
  report.referenceReceiptSha256 = frozen.receiptSha256;
  const runtime = await new ResearchPythonRuntimeStore(join(root, 'python-tools'), runPythonInstallerProcess,
    async (url, hash, target, options) => {
      const archive = resolve('.runtime/research-toolchain-p2-probe', url.endsWith('uv-aarch64-apple-darwin.tar.gz') ? 'uv.tar.gz' : 'python.tar.gz');
      await copyFile(archive, target, constants.COPYFILE_EXCL);
      return await downloadVerified(url, hash, target, options);
    }).prepare('3.14.10', 'ovis-conversion-check', signal);
  const source = join(root, 'source'); await mkdir(source);
  for (const asset of ovisDownloadAssets().filter(asset => asset.path.startsWith('source/'))) {
    const path = join(root, asset.path); await mkdir(dirname(path), {recursive: true});
    await copyFile(join(installation, asset.path), path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    assert.equal(await fileSha256(path), asset.sha256);
  }
  await withOvisDownloads({parent: root, assets: ovisDownloadAssets().filter(asset => asset.path.startsWith('wheels/')), signal}, async bundle => {
    const destination = join(root, 'installed'); await mkdir(destination);
    const installed = await installOvisPackages({runtime, destination, wheelhouse: join(bundle.root, 'wheels'), signal,
      requirements: await realpath('resources/ovis-ocr/requirements.lock'), projectId: 'ovis-conversion-check', onPhase: console.log});
    const conversionDestination = join(root, 'conversion'); await mkdir(conversionDestination);
    const input = {runtime, packagesRoot: installed.runtime, source, specification: await realpath('resources/ovis-ocr'),
      destination: conversionDestination, projectId: 'ovis-conversion-check', signal};
    console.log('converting');
    let request;
    const converted = await convertOvisModel(input, async value => {request = value; return await runResearchProcess(value);});
    await assert.rejects(access(request.metalCompilerCachePath), {code: 'ENOENT'});
    const expected = await tensorInventory(join(installation, 'model-8bit/model.safetensors'));
    const actual = await tensorInventory(join(converted.model, 'model.safetensors'));
    assert.deepEqual(actual, expected); assert.equal(Object.keys(actual).length, 847);
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json']) {
      assert.deepEqual(JSON.parse(await readFile(join(converted.model, name), 'utf8')),
        JSON.parse(await readFile(join(installation, 'model-8bit', name), 'utf8')));
    }
    report.checks.push({name: 'all-847-tensors-and-processor-settings-match-reference', conversion: converted.conversion, process: converted.process});
    await assert.rejects(convertOvisModel(input), /destination_not_empty/);
    report.checks.push({name: 'existing-conversion-preserved', passed: true});
    const cancelled = join(root, 'cancelled'); await mkdir(cancelled);
    const controller = new AbortController(); let cancelEvidence, cancellationError, cancelRequest;
    try {
      await convertOvisModel({...input, destination: cancelled, signal: controller.signal}, async value => {
        cancelRequest = value;
        let finished = false;
        const monitor = (async () => {
          while (!finished) {
            try {
              const names = await readdir(value.metalCompilerCachePath);
              if (names.length) {cancelEvidence = names; controller.abort(); return;}
            } catch (error) {if (error.code !== 'ENOENT') throw error;}
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        })();
        try {return await runResearchProcess(value);}
        finally {finished = true; await monitor;}
      });
    } catch (error) {if (unprovenExit(error)) throw error; cancellationError = error;}
    assert.equal(cancellationError?.code, 'research_process_cancelled'); assert.ok(cancelEvidence?.length);
    await assert.rejects(access(cancelRequest.metalCompilerCachePath), {code: 'ENOENT'});
    await rm(cancelled, {recursive: true});
    report.checks.push({name: 'running-metal-conversion-cancelled-and-cleaned', cancelEvidence});
    const corrupt = join(root, 'corrupt'); await mkdir(corrupt);
    await writeFile(join(source, 'config.json'), '{}');
    await assert.rejects(convertOvisModel({...input, destination: corrupt}, async () => assert.fail('ran corrupt source')),
      /input_changed/);
    report.checks.push({name: 'damaged-source-refused-before-execution', passed: true});
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = {message: error.message, code: error.code, cause: error.cause, stdout: error.stdout, stderr: error.stderr};
  safeToClean = !unprovenExit(error); process.exitCode = 1;
} finally {
  if (safeToClean) {await rm(root, {recursive: true}); report.ownedDirectoriesRemoved = true;} else report.retainedRoot = root;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: report.status, checks: report.checks.map(check => check.name), error: report.error}));
}
