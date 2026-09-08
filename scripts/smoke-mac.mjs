#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { projectRoot } from './lib/electron-version.mjs';

if (process.platform !== 'darwin') {
  throw new Error('smoke:mac requires macOS.');
}
const appPath = realpathSync(process.argv[2] === undefined
  ? join(projectRoot, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app')
  : resolve(process.argv[2]));
assert.equal(basename(appPath), 'Roc.app');
const executablePath = join(appPath, 'Contents', 'MacOS', 'Roc');
const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' });
assert.equal(signature.status, 0, signature.stderr || signature.error?.message);

const artifactDir = join(projectRoot, '.artifacts', 'mac-package');
const runtimeRoot = join(projectRoot, '.runtime', 'mac-smoke');
mkdirSync(artifactDir, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
const runRoot = mkdtempSync(join(runtimeRoot, 'run-'));
const workspaceRoot = join(runRoot, 'workspace');
mkdirSync(join(workspaceRoot, 'nested'), { recursive: true });
writeFileSync(join(workspaceRoot, 'nested', 'probe.txt'), 'ROC_FILE_PREVIEW_OK', 'utf8');
const errors = [];
const startedAt = performance.now();
let application;

try {
  const env = { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: join(runRoot, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(runRoot, 'chromium')}`],
    env,
    timeout: 30000
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.locator('[data-testid="roc-app"]').waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const rendererReadyMs = Math.round(performance.now() - startedAt);
  const status = await page.evaluate(() => window.roc.app.getStatus());
  assert.equal(status.ok, true, JSON.stringify(status));

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
    const shell = unwrap(await window.roc.shell.execute({ command: 'printf ROC_IPC_SHELL_OK', cwd: workspacePath, source: 'terminal' }));
    return { preview: preview.content, terminalShell: session.shell, terminal: 'ROC_IPC_PTY_OK', shell };
  }, workspaceRoot);
  assert.equal(workflow.preview, 'ROC_FILE_PREVIEW_OK');
  assert.equal(workflow.terminal, 'ROC_IPC_PTY_OK');
  assert.equal(workflow.shell.exitCode, 0);
  assert.equal(workflow.shell.stdout, 'ROC_IPC_SHELL_OK');

  const native = await application.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { join } = process.getBuiltinModule('node:path');
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
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    return {
      packaged: app.isPackaged,
      appEntries: fs.readdirSync(appRoot).sort(),
      arch: process.arch,
      sqlite,
      terminal: terminalResult,
      rtk: { status: rtk.status, version: rtk.stdout.trim() },
      rtkTargets: fs.readdirSync(rtkRoot),
      sqlitePrebuilds: fs.readdirSync(join(unpacked, 'better-sqlite3', 'prebuilds')),
      ptyPrebuilds: fs.readdirSync(join(unpacked, 'node-pty', 'prebuilds')),
      redundantPackages: ['react-dom', 'highlight.js', 'lucide-react', '@xterm/xterm', 'motion', '--frozen-lockfile']
        .filter((name) => fs.existsSync(join(appRoot, 'node_modules', name)))
    };
  });
  assert.equal(native.packaged, true);
  assert.deepEqual(native.appEntries, ['dist', 'node_modules', 'package.json']);
  assert.equal(native.arch, process.arch);
  assert.equal(native.sqlite, 42);
  assert.equal(native.terminal.exitCode, 0);
  assert.match(native.terminal.output, /ROC_MAC_PTY_OK/);
  assert.equal(native.rtk.status, 0);
  assert.deepEqual(native.rtkTargets, [`darwin-${native.arch}`]);
  assert.deepEqual(native.sqlitePrebuilds, [`darwin-${native.arch}.node`]);
  assert.deepEqual(native.ptyPrebuilds, [`darwin-${native.arch}`]);
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
  await application.evaluate(({ Menu }) => {
    const settings = Menu.getApplicationMenu()?.getMenuItemById('settings');
    if (settings === undefined) throw new Error('Settings menu is missing.');
    settings.click();
  });
  await expect(page.locator('[data-testid="settings-view"]')).toBeVisible();
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

  const result = { appPath, rendererReadyMs, signature: 'verified', native, workflow, lifecycle, resources, errors };
  writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    if (application !== undefined) await application.close();
  } finally {
    assert.ok(realpathSync(runRoot).startsWith(`${realpathSync(runtimeRoot)}/run-`));
    rmSync(runRoot, { recursive: true, force: true });
  }
}
