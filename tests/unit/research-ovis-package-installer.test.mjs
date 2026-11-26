import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, link, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {build} from 'esbuild';
const entry = 'src/main/plugins/research/ovis-package-installer.ts';
const compiled = await build({stdin: {contents: `${(await readFile(entry, 'utf8')).replace('readdir, realpath}', 'readdir, realpath as filesystemRealpath}')}
import {rm as removeAuditFixture} from 'node:fs/promises';
let disappearingDirectory;
async function realpath(path) {
  if (path === disappearingDirectory) {
    disappearingDirectory = undefined;
    await removeAuditFixture(path, {recursive: true});
  }
  return filesystemRealpath(path);
}
export function removeBeforeRealpath(path) {disappearingDirectory = path;}
export {audit};`,
  resolveDir: dirname(join(process.cwd(), entry)), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('installer audit limits runtime/cache links to its own attempt and the managed interpreter', async () => {
  const parent = await mkdtemp('/private/tmp/roc-ovis-package-unit-'), root = join(parent, 'attempt'), base = join(parent, 'base');
  await mkdir(root); await mkdir(base);
  try {
    await writeFile(join(base, 'python'), 'pinned interpreter');
    await writeFile(join(root, 'package'), 'wheel bytes');
    await symlink(join(base, 'python'), join(root, 'python'));
    await symlink('package', join(root, 'cached'));
    await api.audit(root, base);
    await mkdir(`${base}-outside`); await writeFile(join(`${base}-outside`, 'secret'), 'outside');
    await symlink(join(`${base}-outside`, 'secret'), join(root, 'escaped'));
    await assert.rejects(api.audit(root, base), /link_escape/);
    await rm(join(root, 'escaped'));
    await link(join(root, 'package'), join(root, 'hardlink'));
    await assert.rejects(api.audit(root, base), /file_invalid/);
    await rm(join(root, 'hardlink'));
    await symlink(join(base, 'missing'), join(root, 'dangling'));
    await assert.rejects(api.audit(root, base), {code: 'ENOENT'});
    await rm(join(root, 'dangling'));
    await mkdir(join(root, 'nested'));
    await symlink(join(base, 'missing'), join(root, 'nested/dangling'));
    await assert.rejects(api.audit(root, base), {code: 'ENOENT'});
    await rm(join(root, 'nested'), {recursive: true});
    await symlink(root, join(parent, 'alias'));
    await assert.rejects(api.audit(join(parent, 'alias'), base), /directory_invalid/);
  } finally {await rm(parent, {recursive: true, force: true});}
});

test('cancelled or foreign runtime requests never launch a process', async () => {
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(api.installOvisPackages({signal}, async () => assert.fail('launched')), /cancelled/);
  await assert.rejects(api.installOvisPackages({signal: new AbortController().signal, runtime: {managedPythonRoot: '/private/managed',
    version: '3.15.1'}}, async () => assert.fail('launched')), /runtime_invalid/);
});


test('installer audit tolerates uv deleting a temporary directory between stat and realpath', async () => {
  const parent = await mkdtemp('/private/tmp/roc-ovis-package-race-');
  const root = join(parent, 'attempt'), base = join(parent, 'base'), temporary = join(root, 'scratch/uv/.tmp-wheel');
  await mkdir(temporary, {recursive: true}); await mkdir(base);
  try {
    api.removeBeforeRealpath(temporary);
    await api.audit(root, base);
    await assert.rejects(readFile(temporary), {code: 'ENOENT'});
  } finally {await rm(parent, {recursive: true});}
});
