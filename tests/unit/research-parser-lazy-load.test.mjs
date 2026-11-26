import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPerformancePdf} from '../../scripts/lib/research-pdf-performance-fixture.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const requirePackage = createRequire(import.meta.url);
const pixels = [10, 20, 30, 255, 40, 50, 60, 255];
const raster = {width: 2, height: 1, data: Uint8Array.from(pixels)};
const modelBuffers = new Map(['ocr-det', 'ocr-rec', 'ocr-dictionary', 'layout', 'table']
  .map(id => [id, Buffer.from(id === 'ocr-dictionary' ? 'A\nB\n' : `fixture-${id}`)]));
const revision = 'a'.repeat(40);
const assets = [...modelBuffers].map(([id, bytes]) => ({
  id, name: id, kind: id === 'ocr-dictionary' ? 'dictionary' : 'onnx', file: `${id}.bin`,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  url: `https://example.test/${revision}/${id}.bin`, license: 'Apache-2.0', sourceRevision: revision
}));
const modelLock = {
  schemaVersion: 2, engine: 'paddleocr.js',
  packs: {compact: {assetIds: assets.map(asset => asset.id), bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0)}},
  assets
};

async function fixture(t, {entry = 'parser', forbidOrt = false, forbidUtif = false} = {}) {
  await mkdir(join(repositoryRoot, '.runtime/tmp'), {recursive: true});
  const root = await mkdtemp(join(repositoryRoot, '.runtime/tmp/parser-lazy-load-'));
  const key = `parserLazyLoad:${randomUUID()}`;
  const state = {events: [], images: [], forbidOrt, forbidUtif};
  globalThis[key] = state;
  t.after(async () => {
    delete globalThis[key];
    await rm(root, {recursive: true, force: true});
  });
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const modelFiles = {};
  for (const [field, id] of [
    ['detection', 'ocr-det'], ['recognition', 'ocr-rec'], ['dictionary', 'ocr-dictionary'], ['layout', 'layout'], ['table', 'table']
  ]) {
    modelFiles[field] = join(root, `${id}.bin`);
    await writeFile(modelFiles[field], modelBuffers.get(id));
  }
  state.createSession = async buffer => {
    assert.deepEqual(Buffer.from(buffer), modelBuffers.get('layout'));
    state.events.push('ort:create');
    return {
      inputNames: ['input'], outputNames: ['output'], inputMetadata: [{isTensor: true, shape: [1, 3, 1, 2]}],
      run: async feeds => {state.events.push('ort:run'); return {output: feeds.input};},
      release: async () => {state.events.push('ort:release');}
    };
  };
  const nativeSource = {
    'onnxruntime-node': `
      const state = globalThis[${JSON.stringify(key)}];
      state.events.push('ort:load');
      state.onOrtLoad?.();
      if (state.forbidOrt) throw new Error('unexpected_onnxruntime_load');
      module.exports = {
        get Tensor() {state.events.push('ort:configure'); return class Tensor {};},
        InferenceSession: {create: buffer => state.createSession(buffer)}
      };`,
    paddleocr: `
      const state = globalThis[${JSON.stringify(key)}];
      export const getObjectDetectionPreset = name => ({name, options: {labels: ['text']}});
      export const parseRecognitionDictionary = text => text.trim().split('\\n');
      export const matchTableStructureToOcr = () => {throw new Error('unexpected_table_inference');};
      export const PaddleStructureService = {createInstance: async options => {
        state.events.push('paddle:create');
        const session = await options.ort.InferenceSession.create(options.layout.modelBuffer);
        return {run: async image => {
          state.events.push('paddle:run');
          state.images.push({width: image.width, height: image.height, data: Array.from(image.data)});
          await session.run({input: new options.ort.Tensor()});
          return {regions: [{type: 'text', label: 'Text', score: 1, status: 'success',
            bbox: [0, 0, image.width, image.height], ocr: [{text: 'OCR fixture text'}]}]};
        }};
      }};`
  };
  const utifPath = join(root, 'utif.mjs');
  // An external module preserves Node's real CommonJS default export boundary.
  await writeFile(utifPath, `
    export {default} from 'utif';
    const state = globalThis[${JSON.stringify(key)}];
    state.events.push('utif:load');
    if (state.forbidUtif) throw new Error('unexpected_utif_load');
  `);
  const outfile = join(root, 'fixture.mjs');
  await build({
    stdin: {contents: `
      export {imagePng, decodeRasterDocument} from './src/main/plugins/research/research-raster';
      ${entry === 'parser' ? `
        export {parseResearchDocument} from './src/main/plugins/research/document-parser';
        export {modelPackManifest} from './src/main/plugins/research/model-catalog';` : ''}
    `, resolveDir: repositoryRoot, loader: 'ts'},
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'silent',
    plugins: [{name: 'parser-native-load-boundaries', setup(builder) {
      builder.onResolve({filter: /^(onnxruntime-node|paddleocr)$/},
        args => ({path: args.path, namespace: 'parser-fixture'}));
      builder.onResolve({filter: /^utif$/}, () => ({path: pathToFileURL(utifPath).href, external: true}));
      builder.onLoad({filter: /.*/, namespace: 'parser-fixture'},
        args => ({contents: nativeSource[args.path], loader: 'js'}));
      // Keep the real catalog, manifest and file/hash validation with tiny test assets.
      builder.onLoad({filter: /\/research-models\/models\.lock\.json$/},
        () => ({contents: JSON.stringify(modelLock), loader: 'json'}));
    }}]
  });
  const module = await import(pathToFileURL(outfile).href);
  let sequence = 0;
  const parse = async (name, bytes, overrides = {}) => {
    const sourcePath = join(projectRoot, name);
    const outputDir = join(projectRoot, `parsed-${++sequence}`);
    await writeFile(sourcePath, bytes);
    const result = await module.parseResearchDocument({
      projectRoot, sourcePath, outputDir, modelFiles, modelManifest: module.modelPackManifest('compact'),
      options: {tier: 'compact', device: 'cpu', pageRange: '1'}, timeoutMs: 10_000,
      ...overrides,
      onStage: event => {
        if (event.stage === 'model-validation' || event.stage === 'model-initialization') state.events.push(event.stage);
        overrides.onStage?.(event);
      }
    });
    return {result, outputDir};
  };
  return {...module, state, modelFiles, projectRoot, parse};
}

test('HTML and native-text PDFs parse without loading the ONNX runtime', async t => {
  const f = await fixture(t, {forbidOrt: true});
  const html = await f.parse('source.html', '<h1>Evidence</h1><p>Accessible without OCR.</p>', {modelFiles: null});
  assert.equal(html.result.parseMode, 'html');
  assert.equal(html.result.content, 'Evidence\n\nAccessible without OCR.');
  assert.deepEqual(html.result.assets, []);
  const pdf = createPerformancePdf();
  for (const modelFiles of [null, f.modelFiles]) {
    const {result, outputDir} = await f.parse(`native-${modelFiles === null ? 'missing' : 'available'}.pdf`, pdf, {modelFiles});
    assert.equal(result.parseMode, 'native-text');
    assert.ok(result.content.length >= 600);
    assert.deepEqual(result.assets, []);
    assert.ok(result.blocks.every(block => block.locations.every(location => location.page === 1)));
    assert.equal(await readFile(join(outputDir, result.artifacts.markdown), 'utf8'), result.content);
  }
  assert.deepEqual(f.state.events, []);
});

test('PNG decoding works without loading TIFF support', async t => {
  const f = await fixture(t, {entry: 'raster', forbidUtif: true});
  const png = await f.imagePng(raster);
  const document = await f.decodeRasterDocument(png, '.PNG');
  assert.equal(document.pageCount, 1);
  assert.deepEqual(await document.page(1), raster);
  await assert.rejects(document.page(2), error => error.code === 'research_image_page_invalid');
  assert.deepEqual(f.state.events, []);
});

test('TIFF support loads on demand and decodes pixels from a Buffer slice', async t => {
  const f = await fixture(t, {entry: 'raster'});
  assert.deepEqual(f.state.events, []);
  const tiff = Buffer.from(requirePackage('utif').encodeImage(Uint8Array.from(pixels), 2, 1));
  const padded = Buffer.concat([Buffer.from('prefix'), tiff, Buffer.from('suffix')]);
  const source = padded.subarray(6, 6 + tiff.length);
  const document = await f.decodeRasterDocument(source, '.TiFf');
  assert.equal(document.pageCount, 1);
  assert.deepEqual(await document.page(1), raster);
  await assert.rejects(document.page(0), error => error.code === 'research_image_page_invalid');
  assert.deepEqual(await (await f.decodeRasterDocument(source, '.tif')).page(1), raster);
  assert.deepEqual(f.state.events, ['utif:load']);
});

test('a damaged final OCR model fails validation without loading ONNX', async t => {
  const f = await fixture(t, {forbidOrt: true});
  const damaged = Buffer.from(modelBuffers.get('table'));
  damaged[0] ^= 1;
  await writeFile(f.modelFiles.table, damaged);
  await assert.rejects(f.parse('source.png', await f.imagePng(raster)),
    error => error.code === 'research_model_asset_invalid');
  assert.deepEqual(f.state.events, ['model-validation']);
  await assert.rejects(access(join(f.projectRoot, 'parsed-1')), {code: 'ENOENT'});
});

test('validated OCR loads ONNX before inference and releases its native sessions', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.state.events, []);
  const {result, outputDir} = await f.parse('source.png', await f.imagePng(raster));
  assert.equal(result.parseMode, 'ocr');
  assert.equal(result.content, 'OCR fixture text');
  assert.deepEqual(f.state.images, [{width: 2, height: 1, data: pixels}]);
  for (const [before, after] of [
    ['model-validation', 'ort:load'], ['ort:load', 'ort:configure'], ['ort:configure', 'paddle:create'],
    ['paddle:create', 'model-initialization'], ['model-initialization', 'paddle:run'], ['paddle:run', 'ort:run']
  ]) {
    assert.ok(f.state.events.indexOf(before) >= 0 && f.state.events.indexOf(after) > f.state.events.indexOf(before),
      `${after} must follow ${before}`);
  }
  assert.equal(f.state.events.filter(event => event === 'ort:load').length, 1);
  const created = f.state.events.filter(event => event === 'ort:create').length;
  assert.ok(created > 0);
  assert.equal(f.state.events.filter(event => event === 'ort:release').length, created);
  const pagePng = await readFile(join(outputDir, result.assets[0].path));
  assert.deepEqual(pagePng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

for (const boundary of ['after validation', 'during ONNX import']) {
  test(`cancellation ${boundary} prevents runtime configuration and OCR sessions`, async t => {
    const f = await fixture(t);
    assert.deepEqual(f.state.events, []);
    const controller = new AbortController();
    if (boundary === 'during ONNX import') f.state.onOrtLoad = () => controller.abort();
    await assert.rejects(f.parse('source.png', await f.imagePng(raster), {
      signal: controller.signal,
      onStage: event => {
        if (boundary === 'after validation' && event.stage === 'model-validation') controller.abort();
      }
    }), error => error.code === 'research_process_cancelled');
    assert.deepEqual(f.state.events, boundary === 'after validation'
      ? ['model-validation'] : ['model-validation', 'ort:load']);
    await assert.rejects(access(join(f.projectRoot, 'parsed-1')), {code: 'ENOENT'});
  });
}
