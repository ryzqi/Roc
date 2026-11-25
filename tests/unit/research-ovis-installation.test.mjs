import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {prepareOvisInstallation} = await importTypeScriptModule('src/main/plugins/research/ovis-installation.ts', {platform: 'node'});

test('cancelled, failed and unproven preparations preserve existing generations with distinct cleanup semantics', async () => {
  const root = await mkdtemp('/private/tmp/roc-ovis-installation-unit-'), parent = join(root, 'installations');
  await mkdir(parent); const existing = join(parent, 'existing'); await mkdir(existing); await writeFile(join(existing, 'receipt.json'), 'keep');
  const input = {parent, specification: await realpath('resources/ovis-ocr'), projectId: 'ovis-unit',
    runtime: {prefix: join(root, 'python')}, signal: new AbortController().signal};
  try {
    await assert.rejects(prepareOvisInstallation({...input, signal: AbortSignal.abort(new Error('cancelled'))},
      async () => assert.fail('downloaded')), /cancelled/);
    assert.deepEqual(await readdir(parent), ['existing']);
    await assert.rejects(prepareOvisInstallation(input, async () => {throw new Error('offline');}), /offline/);
    assert.deepEqual(await readdir(parent), ['existing']);
    for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
      const unproven = Object.assign(new Error(code), {code});
      const wrapped = new AggregateError([new Error('cleanup wrapper', {cause: unproven})], 'wrapped');
      let failure;
      try {await prepareOvisInstallation(input, async () => {throw wrapped;});}
      catch (error) {failure = error;}
      assert.equal(failure, wrapped);
      assert.ok(failure.retainedInstallation.startsWith(`${parent}/ovis-install-`));
      assert.ok((await readdir(parent)).some(name => name.startsWith('ovis-download-')));
      // No process was launched by this injected failure; only this fixture may clear these retained directories.
      for (const name of await readdir(parent)) if (name !== 'existing') await rm(join(parent, name), {recursive: true});
    }
    assert.equal(await readFile(join(existing, 'receipt.json'), 'utf8'), 'keep');
  } finally {await rm(root, {recursive: true});}
});
