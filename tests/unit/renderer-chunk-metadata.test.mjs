import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'vite';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {readChunkPackages} from '../../scripts/lib/renderer-chunk-attribution.mjs';

const {rendererChunkMetadata, packageNameFromModuleId} = await importTypeScriptModule('scripts/renderer-chunk-metadata.ts', {platform: 'node'});
const {mermaidDiagramBuild} = await importTypeScriptModule('scripts/mermaid-diagram-build.ts', {
  platform: 'node', external: ['@babel/parser'], tempDir: '.runtime/tmp'
});

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

test('the chunk guard rejects oversized lazy application entries after minification', async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  const directory = mkdtempSync(resolve('.runtime/tmp/chunk-size-'));
  const rendererRoot = join(directory, 'dist/renderer');
  try {
    mkdirSync(join(directory, 'src/renderer'), {recursive: true});
    writeFileSync(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(join(directory, 'main.js'), "window.loadNotes = () => import('./src/renderer/notes.js');");
    const check = () => spawnSync(process.execPath, [resolve('scripts/check-renderer-chunks.mjs')], {
      cwd: directory, encoding: 'utf8'
    });
    for (const oversized of [false, true]) {
      // A real emitted UTF-8 payload: the guard must count bytes, including lazy
      // entries, rather than source length or just the entry's static imports.
      writeFileSync(join(directory, 'src/renderer/notes.js'),
        `export const text = ${JSON.stringify('笔记'.repeat(oversized ? 90_000 : 10))};`);
      await build({configFile: false, root: directory, logLevel: 'silent', plugins: [rendererChunkMetadata()],
        build: {outDir: rendererRoot, manifest: true, minify: 'oxc'}});
      const result = check();
      if (oversized) {
        assert.notEqual(result.status, 0, 'oversized lazy notes chunk must fail the guard');
        assert.match(result.stderr, /renderer_chunk_app_budget_exceeded:src\/renderer\/notes\.js:/);
      } else {
        assert.equal(result.status, 0, result.stderr);
      }
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('the chunk guard rejects oversized shared vendors and unsupported diagram packages in lazy chunks', async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  const directory = mkdtempSync(resolve('.runtime/tmp/chunk-vendor-'));
  const rendererRoot = join(directory, 'dist/renderer');
  try {
    writeFileSync(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(join(directory, 'main.js'), "window.loadPanel = () => import('./panel.js');");
    const cases = [
      {name: 'large-vendor', text: '笔'.repeat(180_000), error: /renderer_chunk_vendor_budget_exceeded:/},
      {name: 'elkjs', text: 'small lazy API'},
      {name: '@mermaid-js/parser', text: 'unused parser', error: /renderer_chunk_unsupported_diagram_package:.*:@mermaid-js\/parser/}
    ];
    for (const fixture of cases) {
      const vendor = join(directory, 'node_modules', fixture.name);
      mkdirSync(vendor, {recursive: true});
      writeFileSync(join(vendor, 'index.js'), `export const text = ${JSON.stringify(fixture.text)};`);
      writeFileSync(join(directory, 'panel.js'), `export {text} from './node_modules/${fixture.name}/index.js';`);
      await build({configFile: false, root: directory, logLevel: 'silent', plugins: [rendererChunkMetadata()],
        build: {outDir: rendererRoot, manifest: true, minify: 'oxc',
          rolldownOptions: {output: {codeSplitting: {groups: [{name: 'vendor', test: /\/node_modules\//u}]}}}}});
      const result = spawnSync(process.execPath, [resolve('scripts/check-renderer-chunks.mjs')], {
        cwd: directory, encoding: 'utf8'
      });
      if (fixture.error) {
        assert.notEqual(result.status, 0, `${fixture.name} must fail even behind a lazy boundary`);
        assert.match(result.stderr, fixture.error);
      } else {
        assert.equal(result.status, 0, result.stderr);
      }
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('the chunk guard tracks Vite Worker assets and rejects unreferenced JavaScript', async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  const directory = mkdtempSync(resolve('.runtime/tmp/chunk-worker-'));
  const rendererRoot = join(directory, 'dist/renderer');
  try {
    writeFileSync(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(join(directory, 'main.js'),
      "window.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});");
    writeFileSync(join(directory, 'worker.js'), "self.postMessage('ready');");
    await build({configFile: false, root: directory, logLevel: 'silent', plugins: [rendererChunkMetadata()],
      build: {outDir: rendererRoot, manifest: true, minify: 'oxc'}});
    const manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite/manifest.json'), 'utf8'));
    assert.ok(manifest['index.html'].assets.some(file => /worker/u.test(file)));
    const check = () => spawnSync(process.execPath, [resolve('scripts/check-renderer-chunks.mjs')], {
      cwd: directory, encoding: 'utf8'
    });
    const passing = check();
    assert.equal(passing.status, 0, passing.stderr);
    writeFileSync(join(rendererRoot, 'assets/unreferenced.js'), "console.log('untracked');");
    const changed = check();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /renderer_chunk_untracked_javascript:assets\/unreferenced\.js/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Mermaid keeps supported layouts with a local ELK Worker asset and bounded lazy chunks', async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  const directory = mkdtempSync(resolve('.runtime/tmp/mermaid-worker-'));
  const rendererRoot = join(directory, 'dist/renderer');
  try {
    writeFileSync(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(join(directory, 'main.js'),
      `window.loadDiagram = () => import(${JSON.stringify(resolve('src/renderer/diagram-worker/index.ts'))});`);
    await build({configFile: false, root: directory, base: './', logLevel: 'silent',
      plugins: [mermaidDiagramBuild(), rendererChunkMetadata()],
      build: {outDir: rendererRoot, manifest: true, minify: 'oxc'}});
    const metadata = JSON.parse(readFileSync(join(rendererRoot, '.vite/diagram-worker-assets.json'), 'utf8'));
    const workers = Object.keys(metadata.assets);
    assert.equal(workers.length, 1);
    assert.ok(statSync(join(rendererRoot, workers[0])).size > 500_000, 'the engine is a separate prebuilt Worker');
    const manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite/manifest.json'), 'utf8'));
    assert.ok(!Object.keys(manifest).some(key => /cose-bilkent/u.test(key)), 'unsupported layout stays out');
    const check = () => spawnSync(process.execPath, [resolve('scripts/check-renderer-chunks.mjs')], {
      cwd: directory, encoding: 'utf8'
    });
    const passing = check();
    assert.equal(passing.status, 0, passing.stderr);
    writeFileSync(join(rendererRoot, workers[0]), `${readFileSync(join(rendererRoot, workers[0]), 'utf8')}\nchanged`);
    const changed = check();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /renderer_worker_asset_metadata_invalid:/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
