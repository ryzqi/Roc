import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { waitForAppReady } from '../smoke/lib/assertions.mjs';

test('production UI automatically prepares Python without a picker or lock and preserves its receipt after restart',
  { timeout: 120000 }, async () => {
    const root = await realpath(await mkdtemp('/private/tmp/roc-python-electron-'));
    const workspace = join(root, 'workspace'), dataRoot = join(root, 'data'), venv = join(workspace, '.venv');
    const output = join(root, 'verification');
    const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
      'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], { encoding: 'utf8' }));
    assert.match(python.version, /^3\.14\.\d+$/u);
    for (const path of [workspace, dataRoot, join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages'), output]) await mkdir(path, { recursive: true });
    const executable = join(venv, 'bin/python3');
    await symlink(python.executable, executable);
    await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
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
        const workspace = await window.roc.workspace.select({ path: workspacePath });
        if (!workspace.ok) throw new Error(JSON.stringify(workspace.error));
        const result = await window.roc.research.createProject({ title: 'Python selection E2E', description: 'Synthetic environment selection', workspacePath });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      }, workspace);
      const projectUrl = new URL(page.url());
      projectUrl.searchParams.set('project', project.id);
      await page.goto(projectUrl.href);
      await page.getByTestId('workspace-layout').waitFor();
      await app.evaluate(({dialog}) => {
        globalThis.pythonPanelCalls = 0;
        dialog.showOpenDialog = async () => { globalThis.pythonPanelCalls++; throw new Error('unexpected_python_picker'); };
      });
      await page.getByTestId('activity-nav-runs').click();
      await page.getByTestId('canvas-task-category-python').click();
      await page.getByTestId('mgmt-python-environment-history').waitFor({timeout: 60000});
      assert.equal(await page.getByTestId('mgmt-python-environment-select').count(), 0);
      const selected = await page.evaluate(async projectId => {
        const result = await window.roc.research.listPythonEnvironmentSelections({ projectId });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data.at(-1);
      }, project.id);
      const request = selected.snapshot.request;
      await page.getByTestId('mgmt-python-environment-history').locator('summary').click();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.screenshot({ path: join(output, `${theme}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.equal(selected.snapshot.selectedExecutable, executable);
      assert.equal(selected.snapshot.prefix, venv);
      assert.equal(selected.snapshot.executable, python.executable);
      assert.deepEqual(selected.snapshot.actor, {kind: 'system', id: 'roc-python-environment'});
      assert.equal(await app.evaluate(() => globalThis.pythonPanelCalls), 0);
      const lock = JSON.parse(await readFile(join(workspace, 'roc-python.lock.json'), 'utf8'));
      assert.equal(lock.python.version, python.version); assert.deepEqual(lock.distributions, []);
      const refused = await page.evaluate(async request => window.roc.research.selectPythonEnvironment({ ...request, selectedExecutable: '/tmp/forged' }), request);
      assert.equal(refused.ok, false);
      const replay = await page.evaluate(async request => window.roc.research.selectPythonEnvironment(request), request);
      assert.equal(replay.ok, true); assert.deepEqual(replay.data, selected);
      assert.equal(await app.evaluate(() => globalThis.pythonPanelCalls), 0);
      await app.close(); app = undefined;
      const reopened = await launch();
      const result = await reopened.evaluate(async input => window.roc.research.getPythonEnvironmentSelection(input), {
        projectId: project.id, selectionId: selected.snapshot.id, expectedHash: selected.snapshotHash
      });
      assert.equal(result.ok, true); assert.deepEqual(result.data, selected);
      assert.deepEqual(errors, []);
    } finally {
      if (app !== undefined) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
