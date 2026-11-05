import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { waitForAppReady } from '../smoke/lib/assertions.mjs';

test('production Electron preload binds the true window to native selection, preserves venv alias, and reads the persisted receipt after restart',
  { timeout: 120000 }, async () => {
    const root = await realpath(await mkdtemp('/private/tmp/roc-python-electron-'));
    const workspace = join(root, 'workspace'), dataRoot = join(root, 'data'), venv = join(root, 'venv');
    const output = resolve('.artifacts/research-optimization/pr08-a3-electron');
    const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
      'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
    assert.match(python.version, /^3\.14\.\d+$/u);
    for (const path of [workspace, dataRoot, join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages'), output]) await mkdir(path, { recursive: true });
    const executable = join(venv, 'bin/python3');
    await symlink(python.executable, executable);
    await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
    await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify({
      schemaVersion: 1, python: { implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64' }, distributions: []
    }));
    let app;
    const errors = [];
    async function launch() {
      app = await electron.launch({ args: [resolve('dist/main/index.js')], env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot } });
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await waitForAppReady(page, 'python-selection', output);
      return page;
    }
    try {
      const page = await launch();
      const project = await page.evaluate(async workspacePath => {
        const result = await window.roc.research.createProject({ title: 'Python selection E2E', description: 'Synthetic environment selection', workspacePath });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      }, workspace);
      const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id);
      await app.evaluate(({ dialog }, executable) => {
        globalThis.pythonPanelCalls = [];
        dialog.showOpenDialog = async (parent, options) => {
          globalThis.pythonPanelCalls.push({ windowId: parent.webContents.id, options });
          return { canceled: false, filePaths: [executable] };
        };
      }, executable);
      const request = { projectId: project.id, requestId: 'native-selection-e2e' };
      const selected = await page.evaluate(async request => {
        const result = await window.roc.research.selectPythonEnvironment(request);
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      }, request);
      assert.equal(selected.snapshot.selectedExecutable, executable);
      assert.equal(selected.snapshot.prefix, venv);
      assert.equal(selected.snapshot.executable, python.executable);
      assert.deepEqual(selected.snapshot.actor, { kind: 'user', id: `window:${windowId}` });
      const calls = await app.evaluate(() => globalThis.pythonPanelCalls);
      assert.equal(calls.length, 1); assert.equal(calls[0].windowId, windowId);
      assert.deepEqual(calls[0].options.properties, ['openFile', 'noResolveAliases', 'showHiddenFiles']);
      const refused = await page.evaluate(async request => window.roc.research.selectPythonEnvironment({ ...request, selectedExecutable: '/tmp/forged' }), request);
      assert.equal(refused.ok, false);
      assert.equal((await app.evaluate(() => globalThis.pythonPanelCalls)).length, 1);
      const replay = await page.evaluate(async request => window.roc.research.selectPythonEnvironment(request), request);
      assert.equal(replay.ok, true); assert.deepEqual(replay.data, selected);
      assert.equal((await app.evaluate(() => globalThis.pythonPanelCalls)).length, 1);
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      const cancelled = await page.evaluate(async request => window.roc.research.selectPythonEnvironment(request), { ...request, requestId: 'cancel-panel-e2e' });
      assert.equal(cancelled.ok, true); assert.equal(cancelled.data, null);
      await app.close(); app = undefined;
      const reopened = await launch();
      const result = await reopened.evaluate(async input => window.roc.research.getPythonEnvironmentSelection(input), {
        projectId: project.id, selectionId: selected.snapshot.id, expectedHash: selected.snapshotHash
      });
      assert.equal(result.ok, true); assert.deepEqual(result.data, selected);
      assert.deepEqual(errors, []);
      await writeFile(join(output, 'receipt.json'), JSON.stringify({
        actualElectron: true, actualPythonProbe: true, nativePanelStubbed: true, windowId, calls, selected, cancelled, reopened: result
      }, null, 2));
    } finally {
      if (app !== undefined) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
