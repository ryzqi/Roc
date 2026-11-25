import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, access, rename, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let parser, capture, adapter, writer, collector, exitState;
before(async () => {
  [parser, capture, adapter, writer, collector, exitState] = await Promise.all([
    'ovis-document-parser', 'ovis-source-artifact', 'ovis-document-adapter', 'ovis-parsed-document', 'document-files', 'process-exit-state'
  ].map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
    external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'})));
});
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-ovis-parser-test-');
  try {
    const pdf = await PDFDocument.create(); pdf.addPage([200, 300]);
    const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, await pdf.save());
    const controller = new AbortController(), counts = {acquired: 0, released: 0};
    const input = {projectRoot: root, sourcePath, outputDir: join(root, 'output'), sourceKind: 'pdf', pages: null,
      timeoutMs: 60000, signal: controller.signal, admission: {projectId: 'ovis-parser-test', priority: 'user', resourceClass: 'parse'}};
    const models = {acquire: async signal => {signal.throwIfAborted(); counts.acquired++;
      return {installation: {identity}, release: () => {counts.released++;}};}};
    const raw = JSON.stringify([{category: 'text', content: 'Captured parser evidence.', bbox: [50, 50, 900, 900]}]);
    const dependencies = {capture: async request => await capture.createOvisSourceArtifact(request, async worker => ({
      process: {exitCode: 0}, pages: worker.pages.map(({binding}) => adapter.adaptOvisPage(Buffer.from(raw), {
        protocolVersion: 1, sourceHash: binding.sourceHash, inputImageSha256: binding.inputImageSha256, model: identity,
        page: binding.frame.page, width: binding.frame.width, height: binding.frame.height, rawSha256: hash(raw),
        generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding))})),
      write: writer.writeOvisParsedDocument};
    await operation({root, input, models, dependencies, counts, controller});
  } finally {await rm(root, {recursive: true, force: true});}
}
const absent = path => assert.rejects(access(path), {code: 'ENOENT'});

test('one lease spans capture, derived artifacts and final source verification then yields a collectable result', async () => {
  await fixture(async ({input, models, dependencies, counts, root}) => {
    const write = dependencies.write;
    dependencies.write = async value => {assert.equal(counts.acquired, 1); assert.equal(counts.released, 0); return await write(value);};
    const result = await parser.parseOvisDocument(input, models, dependencies);
    assert.deepEqual(counts, {acquired: 1, released: 1});
    const collected = await collector.collectDocumentContent(root, input.outputDir, result);
    assert.equal(collected.data.content.content, 'Captured parser evidence.');
    assert.deepEqual(collected.data.content.modelIdentity, identity);
  });
});

test('post-capture cancellation removes only the new output and releases its lease before retry', async () => {
  await fixture(async ({input, models, dependencies, counts, controller}) => {
    const capture = dependencies.capture;
    dependencies.capture = async value => {const result = await capture(value); controller.abort(); return result;};
    await assert.rejects(parser.parseOvisDocument(input, models, dependencies), {name: 'AbortError'});
    await absent(input.outputDir); await access(input.sourcePath);
    assert.deepEqual(counts, {acquired: 1, released: 1});
    const result = await parser.parseOvisDocument({...input, signal: new AbortController().signal}, models, {...dependencies, capture});
    assert.equal(result.engine, 'ovisocr3-mlx'); assert.equal(counts.released, 2);
  });
});

test('derived failure and source changes before completion prevent output publication and release the lease', async () => {
  for (const failure of ['write', 'source']) await fixture(async ({input, models, dependencies, counts}) => {
    const write = dependencies.write;
    dependencies.write = async value => {
      if (failure === 'write') throw new Error('fixture_write_failed');
      const result = await write(value); await writeFile(input.sourcePath, 'changed'); return result;
    };
    await assert.rejects(parser.parseOvisDocument(input, models, dependencies),
      failure === 'write' ? /fixture_write_failed/ : /research_source_changed_during_parse/);
    await absent(input.outputDir); assert.equal(counts.released, 1);
  });
});

test('nested unproven Worker exit retains both rendered inputs and model reservation', async () => {
  await fixture(async ({input, models, dependencies, counts}) => {
    const failure = new AggregateError([new Error('cleanup detail'),
      new Error('wrapped', {cause: Object.assign(new Error('kill unproven'), {code: 'research_process_kill_failed'})})], 'aggregate');
    dependencies.capture = async request => await capture.createOvisSourceArtifact(request, async () => {throw failure;});
    await assert.rejects(parser.parseOvisDocument(input, models, dependencies), error => error === failure);
    await access(join(input.outputDir, 'pages/page-1.png')); await absent(join(input.outputDir, 'manifest.json'));
    assert.deepEqual(counts, {acquired: 1, released: 0});
  });
});

test('preexisting results and replacement directories are preserved on failure', async () => {
  await fixture(async ({input, models, dependencies, counts}) => {
    await mkdir(input.outputDir); await writeFile(join(input.outputDir, 'existing'), 'keep');
    await assert.rejects(parser.parseOvisDocument(input, models, dependencies), /research_output_already_exists/);
    assert.equal(await readFile(join(input.outputDir, 'existing'), 'utf8'), 'keep'); assert.equal(counts.released, 1);
  });
  await fixture(async ({input, models, dependencies, counts}) => {
    dependencies.write = async () => {
      await rename(input.outputDir, `${input.outputDir}-original`); await mkdir(input.outputDir);
      await writeFile(join(input.outputDir, 'replacement'), 'keep'); throw new Error('fixture_changed_directory');
    };
    await assert.rejects(parser.parseOvisDocument(input, models, dependencies), error =>
      error instanceof AggregateError && error.errors.some(item => item.message === 'research_ovis_artifact_cleanup_identity_changed'));
    assert.equal(await readFile(join(input.outputDir, 'replacement'), 'utf8'), 'keep');
    await access(`${input.outputDir}-original/manifest.json`); assert.equal(counts.released, 1);
  });
});

test('deadline includes acquisition, and pre-aborted calls never reserve a model', async () => {
  await fixture(async ({input, models, dependencies, counts}) => {
    await assert.rejects(parser.parseOvisDocument({...input, signal: AbortSignal.abort()}, models, dependencies));
    assert.equal(counts.acquired, 0);
    const pending = {acquire: signal => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture_deadline_missing')), 1000);
      signal.addEventListener('abort', () => {clearTimeout(timer); reject(signal.reason);}, {once: true});
    })};
    await assert.rejects(parser.parseOvisDocument({...input, timeoutMs: 10}, pending, dependencies), {name: 'TimeoutError'});
    await absent(input.outputDir);
  });
});

test('exit classification preserves nested uncertainty and terminates on cyclic causes', () => {
  const cycle = new Error('cycle'); cycle.cause = cycle;
  assert.equal(exitState.hasUnprovenResearchProcessExit(cycle), false);
  for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
    const failure = Object.assign(new Error(code), {code});
    assert.equal(exitState.hasUnprovenResearchProcessExit(new AggregateError([cycle, new Error('wrapped', {cause: failure})])), true);
  }
  assert.equal(exitState.hasUnprovenResearchProcessExit(Object.assign(new Error('normal'), {code: 'research_process_cancelled'})), false);
});
