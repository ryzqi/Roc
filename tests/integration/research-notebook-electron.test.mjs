import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { waitForAppReady } from '../smoke/lib/assertions.mjs';

test('production file preview freezes untrusted notebook bytes through keyboard import and reads the original after restart',
  { timeout: 120000 }, async () => {
    const root = await realpath(await mkdtemp('/private/tmp/roc-notebook-electron-'));
    const workspace = join(root, 'workspace'), dataRoot = join(root, 'data');
    const output = resolve('.artifacts/research-optimization/xnb-a3-electron');
    for (const path of [workspace, dataRoot, output]) await mkdir(path, { recursive: true });
    const code = '# notebook source remains literal\nopen("EXECUTED", "w").write("unsafe")\n' + '# padding\n'.repeat(9000);
    const text = '<script>window.notebookExecuted=true</script><img src="https://untrusted.invalid/asset" onerror="window.notebookExecuted=true">';
    const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells: [
      { id: 'code-1', cell_type: 'code', metadata: { trusted: true }, source: code, execution_count: 42, outputs: [
        { output_type: 'display_data', data: { 'text/plain': text, 'text/html': text,
          'application/javascript': 'window.notebookExecuted=true', 'image/svg+xml': '<svg onload="window.notebookExecuted=true"/>' }, metadata: {} }
      ] },
      { id: 'markdown-1', cell_type: 'markdown', metadata: {}, source: '<iframe src="https://untrusted.invalid/frame"></iframe>',
        attachments: { 'evil.svg': { 'image/svg+xml': '<svg onload="window.notebookExecuted=true"/>' } } }
    ] };
    const bytes = Buffer.from(JSON.stringify(notebook, null, 2) + '\n');
    assert.ok(bytes.length > 65536);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(workspace, 'analysis.ipynb'), bytes);
    await writeFile(join(workspace, 'notes.txt'), 'original notes\n');
    let app;
    const errors = [], requests = [], audits = [];
    const auditSource = await readFile(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
    async function launch() {
      app = await electron.launch({ args: [resolve('dist/main/index.js')], env: {
        ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot
      } });
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('request', request => { if (request.url().startsWith('https://untrusted.invalid')) requests.push(request.url()); });
      await waitForAppReady(page, 'notebook-preview', output);
      return page;
    }
    async function open(page, projectId, path = 'analysis.ipynb') {
      const url = new URL(page.url()); url.searchParams.set('project', projectId);
      await page.goto(url.href);
      await page.getByTestId('workspace-layout').waitFor();
      await page.getByTestId('sidebar-tab-files').click();
      await page.getByTestId(`file-tree-row-${path}`).click();
      await page.getByTestId(path === 'analysis.ipynb' ? 'file-notebook-cells' : 'file-preview-text').waitFor();
    }
    try {
      const page = await launch();
      const project = await page.evaluate(async workspacePath => {
        const binding = await window.roc.workspace.select({ path: workspacePath });
        if (!binding.ok) throw new Error(JSON.stringify(binding.error));
        const result = await window.roc.research.createProject({ title: 'Notebook E2E', description: 'Literal notebook fixture', workspacePath });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      }, workspace);
      await open(page, project.id, 'notes.txt');
      assert.equal(await page.getByTestId('file-preview-text').innerText(), 'original notes\n');
      await page.getByTestId('file-preview-edit').click();
      await page.getByTestId('file-preview-editor').fill('updated notes\n');
      await page.getByTestId('file-preview-save').click();
      await page.getByTestId('file-preview-saved').waitFor();
      assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'updated notes\n');
      await page.keyboard.press('Escape');
      await page.getByTestId('file-preview-modal').waitFor({ state: 'detached' });
      await page.getByTestId('file-tree-row-analysis.ipynb').click();
      await page.getByTestId('file-notebook-cells').waitFor();
      assert.match(await page.getByTestId('file-notebook-source').first().innerText(), /open\("EXECUTED"/u);
      assert.match(await page.getByTestId('file-notebook-output').innerText(), /<script>/u);
      assert.equal(await page.locator('[data-testid="file-preview"] iframe,[data-testid="file-preview"] img,[data-testid="file-preview"] script').count(), 0);
      assert.equal(await page.evaluate(() => window.notebookExecuted), undefined);
      const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id);
      const button = page.getByTestId('file-notebook-import');
      await page.waitForFunction(() => !document.querySelector('[data-testid="file-notebook-import"]').disabled);
      await page.getByTestId('file-preview-modal-panel').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await button.evaluate(element => element === document.activeElement), true);
      assert.equal(await button.evaluate(element => element.matches(':focus-visible')), true);
      await page.keyboard.press('Enter');
      await page.getByTestId('file-notebook-frozen').waitFor();
      const imported = await page.evaluate(async projectId => {
        const list = await window.roc.research.listNotebooks({ projectId, offset: 0, limit: 20 });
        if (!list.ok) throw new Error(JSON.stringify(list.error));
        const receipt = list.data.items[0];
        const result = await window.roc.research.getNotebook({ projectId, notebookId: receipt.snapshot.id, expectedHash: receipt.snapshotHash });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      }, project.id);
      assert.equal(imported.preview.sha256, sha256);
      assert.equal(imported.preview.size, bytes.length);
      assert.equal(imported.preview.cells[0].sourceCharacters, code.length);
      assert.equal(imported.preview.cells[0].executionCount, 42);
      assert.deepEqual(imported.receipt.snapshot.actor, { kind: 'user', id: `window:${windowId}` });
      assert.equal('data' in imported.preview.cells[0].outputs[0], false);
      await writeFile(join(workspace, 'analysis.ipynb'), JSON.stringify({ ...notebook,
        cells: [{ ...notebook.cells[0], source: 'print("NEW SOURCE")\n', outputs: [] }] }));
      await page.getByRole('button', { name: '重新读取 Notebook', exact: true }).click();
      await page.getByTestId('file-notebook-source-changed').waitFor();
      assert.match(await page.getByTestId('file-notebook-source').first().innerText(), /open\("EXECUTED"/u);
      await page.getByTestId('file-notebook-history').locator('summary').click();
      await page.getByTestId('file-notebook-history-item').waitFor({ state: 'visible' });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await button.hover();
        const audit = await page.evaluate(`(${auditSource})({root:'[data-testid="file-preview-modal"]',viewport:true})`);
        audits.push({ theme, audit });
        await writeFile(join(output, 'clip-audit.json'), JSON.stringify(audits, null, 2));
        await page.screenshot({ path: join(output, `${theme}.png`) });
        assert.equal(audit.cut, 0, JSON.stringify(audit));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.keyboard.press('Escape');
      await page.getByTestId('file-preview-modal').waitFor({ state: 'detached' });
      await assert.rejects(readFile(join(workspace, 'EXECUTED')), { code: 'ENOENT' });
      await app.close(); app = undefined;
      const reopened = await launch();
      await open(reopened, project.id);
      await reopened.getByTestId('file-notebook-history').locator('summary').click();
      await reopened.getByTestId('file-notebook-history-item').click();
      await reopened.getByTestId('file-notebook-frozen').waitFor();
      await reopened.getByTestId('file-notebook-source-changed').waitFor();
      assert.match(await reopened.getByTestId('file-notebook-source').first().innerText(), /open\("EXECUTED"/u);
      const recovered = await reopened.evaluate(async reference => window.roc.research.getNotebook(reference), {
        projectId: project.id, notebookId: imported.receipt.snapshot.id, expectedHash: imported.receipt.snapshotHash
      });
      assert.equal(recovered.ok, true); assert.deepEqual(recovered.data, imported);
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
      await writeFile(join(output, 'receipt.json'), JSON.stringify({
        actualElectron: true, actualFileTreeUi: true, actualPreloadMain: true,
        sha256, windowId, imported, recovered, audits, errors, requests
      }, null, 2));
    } finally {
      if (app !== undefined) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
