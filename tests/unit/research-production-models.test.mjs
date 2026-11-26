import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {ResearchProductionModels} = await importTypeScriptModule('src/main/plugins/research/production-models.ts',
  {platform: 'node', tempDir: '.runtime/tmp'});
const {selectedPageNumbers, parsePageRange} = await importTypeScriptModule('src/main/plugins/research/parse-page-range.ts');

async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-production-models-');
  let installed = false, releases = 0, generation = 'first', prepared = 0;
  const manager = {
    installed: async () => installed,
    acquire: async signal => {signal.throwIfAborted(); if (!installed) throw new Error('research_ovis_installation_missing');
      return {bytes: 123, installation: {identity: {generation}}, release: () => releases++};},
    install: async input => {input.signal.throwIfAborted(); installed = true;},
    remove: async () => {installed = false;}
  };
  const runtime = {prepare: async () => {prepared++; return {};}};
  const service = new ResearchProductionModels(root, {pythonRoot: join(root, 'python'), specification: await realpath('resources/ovis-ocr')},
    {manager: () => manager, runtime: () => runtime});
  try {await operation({service, manager, runtime, counters: () => ({releases, prepared}), changeGeneration: () => {generation = 'second';}});}
  finally {await rm(root, {recursive: true});}
}

test('complete is missing until installed, never borrows compact readiness, and identities follow the installed generation', async () => {
  await fixture(async ({service, counters, changeGeneration}) => {
    service.select('complete');
    assert.equal((await service.status()).ready, false);
    await assert.rejects(service.identity('complete'), /installation_missing/);
    assert.equal((await service.status()).models.some(model => model.id === 'formula'), false);
    const status = await service.download('complete');
    assert.equal(status.ready, true); assert.equal(counters().prepared, 1);
    const first = await service.identity('complete'); changeGeneration();
    assert.notEqual(await service.identity('complete'), first);
    await service.download('complete'); assert.equal(counters().prepared, 1);
    assert.ok(counters().releases > 0);
    await service.remove('complete'); assert.equal((await service.status()).ready, false);
  });
});

test('installation progress is visible, overlapping mutations are refused, and cancellation reaches the installer', async () => {
  await fixture(async ({service, manager}) => {
    let entered;
    const ready = new Promise(resolve => {entered = resolve;});
    manager.install = async input => {
      input.onProgress({phase: 'installing_wheels'}); entered();
      await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), {once: true}));
    };
    const pending = service.download('complete');
    const failed = assert.rejects(pending, /download_cancelled/);
    await ready;
    assert.equal((await service.status()).job.phase, 'installing_wheels');
    await assert.rejects(service.download('compact'), /download_locked/);
    await assert.rejects(service.remove('complete'), /download_locked/);
    assert.throws(() => service.select('compact'), /download_locked/);
    await service.cancel(); await failed;
    const status = await service.status();
    assert.equal(status.downloading, false); assert.equal(status.ready, false);
    assert.equal(status.error, 'research_download_cancelled');
  });
});

test('page selection rejects malformed, oversized and out-of-document selections before rendering', () => {
  assert.equal(selectedPageNumbers(' '), null);
  assert.deepEqual(selectedPageNumbers('3,1-2,2'), [1,2,3]);
  for (const value of ['0', '3-1', '1-501', '10001', '9007199254740993', '1,,2']) assert.throws(() => selectedPageNumbers(value));
  assert.throws(() => parsePageRange('2', 1));
  assert.throws(() => parsePageRange('', 501));
  assert.deepEqual(parsePageRange('2', 501), [2]);
});
