#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { projectRoot } from './lib/project-paths.mjs';

if (process.platform !== 'darwin') {
  throw new Error('smoke:mac requires macOS.');
}
const appPath = realpathSync(process.argv[2] === undefined
  ? join(projectRoot, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app')
  : resolve(process.argv[2]));
const diagnosticRollback = process.argv[3] === '--diagnostic-rollback';
assert.ok(process.argv.length <= 4 && (process.argv[3] === undefined || diagnosticRollback),
  'Usage: smoke-mac.mjs [Roc.app] [--diagnostic-rollback]');
assert.equal(basename(appPath), 'Roc.app');
const executablePath = join(appPath, 'Contents', 'MacOS', 'Roc');
const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' });
assert.equal(signature.status, 0, signature.stderr || signature.error?.message);

const artifactDir = join(projectRoot, '.artifacts', diagnosticRollback ? 'mac-package-diagnostic' : 'mac-package');
const runtimeRoot = join(projectRoot, '.runtime', 'mac-smoke');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
const runRoot = mkdtempSync(join(runtimeRoot, 'run-'));
const workspaceRoot = join(runRoot, 'workspace');
mkdirSync(join(workspaceRoot, 'nested'), { recursive: true });
writeFileSync(join(workspaceRoot, 'nested', 'probe.txt'), 'ROC_FILE_PREVIEW_OK', 'utf8');
const bibtexPath = join(workspaceRoot, 'probe.bib');
writeFileSync(bibtexPath, '@article{wasmProbe, title={Packaged parser}, author={Lovelace, Ada}, year={1843}}\n');
const errors = [];
const startedAt = performance.now();
let application;

try {
  const env = { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: join(runRoot, 'data') };
  const diagnosticFlags = [
    'ROC_PERF_MEMORY_SQL_V2', 'ROC_PERF_RAG_BATCH_HYDRATION', 'ROC_PERF_PDF_RANGE_READER',
    'ROC_PERF_PROCESS_SCAN_BATCH', 'ROC_PERF_RESEARCH_LAZY_INIT', 'ROC_PERF_RESEARCH_WORKER_QUERIES'
  ];
  for (const flag of diagnosticFlags) {
    if (diagnosticRollback) env[flag] = '0';
    else delete env[flag];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(runRoot, 'chromium')}`],
    env,
    timeout: 90000
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.locator('[data-testid="roc-app"]').waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const rendererReadyMs = Math.round(performance.now() - startedAt);
  const status = await page.evaluate(() => window.roc.app.getStatus());
  assert.equal(status.ok, true, JSON.stringify(status));
  const toolchainStatus = await page.evaluate(() => window.roc.research.getToolchainStatus());
  assert.equal(toolchainStatus.ok, true, JSON.stringify(toolchainStatus));
  assert.equal(toolchainStatus.data.available, true, JSON.stringify(toolchainStatus.data));
  const expectedAccent = await application.evaluate(({ systemPreferences }) => `#${systemPreferences.getAccentColor().slice(0, 6)}`);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--system-accent').trim())).toBe(expectedAccent);
  await page.evaluate(() => {
    globalThis.__rocAppearanceNotification = null;
    const dispose = window.roc.app.onAppearanceUpdated((appearance) => {
      globalThis.__rocAppearanceNotification = appearance;
      dispose();
    });
  });
  await application.evaluate(({ systemPreferences }) => {
    systemPreferences.postLocalNotification('NSSystemColorsDidChangeNotification', {});
  });
  await expect.poll(() => page.evaluate(() => globalThis.__rocAppearanceNotification?.accentColor)).toBe(expectedAccent);

  const workflow = await page.evaluate(async (workspacePath) => {
    const unwrap = (result) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    unwrap(await window.roc.workspace.select({ path: workspacePath }));
    const preview = unwrap(await window.roc.files.preview({ relativePath: 'nested/probe.txt' }));
    const session = unwrap(await window.roc.terminal.createSession({ cwd: workspacePath, cols: 80, rows: 24 }));
    let dispose;
    let timer;
    try {
      const output = new Promise((resolvePromise, reject) => {
        let text = '';
        dispose = window.roc.terminal.onOutput((event) => {
          if (event.sessionId !== session.id) return;
          text += event.data;
          if (text.includes('ROC_IPC_PTY_OK')) resolvePromise('ROC_IPC_PTY_OK');
        });
        timer = setTimeout(() => reject(new Error('Terminal IPC output timed out.')), 10000);
      });
      unwrap(await window.roc.terminal.writeInput({ sessionId: session.id, data: "printf 'ROC_%s\\n' IPC_PTY_OK\r" }));
      await output;
    } finally {
      clearTimeout(timer);
      dispose?.();
      unwrap(await window.roc.terminal.closeSession({ sessionId: session.id }));
    }
    const shell = unwrap(await window.roc.shell.execute({ command: 'printf ROC_IPC_SHELL_OK', cwd: workspacePath }));
    return { preview: preview.content, terminalShell: session.shell, terminal: 'ROC_IPC_PTY_OK', shell };
  }, workspaceRoot);
  assert.equal(workflow.preview, 'ROC_FILE_PREVIEW_OK');
  assert.equal(workflow.terminal, 'ROC_IPC_PTY_OK');
  assert.equal(workflow.shell.exitCode, 0);
  assert.equal(workflow.shell.stdout, 'ROC_IPC_SHELL_OK');

  const imported = await page.evaluate((sourcePath) =>
    window.roc.research.importBibliography({ sourcePath, format: 'bibtex', projectId: null }), bibtexPath);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.data.createdCount, 1);
  const { citationKey, title, authors, publishedYear } = imported.data.items[0].bibliography;
  const bibtex = { citationKey, title, authors, publishedYear };
  assert.deepEqual(bibtex, { citationKey: 'wasmProbe', title: 'Packaged parser', authors: ['Ada Lovelace'], publishedYear: 1843 });

  const researchWorker = await page.evaluate(async (workspacePath) => {
    const unwrap = result => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    const project = unwrap(await window.roc.research.createProject({
      title: 'Packaged Worker fixture', description: 'Isolated generated readonly corpus', workspacePath
    }));
    for (let document = 0; document < 100; document++) {
      const id = `package-worker-document-${document}`;
      const chunks = Array.from({ length: 100 }, (_, index) => ({
        content: `packagedneedle evidence ${document} ${index} 中文方法`, locator: `page:${index + 1}`
      }));
      unwrap(await window.roc.research.upsertKnowledgeDocument({
        id, projectId: project.id, sourceType: 'file', sourceId: id,
        title: `Generated Worker document ${document}`, content: chunks.map(chunk => chunk.content).join('\n'),
        chunks, embeddingConfigId: null
      }));
    }
    const request = { query: 'packagedneedle', projectId: project.id, limit: 10,
      candidateLimit: 50, embeddingConfigId: null, rerank: 'none' };
    const first = unwrap(await window.roc.research.searchKnowledge(request));
    const second = unwrap(await window.roc.research.searchKnowledge(request));
    return {
      chunks: 10_000, requests: 2, query: request.query, projectId: project.id,
      hits: first.hits, secondHits: second.hits,
      ranking: first.ranking, secondRanking: second.ranking,
      keywordCount: first.keywordCount, vectorCount: first.vectorCount
    };
  }, workspaceRoot);
  assert.equal(researchWorker.hits.length, 10);
  assert.equal(researchWorker.keywordCount, 50);
  assert.equal(researchWorker.vectorCount, 0);
  assert.ok(researchWorker.hits.every(hit => hit.content.includes('packagedneedle')));
  assert.equal(researchWorker.ranking.projectId, researchWorker.projectId);
  assert.equal(researchWorker.ranking.candidateLimit, 50);
  assert.deepEqual(researchWorker.hits, researchWorker.secondHits);
  assert.equal(researchWorker.ranking.inputHash, researchWorker.secondRanking.inputHash);
  const queriesCompletedAt = Date.now();
  const workerEvents = () => readFileSync(join(runRoot, 'data/plugin-data/logs/app.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(row => row.pluginId === '@roc/plugin-research' &&
      row.message === 'Research readonly query Worker lifecycle.')
    .map(row => ({ ...row.metadata, createdAt: row.createdAt }));
  const workerFile = await application.evaluate(({ app }) => {
    const { join } = process.getBuiltinModule('node:path');
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const { createHash } = process.getBuiltinModule('node:crypto');
    const path = join(app.getAppPath(), 'dist/main/research-query-worker.js');
    return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  const researchWorkerResult = {
    chunks: researchWorker.chunks, requests: researchWorker.requests, workersStarted: Number(!diagnosticRollback),
    hits: researchWorker.hits.length, keywordCount: researchWorker.keywordCount,
    rankingInputHash: researchWorker.ranking.inputHash,
    hitsSha256: createHash('sha256').update(JSON.stringify(researchWorker.hits)).digest('hex'),
    workerFile
  };

  const windowControls = await application.evaluate(({ BrowserWindow, nativeImage }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const { join } = process.getBuiltinModule('node:path');
    const icon = nativeImage.createFromPath(join(process.resourcesPath, 'trayTemplate.png'));
    const bitmap = icon.toBitmap();
    const visiblePixels = bitmap.filter((value, index) => index % 4 === 3 && value > 0).length;
    return {
      position: mainWindow.getWindowButtonPosition(),
      fullscreenable: mainWindow.isFullScreenable(),
      tray: { empty: icon.isEmpty(), template: icon.isTemplateImage(), size: icon.getSize() },
      trayVisiblePixels: visiblePixels,
      trayScales: icon.getScaleFactors()
    };
  });
  assert.deepEqual(windowControls.position, { x: 16, y: 19 });
  assert.equal(windowControls.fullscreenable, true);
  assert.deepEqual(windowControls.tray, { empty: false, template: true, size: { width: 16, height: 16 } });
  assert.ok(windowControls.trayVisiblePixels > 0 && windowControls.trayVisiblePixels < 256);
  assert.deepEqual(windowControls.trayScales, [1, 2]);
  // 渲染层不许自造窗口按钮：macOS 的交通灯由主进程的原生控件提供（P10 换掉旧壳的
  // `window-close` 断言——那个 testid 在新壳里根本不存在，所以「count 0」是空断言）。
  await expect(page.locator('[data-testid="window-close"], [data-testid="window-minimize"], [data-testid="window-zoom"]')).toHaveCount(0);

  const native = await application.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { join, sep } = process.getBuiltinModule('node:path');
    const fs = process.getBuiltinModule('node:fs');
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const appRoot = app.getAppPath();
    const require = createRequire(join(appRoot, 'package.json'));
    const sqlitePath = require.resolve('better-sqlite3');
    const ptyPath = require.resolve('node-pty');
    if (!sqlitePath.startsWith(`${appRoot}/`) || !ptyPath.startsWith(`${appRoot}/`)) {
      throw new Error('Native modules resolved outside the packaged app.');
    }
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    let sqlite;
    try {
      db.exec('CREATE TABLE probe (value INTEGER)');
      db.prepare('INSERT INTO probe VALUES (?)').run(42);
      sqlite = db.prepare('SELECT value FROM probe').get().value;
    } finally {
      db.close();
    }
    const sqliteVec = require('sqlite-vec');
    const vecDb = new Database(':memory:');
    let sqliteVecLoaded = false;
    try {
      const loadablePath = sqliteVec.getLoadablePath().replace(/\.dylib\.dylib$/u, '.dylib');
      const asarMarker = `${sep}app.asar${sep}`;
      const unpackedPath = loadablePath.includes(asarMarker)
        ? loadablePath.replace(asarMarker, `${sep}app.asar.unpacked${sep}`)
        : loadablePath;
      vecDb.loadExtension(fs.existsSync(unpackedPath) ? unpackedPath : loadablePath);
      vecDb.exec('CREATE VIRTUAL TABLE smoke_vec USING vec0(embedding float[2])');
      vecDb.prepare('INSERT INTO smoke_vec(rowid, embedding) VALUES (1, ?)').run(new Float32Array([1, 2]));
      sqliteVecLoaded = vecDb.prepare('SELECT count(*) AS count FROM smoke_vec').get().count === 1;
    } finally {
      vecDb.close();
    }
    const pty = require('node-pty');
    const terminal = pty.spawn('/bin/zsh', ['-f', '-c', 'printf ROC_MAC_PTY_OK'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: app.getPath('temp'), env: process.env
    });
    const terminalResult = await new Promise((resolvePromise, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        terminal.kill();
        reject(new Error('Packaged PTY timed out.'));
      }, 10000);
      terminal.onData((data) => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolvePromise({ exitCode, output });
      });
    });
    const rtkRoot = join(process.resourcesPath, 'rtk-binaries');
    const target = `darwin-${process.arch}`;
    const rtk = spawnSync(join(rtkRoot, target, 'rtk'), ['--version'], { encoding: 'utf8', timeout: 10000 });
    const toolchainRoot = join(process.resourcesPath, 'research-toolchain');
    const toolchainFiles = [
      'manifest.json',
      'bin/tectonic',
      'bin/vale',
      'bin/typst',
    'bin/pandoc',
      'typescript-experiment-runner.mts',
      'tex/bundle.zip',
      'licenses/README.md',
      'licenses/sources.json',
      'licenses/tectonic-MIT.txt',
      'licenses/vale-MIT.txt',
      'licenses/typst-APACHE.txt'
    ];
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    const ortNativeRoot = join(unpacked, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', process.arch);
    const ortNativeFiles = fs.readdirSync(ortNativeRoot).sort();
    return {
      packaged: app.isPackaged,
      appEntries: fs.readdirSync(appRoot).sort(),
      arch: process.arch,
      sqlite,
      sqliteVec: sqliteVecLoaded,
      terminal: terminalResult,
      rtk: { status: rtk.status, version: rtk.stdout.trim() },
      rtkTargets: fs.readdirSync(rtkRoot),
      researchToolchain: {
        missing: toolchainFiles.filter((file) => !fs.existsSync(join(toolchainRoot, file))),
        architecture: JSON.parse(fs.readFileSync(join(toolchainRoot, 'manifest.json'), 'utf8')).architecture,
        modelWeightsBundled: fs.existsSync(join(toolchainRoot, 'models')),
        pythonResourcesBundled: ['python', 'bin/uv', 'pyproject.toml', 'uv.lock', 'licenses/python-packages.json', 'licenses/uv-MIT.txt', 'licenses/uv-APACHE.txt']
          .filter((file) => fs.existsSync(join(toolchainRoot, file))),
        legacyParserBundled: fs.existsSync(join(toolchainRoot, 'worker.py')),
        legacyFigureBundled: fs.existsSync(join(toolchainRoot, 'figure.py'))
      },
      sqlitePrebuilds: fs.readdirSync(join(unpacked, 'better-sqlite3', 'prebuilds')),
      ptyPrebuilds: fs.readdirSync(join(unpacked, 'node-pty', 'prebuilds')),
      ortNativeFiles,
      ortBackends: require('onnxruntime-node').listSupportedBackends().filter(backend => backend.bundled).map(backend => backend.name),
      redundantPackages: ['react-dom', 'highlight.js', 'lucide-react', '@xterm/xterm', 'motion', 'tsx',
        '@radix-ui/react-dialog', '@tiptap/react', '@tiptap/pm', 'katex', 'mermaid', 'swr', 'zustand']
        .filter((name) => fs.existsSync(join(appRoot, 'node_modules', name)))
    };
  });
  assert.equal(native.packaged, true);
  assert.deepEqual(native.appEntries, ['dist', 'node_modules', 'package.json']);
  assert.equal(native.arch, process.arch);
  assert.equal(native.sqlite, 42);
  assert.equal(native.sqliteVec, true);
  assert.equal(native.terminal.exitCode, 0);
  assert.match(native.terminal.output, /ROC_MAC_PTY_OK/);
  assert.equal(native.rtk.status, 0);
  assert.deepEqual(native.rtkTargets, [`darwin-${native.arch}`]);
  assert.deepEqual(native.researchToolchain.missing, []);
  assert.equal(native.researchToolchain.architecture, native.arch);
  assert.equal(native.researchToolchain.modelWeightsBundled, false);
  assert.deepEqual(native.researchToolchain.pythonResourcesBundled, []);
  assert.equal(native.researchToolchain.legacyParserBundled, false);
  assert.equal(native.researchToolchain.legacyFigureBundled, false);
  assert.deepEqual(native.sqlitePrebuilds, [`darwin-${native.arch}.node`]);
  assert.deepEqual(native.ptyPrebuilds, [`darwin-${native.arch}`]);
  assert.deepEqual(native.ortNativeFiles, ['libonnxruntime.1.dylib', 'onnxruntime_binding.node']);
  assert.ok(native.ortBackends.includes('cpu'));
  assert.ok(native.ortBackends.includes('coreml'));
  assert.deepEqual(native.redundantPackages, []);

  const menuRoles = await application.evaluate(({ Menu }) => {
    const roles = [];
    const walk = (menu) => {
      for (const item of menu.items) {
        if (item.role) roles.push(item.role.toLowerCase());
        if (item.submenu) walk(item.submenu);
      }
    };
    const menu = Menu.getApplicationMenu();
    if (menu === null) throw new Error('macOS application menu is missing.');
    walk(menu);
    return roles;
  });
  for (const role of ['copy', 'paste', 'selectall', 'close', 'quit', 'minimize']) {
    assert.ok(menuRoles.includes(role), `Missing menu role: ${role}`);
  }

  const lifecycle = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const id = window.id;
    window.close();
    const hiddenAfterClose = !window.isDestroyed() && !window.isVisible();
    app.emit('activate');
    return {
      hiddenAfterClose,
      restoredAfterActivate: window.isVisible(),
      sameWindow: BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows()[0].id === id
    };
  });
  assert.deepEqual(lifecycle, { hiddenAfterClose: true, restoredAfterActivate: true, sameWindow: true });
  const afterReopen = await page.evaluate(() => window.roc.app.getStatus());
  assert.equal(afterReopen.ok, true, JSON.stringify(afterReopen));

  await page.screenshot({ path: join(artifactDir, 'main.png') });
  const browserWindow = await application.browserWindow(page);
  await browserWindow.evaluate((window) => window.setBounds({ width: 1280, height: 720 }));
  const layout = await page.evaluate(() => {
    const titlebar = document.querySelector('[data-testid="titlebar"]');
    const leading = titlebar?.firstElementChild;
    const primary = document.querySelector('[data-testid="titlebar-project-name"], [data-testid="titlebar-portal-title"]');
    if (!(titlebar instanceof HTMLElement) || !(leading instanceof HTMLElement) || !(primary instanceof HTMLElement)) {
      throw new Error('Missing titlebar layout.');
    }
    // 不要依赖「第一个子元素存在」：门户态里 `titlebar-toggle-sidebar` 不渲染，那个 div 可能只剩
    // 标题。`pl-[74px]` 是给原生交通灯留的位置（WindowChrome），所以直接量内边距。
    const paddingLeft = Number.parseFloat(getComputedStyle(leading).paddingLeft);
    return {
      nativeControlsSpace:
        titlebar.classList.contains('drag-region') && leading.getBoundingClientRect().left + paddingLeft >= 74,
      paddingLeft,
      primaryVisible: primary.getBoundingClientRect().width > 0,
      fontFamily: getComputedStyle(titlebar).fontFamily
    };
  });
  assert.equal(layout.nativeControlsSpace, true);
  assert.equal(layout.primaryVisible, true);
  assert.match(layout.fontFamily, /-apple-system/);
  await page.screenshot({ path: join(artifactDir, 'main-1280.png') });
  await application.evaluate(({ Menu }) => {
    const settings = Menu.getApplicationMenu()?.getMenuItemById('settings');
    if (settings === undefined) throw new Error('Settings menu is missing.');
    settings.click();
  });
  await expect(page.locator('[data-testid="settings-modal-panel"]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(artifactDir, 'settings.png') });
  const resources = await page.evaluate(() => ({
    fontsReady: document.fonts.status === 'loaded',
    stylesheetCount: document.styleSheets.length,
    missingImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src)
  }));
  assert.equal(resources.fontsReady, true);
  assert.ok(resources.stylesheetCount > 0);
  assert.deepEqual(resources.missingImages, []);
  assert.deepEqual(errors, []);

  // Plugin JSONL buffers records. Graceful shutdown flushes that destination;
  // waiting on the application log would observe the wrong file and boundary.
  const closeStartedAt = Date.now();
  await application.close();
  application = undefined;
  const events = workerEvents();
  const starts = events.filter(event => event.type === 'spawn');
  const exits = events.filter(event => event.type === 'exit');
  assert.equal(starts.length, Number(!diagnosticRollback), JSON.stringify(events));
  assert.equal(exits.length, Number(!diagnosticRollback), JSON.stringify(events));
  assert.equal(events.filter(event => event.type === 'cancel').length, 0, JSON.stringify(events));
  if (!diagnosticRollback) {
    assert.ok(Date.parse(starts[0].createdAt) <= queriesCompletedAt, JSON.stringify(events));
    assert.ok(Date.parse(exits[0].createdAt) >= closeStartedAt,
      `Packaged queries must finish in one live Worker without startup fallback: ${JSON.stringify(events)}`);
  }
  Object.assign(researchWorkerResult, { workersStopped: Number(!diagnosticRollback), shutdown: 'verified', events,
    diagnosticFlags: diagnosticRollback ? Object.fromEntries(diagnosticFlags.map(flag => [flag, '0'])) : {} });

  const result = { passed: true, checkedAt: new Date().toISOString(), appPath, rendererReadyMs, signature: 'verified', toolchainStatus: toolchainStatus.data, appearance: { accentColor: expectedAccent, notificationReceived: true }, native, workflow, bibtex, researchWorker: researchWorkerResult, windowControls, layout, lifecycle, resources, errors };
  writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = {
    passed: false,
    checkedAt: new Date().toISOString(),
    appPath,
    error: error instanceof Error ? error.message : String(error),
    errors
  };
  writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  throw error;
} finally {
  try {
    if (application !== undefined) await application.close();
  } finally {
    const appLogPath = join(runRoot, 'data/logs/app.jsonl');
    if (existsSync(appLogPath)) {
      writeFileSync(join(artifactDir, 'app.jsonl'), readFileSync(appLogPath));
    }
    const pluginLogPath = join(runRoot, 'data/plugin-data/logs/app.jsonl');
    if (existsSync(pluginLogPath)) {
      writeFileSync(join(artifactDir, 'plugin-app.jsonl'), readFileSync(pluginLogPath));
    }
    assert.ok(realpathSync(runRoot).startsWith(`${realpathSync(runtimeRoot)}/run-`));
    rmSync(runRoot, { recursive: true, force: true });
  }
}
