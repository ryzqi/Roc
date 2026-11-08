import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'vite';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {readChunkPackages} from '../../scripts/lib/renderer-chunk-attribution.mjs';

const {rendererChunkMetadata, packageNameFromModuleId} = await importTypeScriptModule('scripts/renderer-chunk-metadata.ts', {platform: 'node'});

test('module IDs resolve scoped pnpm packages and Windows paths', () => {
  assert.equal(packageNameFromModuleId('/p/node_modules/.pnpm/@xterm+xterm@1/node_modules/@xterm/xterm/index.js'), '@xterm/xterm');
  assert.equal(packageNameFromModuleId('C:\\p\\node_modules\\react\\index.js'), 'react');
  assert.equal(packageNameFromModuleId('/p/src/index.ts'), undefined);
});

test('minified Vite output still rejects eager forbidden packages and stale/missing attribution', async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  const directory = mkdtempSync(resolve('.runtime/tmp/chunk-metadata-'));
  const rendererRoot = join(directory, 'dist/renderer');
  try {
    writeFileSync(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(join(directory, 'main.js'), "import {z} from 'zod'; console.log(z.string().parse(window.location.hash)); window.loadPanel = () => import('./panel.js');");
    writeFileSync(join(directory, 'panel.js'), "import './panel.css'; export const panel = 'lazy panel';");
    writeFileSync(join(directory, 'panel.css'), '.panel { color: red; }');
    await build({configFile: false, root: directory, logLevel: 'silent', plugins: [rendererChunkMetadata()],
      build: {outDir: rendererRoot, manifest: true, minify: 'oxc'}});
    const manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite/manifest.json'), 'utf8'));
    const file = manifest['index.html'].file;
    const source = readFileSync(join(rendererRoot, file), 'utf8');
    assert.ok(!source.includes('//#region'));
    assert.ok(readChunkPackages(rendererRoot, file, source).has('zod'));
    const check = spawnSync(process.execPath, [resolve('scripts/check-renderer-chunks.mjs')], {cwd: directory, encoding: 'utf8'});
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /renderer_chunk_eager_forbidden_package:.*:zod/);
    assert.throws(() => readChunkPackages(rendererRoot, file, `${source}\nchanged`), /metadata_invalid/);
    rmSync(join(rendererRoot, '.vite/chunk-packages.json'));
    assert.throws(() => readChunkPackages(rendererRoot, file, source), /ENOENT/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
