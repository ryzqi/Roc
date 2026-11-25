import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {build} from 'esbuild';
const entry = 'src/main/plugins/research/ovis-conversion.ts';
const compiled = await build({stdin: {contents: `${await readFile(entry, 'utf8')}\nexport {verifySource};`,
  resolveDir: dirname(join(process.cwd(), entry)), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('conversion rejects extra, missing, corrupt and linked official source entries', async () => {
  const root = await mkdtemp('/private/tmp/roc-ovis-conversion-unit-'), source = join(root, 'source');
  await mkdir(source); const signal = new AbortController().signal;
  try {
    await assert.rejects(api.verifySource(source, signal), /source_invalid/);
    await writeFile(join(source, 'unexpected.py'), 'raise RuntimeError("must not execute")');
    await assert.rejects(api.verifySource(source, signal), /source_invalid/);
    await rm(join(source, 'unexpected.py'));
    await writeFile(join(source, 'config.json'), '{}');
    await assert.rejects(api.verifySource(source, signal), /input_changed/);
    await rm(join(source, 'config.json'));
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(source, 'prompts'));
    await assert.rejects(api.verifySource(source, signal), /directory_invalid/);
  } finally {await rm(root, {recursive: true});}
});

test('conversion never executes cancelled or overlapping installation requests', async () => {
  await assert.rejects(api.convertOvisModel({signal: AbortSignal.abort(new Error('cancelled'))}, async () => assert.fail('executed')), /cancelled/);
  const root = await mkdtemp('/private/tmp/roc-ovis-conversion-unit-');
  try {
    for (const name of ['source', 'spec', 'runtime', 'packages']) await mkdir(join(root, name));
    await assert.rejects(api.convertOvisModel({signal: new AbortController().signal, source: join(root, 'source'),
      specification: join(root, 'spec'), destination: join(root, 'source'), packagesRoot: join(root, 'packages'),
      runtime: {prefix: join(root, 'runtime')}}, async () => assert.fail('executed')), /overlapping_paths/);
    await writeFile(join(root, 'source', 'existing'), 'keep');
    await assert.rejects(api.convertOvisModel({signal: new AbortController().signal, source: join(root, 'source'),
      specification: join(root, 'spec'), destination: join(root, 'source'), packagesRoot: join(root, 'packages'),
      runtime: {prefix: join(root, 'runtime')}}, async () => assert.fail('executed')), /destination_not_empty/);
    assert.equal(await readFile(join(root, 'source', 'existing'), 'utf8'), 'keep');
  } finally {await rm(root, {recursive: true});}
});
