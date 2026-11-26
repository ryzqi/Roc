import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/ovis-worker.ts', {platform: 'node'});});
const hash = value => createHash('sha256').update(value).digest('hex');
const missing = path => assert.rejects(access(path), error => error.code === 'ENOENT');
async function fixture() {
  const root = await mkdtemp('/private/tmp/roc-ovis-worker-test-');
  const script = join(root, 'infer.py'), receipt = Buffer.from('{}'), code = Buffer.from('# fixture\n');
  await writeFile(script, code); await writeFile(join(root, 'receipt.json'), receipt);
  const identity = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c',
    quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
    installationReceiptSha256: hash(receipt), inferenceSha256: hash(code),
    promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
  const pages = [];
  for (const page of [3, 7]) {
    const imagePath = join(root, `input-${page}.png`), bytes = Buffer.from(`fake-image-${page}`);
    await writeFile(imagePath, bytes);
    pages.push({imagePath, binding: {sourceHash: 'c'.repeat(64), inputImageSha256: hash(bytes), model: identity,
      frame: {kind: 'image', page, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: 1000, height: 1500}}});
  }
  const controller = new AbortController();
  return {root, controller, input: {installation: {root, pythonBase: root, inferenceScript: script, identity}, pages,
    admission: {projectId: 'ovis-worker-test', priority: 'user', resourceClass: 'parse'}, timeoutMs: 60000, signal: controller.signal}};
}
async function respond(request) {
  const wire = JSON.parse(request.input), manifestBytes = await readFile(wire.pages), manifest = JSON.parse(manifestBytes);
  await mkdir(wire.output);
  const pages = [];
  for (const page of manifest.pages) {
    const raw = Buffer.from(JSON.stringify([{category: 'text', content: page.id, bbox: [10, 20, 100, 200]}]));
    await writeFile(join(wire.output, `${page.id}.raw.txt`), raw);
    await writeFile(join(wire.output, `${page.id}.tokens.json`), '[100,248046]');
    pages.push({id: page.id, sha256: page.sha256, width: 1000, height: 1500, rawSha256: hash(raw),
      valid: true, errors: [], generationTokens: 2,
      termination: {finishReason: 'stop', eosObserved: true, truncated: false, errors: []}});
  }
  const report = {settings: {temperature: 0, maxTokens: 16384, enableThinking: false, minPixels: 200704,
    maxPixels: 8294400, seed: 0, repetitionPenalty: 1.03, repetitionContextSize: 20}, schemaVersion: 1, status: 'completed', variant: '8bit',
    revision: '5b252386ba615bd464a5a26597560eaba87dae5c', receiptSha256: wire.receiptSha256,
    evaluatorSha256: wire.inferenceSha256, promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1',
    network: 'denied-by-seatbelt', pagesManifestSha256: hash(manifestBytes), pages};
  await writeFile(join(wire.output, 'report.json'), JSON.stringify(report));
  return {report, wire, result: {exitCode: 0, stdout: '', stderr: '',
    resourceUsage: {mode: 'monitored', sampleIntervalMs: 100, samples: 1, observedCpuTimeMs: 1, peakResidentBytes: 1},
    admission: {waitMs: 0, holdMs: 1}}};
}

test('one supervised request binds multiple pages and cleans only its own job/Metal cache', async () => {
  const f = await fixture(); let request, calls = 0;
  try {
    const result = await api.runOvisDocumentPages(f.input, async value => {
      request = value; calls++;
      assert.equal(value.networkAccess, 'none'); assert.equal(value.allowGpuAcceleration, true);
      assert.equal(value.metalCompilerCachePath, value.writablePaths[1]);
      assert.deepEqual(value.args.slice(0, 5), ['-I', '-S', '-B', '-X', 'utf8']);
      assert.ok(!value.args.at(-1).includes(f.root));
      assert.ok(value.args.at(-1).indexOf('verify_installation') < value.args.at(-1).indexOf('import mlx.core'));
      assert.equal(value.resourceLimits.maxResidentBytes, 6 * 1024 ** 3);
      assert.deepEqual(value.admission, f.input.admission);
      return (await respond(value)).result;
    });
    assert.equal(calls, 1); assert.deepEqual(result.pages.map(p => p.frame.page), [3, 7]);
    assert.deepEqual(result.pages.map(p => p.blocks[0].rawContent), ['page-1', 'page-2']);
    for (const path of request.writablePaths) await missing(path);
    await access(f.root); for (const page of f.input.pages) await access(page.imagePath);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('wrong or partial page results never return a successful document', async () => {
  for (const mode of ['decoder', 'missing-page', 'reordered', 'manifest', 'model', 'raw', 'source', 'symlink', 'exit']) {
    const f = await fixture(); let request;
    try {
      await assert.rejects(api.runOvisDocumentPages(f.input, async value => {
        request = value;
        const {report, wire, result} = await respond(value);
        if (mode === 'decoder') report.settings.repetitionPenalty = 1.05;
        if (mode === 'missing-page') report.pages.pop();
        if (mode === 'reordered') report.pages.reverse();
        if (mode === 'manifest') report.pagesManifestSha256 = 'e'.repeat(64);
        if (mode === 'model') report.evaluatorSha256 = 'e'.repeat(64);
        if (mode === 'raw') await writeFile(join(wire.output, 'page-2.raw.txt'), '[]');
        if (mode === 'source') await writeFile(f.input.pages[1].imagePath, 'changed');
        if (mode === 'symlink') {
          await rm(join(wire.output, 'page-2.tokens.json'));
          await symlink(join(wire.output, 'page-1.tokens.json'), join(wire.output, 'page-2.tokens.json'));
        }
        if (mode === 'exit') result.exitCode = 2;
        await writeFile(join(wire.output, 'report.json'), JSON.stringify(report));
        return result;
      }), undefined, mode);
      for (const path of request.writablePaths) await missing(path);
    } finally {await rm(f.root, {recursive: true, force: true});}
  }
});

test('preflight rejects changed runtime identities, images and duplicate pages before launching', async () => {
  for (const mode of ['script', 'receipt', 'image', 'duplicate', 'mixed-source', 'cancelled']) {
    const f = await fixture(); let calls = 0;
    try {
      if (mode === 'script') await writeFile(f.input.installation.inferenceScript, '# changed');
      if (mode === 'receipt') await writeFile(join(f.root, 'receipt.json'), '{"changed":true}');
      if (mode === 'image') await writeFile(f.input.pages[0].imagePath, 'changed');
      if (mode === 'duplicate') f.input.pages[1].binding.frame.page = 3;
      if (mode === 'mixed-source') f.input.pages[1].binding.sourceHash = 'd'.repeat(64);
      if (mode === 'cancelled') f.controller.abort();
      await assert.rejects(api.runOvisDocumentPages(f.input, async () => {calls++; throw new Error('unexpected');}));
      assert.equal(calls, 0);
    } finally {await rm(f.root, {recursive: true, force: true});}
  }
});

test('proven cancellation cleans jobs; unproven process cleanup retains directories for recovery', async () => {
  for (const code of ['research_process_cancelled', 'research_process_kill_failed',
    'research_process_supervision_failed', 'research_process_completion_failed']) {
    const f = await fixture(); let request;
    try {
      const error = Object.assign(new Error(code), {code});
      await assert.rejects(api.runOvisDocumentPages(f.input, async value => {request = value; throw error;}), e => e === error);
      for (const path of request.writablePaths) {
        if (code === 'research_process_cancelled') await missing(path);
        else await access(path);
      }
    } finally {
      // The injected runner spawned no processes; test-owned retained paths are disposable.
      for (const path of request?.writablePaths ?? []) await rm(path, {recursive: true, force: true});
      await rm(f.root, {recursive: true, force: true});
    }
  }
});
