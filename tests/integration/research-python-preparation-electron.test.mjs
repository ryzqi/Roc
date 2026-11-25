import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, realpath, readFile, copyFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {_electron as electron, expect} from '@playwright/test';
import {waitForAppReady} from '../smoke/lib/assertions.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {ResearchPythonRuntimeStore} = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', {platform: 'node'});

test('production creation prepares managed Python; UI rechecks it, rejects path injection and preserves receipts after restart',
  {timeout: 240_000}, async () => {
    const root = await realpath(await mkdtemp('/private/tmp/roc-python-electron-'));
    const workspace = join(root, 'workspace'), dataRoot = join(root, 'data');
    const output = resolve('.artifacts/research-toolchain-p2/electron-preparation');
    for (const path of [workspace, dataRoot, output]) await mkdir(path, {recursive: true});
    const download = process.env.ROC_TEST_PYTHON_ARCHIVES ? async (url, hash, target, options) => {
      options.signal.throwIfAborted();
      const path = join(process.env.ROC_TEST_PYTHON_ARCHIVES, url.includes('/uv/') ? 'uv.tar.gz' : 'python.tar.gz');
      const bytes = await readFile(path);
      assert.equal(bytes.length, options.expectedSize); assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
      await copyFile(path, target); return target;
    } : undefined;
    let app;
    const errors = [];
    async function launch() {
      app = await electron.launch({args: [resolve('dist/main/index.js')], env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot}});
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
      await waitForAppReady(page, 'python-preparation', output);
      await app.evaluate(({dialog}) => {
        globalThis.pythonPanelCalls = 0;
        dialog.showOpenDialog = async () => {globalThis.pythonPanelCalls++; throw new Error('unexpected_python_picker');};
      });
      return page;
    }
    async function ready(page, projectId, operationId) {
      let status;
      await expect.poll(async () => {
        const result = await page.evaluate(projectId => window.roc.research.getPythonEnvironmentStatus({projectId}), projectId);
        assert.equal(result.ok, true, JSON.stringify(result)); status = result.data;
        if (operationId !== undefined && status.operation?.id !== operationId) return 'pending';
        return status.operation?.phase;
      }, {timeout: 90_000}).toMatch(/^(ready|failed|cancelled|interrupted)$/u);
      assert.equal(status.operation.phase, 'ready', JSON.stringify(status)); return status;
    }
    try {
      const runtime = await new ResearchPythonRuntimeStore(join(dataRoot, 'research-python'), undefined, download)
        .prepare('3.14.10', 'electron-prewarm', new AbortController().signal);
      const page = await launch();
      const project = await page.evaluate(async workspacePath => {
        const workspace = await window.roc.workspace.select({path: workspacePath});
        if (!workspace.ok) throw new Error(JSON.stringify(workspace.error));
        const result = await window.roc.research.createProject({title: 'Python preparation E2E', description: 'Managed environment preparation', workspacePath});
        if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
      }, workspace);
      const initial = await ready(page, project.id);
      assert.deepEqual(initial.environment.snapshot.actor, {kind: 'system', id: 'roc-python-environment'});
      assert.equal(initial.environment.snapshot.executable, runtime.executable);
      assert.equal(initial.environment.snapshot.prefix, join(workspace, '.venv'));
      assert.deepEqual(initial.environment.snapshot.lockFiles.map(file => file.path), ['pyproject.toml', 'uv.lock', '.python-version']);
      assert.equal((await readFile(join(workspace, '.python-version'), 'utf8')).trim(), '3.14.10');
      const projectUrl = new URL(page.url()); projectUrl.searchParams.set('project', project.id); await page.goto(projectUrl.href);
      await page.getByTestId('workspace-layout').waitFor();
      await page.getByTestId('activity-nav-runs').click(); await page.getByTestId('canvas-task-category-python').click();
      await page.getByTestId('mgmt-python-environment-history').waitFor();
      const button = page.getByTestId('mgmt-python-prepare'); await button.focus(); await page.keyboard.press('Enter');
      await expect.poll(async () => {
        const result = await page.evaluate(projectId => window.roc.research.getPythonEnvironmentStatus({projectId}), project.id);
        return result.ok ? result.data.operation?.id : initial.operation.id;
      }, {timeout: 10_000}).not.toBe(initial.operation.id);
      const state = await ready(page, project.id), selected = state.environment;
      assert.equal(selected.snapshot.actor.kind, 'user');
      assert.equal(selected.snapshot.metadataHash, initial.environment.snapshot.metadataHash);
      await expect(page.getByTestId('mgmt-python-status')).toHaveText('环境已就绪');
      await page.emulateMedia({reducedMotion: 'reduce'});
      await page.getByTestId('mgmt-python-environment-history').locator('summary').click();
      await expect(page.getByTestId('mgmt-python-environment-history').locator('li')).toHaveCount(2);
      await expect(page.getByTestId('mgmt-python-environment-history').locator('li').first()).toContainText(selected.snapshot.selectedExecutable);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.screenshot({path: join(output, `${theme}.png`)});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      const request = selected.snapshot.request;
      const refused = await page.evaluate(request => window.roc.research.preparePythonEnvironment({...request, selectedExecutable: '/tmp/forged'}), request);
      assert.equal(refused.ok, false);
      const replay = await page.evaluate(request => window.roc.research.preparePythonEnvironment(request), request);
      assert.equal(replay.ok, true); assert.deepEqual(replay.data, state.operation);
      assert.equal(await app.evaluate(() => globalThis.pythonPanelCalls), 0);
      await app.close(); app = undefined;
      const reopened = await launch();
      const result = await reopened.evaluate(input => window.roc.research.getPythonEnvironment(input), {
        projectId: project.id, environmentId: selected.snapshot.id, expectedHash: selected.snapshotHash
      });
      assert.equal(result.ok, true); assert.deepEqual(result.data, selected);
      const persisted = await reopened.evaluate(projectId => window.roc.research.getPythonEnvironmentStatus({projectId}), project.id);
      assert.equal(persisted.ok, true); assert.deepEqual(persisted.data, state);
      assert.equal(await app.evaluate(() => globalThis.pythonPanelCalls), 0); assert.deepEqual(errors, []);
    } finally {
      if (app !== undefined) await app.close();
      await rm(root, {recursive: true, force: true});
    }
  });
