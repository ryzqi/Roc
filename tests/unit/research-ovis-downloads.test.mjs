import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/ovis-downloads.ts', {platform: 'node'});});
const content = Buffer.from('trusted fixture wheel'), sha256 = createHash('sha256').update(content).digest('hex');
const assets = [{path: 'wheels/fixture-1-py3-none-any.whl', size: content.length, sha256,
  url: 'https://files.pythonhosted.org/packages/fixture-1-py3-none-any.whl'}];

test('all immutable source and wheel downloads derive from the existing lock without new versions', async () => {
  const lock = await readFile('resources/ovis-ocr/requirements.lock');
  api.verifyOvisRequirements(lock);
  assert.throws(() => api.verifyOvisRequirements(Buffer.concat([lock, Buffer.from('# changed')])));
  const actual = api.ovisDownloadAssets();
  assert.equal(actual.length, 96);
  assert.equal(actual.filter(a => a.path.startsWith('wheels/')).reduce((n,a) => n+a.size, 0), 199429047);
  assert.equal(api.ovisDownloadTarget.minimumMacOS, '15.0');
});

test('consumer receives only verified bytes, progress and exclusively owned files; cleanup follows consumption', async () => {
  const parent = await mkdtemp('/private/tmp/roc-ovis-download-test-');
  const stages = [];
  try {
    await writeFile(join(parent, 'unrelated'), 'keep');
    const result = await api.withOvisDownloads({parent, assets, signal: new AbortController().signal,
      onProgress: event => stages.push(event)}, async bundle => {
      assert.deepEqual(await readFile(join(bundle.root, assets[0].path)), content);
      assert.deepEqual(await readdir(join(bundle.root, 'wheels')), ['fixture-1-py3-none-any.whl']);
      return 'consumed';
    }, async (_url, _sha, path, options) => {
      await mkdir(`${path}.parts`); await writeFile(join(`${path}.parts`, 'part'), content);
      await writeFile(path, content);
      options.onProgress({bytesDone: content.length, bytesTotal: content.length});
      return path;
    });
    assert.equal(result, 'consumed'); assert.equal(stages.at(-1).bytesDone, content.length);
    assert.equal(stages.at(-1).phase, 'verifying');
    assert.deepEqual(await readdir(parent), ['unrelated']);
  } finally {await rm(parent, {recursive: true, force: true});}
});

test('corruption, cancellation and consumer failure remove only this attempted bundle', async () => {
  for (const failure of ['corrupt', 'cancel', 'consumer']) {
    const parent = await mkdtemp('/private/tmp/roc-ovis-download-test-'), controller = new AbortController();
    let consumed = false;
    try {
      await writeFile(join(parent, 'keep'), 'unchanged');
      await assert.rejects(api.withOvisDownloads({parent, assets, signal: controller.signal}, async () => {
        consumed = true; throw new Error('consumer failure');
      }, async (_url, _sha, path) => {
        await writeFile(path, failure === 'corrupt' ? Buffer.alloc(content.length) : content);
        if (failure === 'cancel') controller.abort();
        return path;
      }));
      assert.equal(consumed, failure === 'consumer');
      assert.deepEqual(await readdir(parent), ['keep']);
      assert.equal(await readFile(join(parent, 'keep'), 'utf8'), 'unchanged');
    } finally {await rm(parent, {recursive: true, force: true});}
  }
});

test('unproven consumer process exit retains its input bundle for supervised recovery', async () => {
  const parent = await mkdtemp('/private/tmp/roc-ovis-download-test-');
  try {
    await assert.rejects(api.withOvisDownloads({parent, assets, signal: new AbortController().signal}, async () => {
      throw Object.assign(new Error('unproven'), {code: 'research_process_completion_failed'});
    }, async (_url, _sha, path) => {await writeFile(path, content); return path;}), /unproven/);
    const [directory] = await readdir(parent);
    assert.deepEqual(await readFile(join(parent, directory, assets[0].path)), content);
  } finally {await rm(parent, {recursive: true, force: true});}
});

test('unsafe names, foreign URLs, duplicate destinations and linked parents fail before download', async () => {
  const parent = await mkdtemp('/private/tmp/roc-ovis-download-test-');
  try {
    const link = join(parent, 'link'); await symlink(parent, link);
    const inputs = [
      {assets: [{...assets[0], path: 'wheels/../escape'}]}, {assets: [{...assets[0], url: 'http://files.pythonhosted.org/a'}]},
      {assets: [{...assets[0], url: 'https://evil.test/fixture-1-py3-none-any.whl'}]}, {assets: [assets[0], assets[0]]},
      {parent: link}, {parent: 'relative'}
    ];
    for (const value of inputs) await assert.rejects(api.withOvisDownloads({parent, assets, signal: new AbortController().signal, ...value},
      async () => assert.fail('consumed invalid bundle'), async () => assert.fail('dispatched invalid download')));
    assert.deepEqual(await readdir(parent), ['link']);
  } finally {await rm(parent, {recursive: true, force: true});}
});
