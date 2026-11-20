import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
const artifactDirectory = join(process.cwd(), '.artifacts/file-preview-dialog');
const clipSource = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
const receipts = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-file-preview-dialog-'));
  await mkdir(artifactDirectory, { recursive: true });
  await buildViteRenderer({ directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FileSidebarPanel} from './src/renderer/canvas/files/FileSidebarPanel';
    import {hasOpenDialog} from './src/renderer/shell/overlay-stack';
    import {requestNavigation} from './src/renderer/app/navigation-guard';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    const ok = data => ({ok: true, data});
    window.contents = 'Initial file contents';
    window.writes = [];
    window.navigationCalls = 0;
    window.leaveProject = () => requestNavigation({projectId: 'another-project'},
      () => {window.navigationCalls += 1;});
    window.hasOpenDialog = hasOpenDialog;
    const client = {api: {
      workspace: {onChanged: () => () => {}},
      files: {
        listTree: async () => ok({workspacePath: '/research', relativePath: '', truncated: false,
          entries: ['notes.md', 'other.md'].map(name => ({name, relativePath: name, type: 'file', size: 32,
            updatedAt: '2026-11-12T00:00:00.000Z'}))}),
        preview: async ({relativePath}) => ok({relativePath, kind: 'text', content: window.contents,
          sizeBytes: window.contents.length, truncated: Boolean(window.previewTruncated), mediaType: 'text/plain'}),
        writeText: async request => {
          window.writes.push(request);
          if (window.throwSave) throw new Error('Write service unavailable');
          if (window.deferSave) return await new Promise(resolve => {window.finishSave = resolve;});
          window.contents = request.content;
          return ok({relativePath: request.relativePath, recoveryPoint: {createdAt: '2026-11-12T00:00:00.000Z'}});
        }
      }
    }};
    function Harness() {
      const [openFile, setOpenFile] = useState(null);
      const [previewRequest, setPreviewRequest] = useState(null);
      window.askPreview = relativePath => setPreviewRequest({relativePath, nonce: Date.now()});
      return <main style={{display: 'flex', height: '100%'}}>
        <div style={{width: 240, height: '100%'}}>
          <FileSidebarPanel client={client} workspacePathKey="/research" projectId="preview-project"
            writable openFile={openFile} onOpenFile={setOpenFile}
            previewRequest={previewRequest} onPreviewRequestConsumed={() => setPreviewRequest(null)} />
        </div>
        <button data-testid="background-action">背景操作</button>
      </main>;
    }
    createRoot(document.getElementById('root')).render(
      <MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict><Harness /></LazyMotion></MotionConfig>
    );
  ` });
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 1100, height: 800});
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.getByTestId('file-tree-row-notes.md').waitFor();
});

after(async () => {
  await writeFile(join(artifactDirectory, 'clip-receipts.json'), JSON.stringify(receipts, null, 2));
  try { await app?.close(); } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
});

async function openPreview() {
  await page.getByTestId('file-tree-scroll').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.getByTestId('file-preview-text').waitFor();
}

async function closePreview() {
  if (await page.getByTestId('file-preview-unsaved-panel').count()) {
    await page.getByTestId('file-preview-unsaved-confirm').click();
  } else if (await page.getByTestId('file-preview-modal-panel').count()) {
    await page.getByTestId('file-preview-close').click();
    if (await page.getByTestId('file-preview-unsaved-panel').count()) {
      await page.getByTestId('file-preview-unsaved-confirm').click();
    }
  }
  await page.getByTestId('file-preview-modal-panel').waitFor({ state: 'detached' });
}

test('file preview traps Tab, suppresses background shortcuts and returns focus to the file tree', async () => {
  await openPreview();
  const panel = page.getByTestId('file-preview-modal-panel');
  try {
    assert.equal(await page.locator('#root').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => window.hasOpenDialog()), true);
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press(index % 2 ? 'Tab' : 'Shift+Tab');
      assert.equal(await panel.evaluate(element => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    await expect(page.getByTestId('file-tree-scroll')).toBeFocused();
    assert.equal(await page.locator('#root').getAttribute('aria-hidden'), null);
    assert.equal(await page.evaluate(() => window.hasOpenDialog()), false);
  } finally { await closePreview(); }
});

test('all file-preview close paths protect a dirty draft and nested cancellation restores editor focus', async () => {
  await openPreview();
  try {
    await page.getByTestId('file-preview-edit').click();
    const editor = page.getByTestId('file-preview-editor');
    await editor.fill('Unsaved research notes');
    await page.getByTestId('file-preview-modal-scrim').click({position: {x: 5, y: 5}});
    assert.equal(await page.getByTestId('file-preview-unsaved-panel').count(), 0);
    await expect(editor).toHaveValue('Unsaved research notes');
    await page.getByTestId('file-preview-close').click();
    const confirmation = page.getByTestId('file-preview-unsaved-panel');
    await expect(confirmation).toBeVisible();
    await expect(editor).toHaveValue('Unsaved research notes');
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'detached' });
    await expect(page.getByTestId('file-preview-close')).toBeFocused();
    await expect(editor).toHaveValue('Unsaved research notes');
    await editor.focus();
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeVisible();
    await page.getByTestId('file-preview-unsaved-cancel').click();
    await confirmation.waitFor({ state: 'detached' });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('Unsaved research notes');
    await page.keyboard.press('Escape');
    await page.getByTestId('file-preview-unsaved-confirm').click();
    await page.getByTestId('file-preview-modal-panel').waitFor({ state: 'detached' });
    await expect(page.getByTestId('file-tree-scroll')).toBeFocused();
  } finally { await closePreview(); }
});

test('preview requests and project navigation preserve dirty drafts until the user decides', async () => {
  await openPreview();
  try {
    await page.getByTestId('file-preview-edit').click();
    const editor = page.getByTestId('file-preview-editor');
    await editor.fill('Notes awaiting a decision');
    await page.evaluate(() => window.askPreview('other.md'));
    await expect(page.getByTestId('file-preview-unsaved-panel')).toBeVisible();
    await expect(editor).toHaveValue('Notes awaiting a decision');
    await page.getByTestId('file-preview-unsaved-cancel').click();
    await expect(editor).toHaveValue('Notes awaiting a decision');
    await page.evaluate(() => window.leaveProject());
    await expect(page.getByTestId('file-preview-unsaved-panel')).toBeVisible();
    assert.equal(await page.evaluate(() => window.navigationCalls), 0);
    await page.getByTestId('file-preview-unsaved-cancel').click();
    await expect(editor).toHaveValue('Notes awaiting a decision');
    await page.evaluate(() => window.askPreview('other.md'));
    await page.getByTestId('file-preview-unsaved-confirm').click();
    await page.getByTestId('file-preview-unsaved-panel').waitFor({state: 'detached'});
    await expect(page.getByTestId('file-preview-modal-panel')).toContainText('other.md');
    await expect(page.getByTestId('file-preview-editor')).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.writes), []);
  } finally { await closePreview(); }
});

test('inline file creation freezes its draft during writes and surfaces thrown failures for retry', async () => {
  await page.getByTestId('file-create-open').click();
  await page.getByTestId('file-create-name').fill('new.md');
  await page.evaluate(() => {window.deferSave = true; window.writes = [];});
  await page.getByTestId('file-create-submit').click();
  await expect(page.getByTestId('file-create-name')).toBeDisabled();
  await expect(page.getByTestId('file-create-cancel')).toBeDisabled();
  await expect(page.getByTestId('file-create-submit')).toBeDisabled();
  assert.equal(await page.evaluate(() => window.writes.length), 1);
  await page.evaluate(() => window.finishSave({ok: false, error: {message: 'Directory is read-only'}}));
  await expect(page.getByTestId('file-create-error')).toContainText('Directory is read-only');
  await expect(page.getByTestId('file-create-name')).toBeEnabled();
  await expect(page.getByTestId('file-create-name')).toHaveValue('new.md');
  await page.evaluate(() => {window.deferSave = false; window.throwSave = true;});
  await page.getByTestId('file-create-submit').click();
  await expect(page.getByTestId('file-create-error')).toContainText('Write service unavailable');
  await expect(page.getByTestId('file-create-submit')).toBeEnabled();
  await page.evaluate(() => {window.throwSave = false;});
  await page.getByTestId('file-create-cancel').click();
  await expect(page.getByTestId('file-create-form')).toHaveCount(0);
});

test('file save retains the submitted draft on failure and prevents editing or closing during the write', async () => {
  await openPreview();
  try {
    await page.getByTestId('file-preview-edit').click();
    const editor = page.getByTestId('file-preview-editor');
    await editor.fill('Draft to save');
    await page.evaluate(() => {window.deferSave = true; window.writes = [];});
    await page.getByTestId('file-preview-save').click();
    await expect(editor).toBeDisabled();
    await expect(page.getByTestId('file-preview-discard')).toBeDisabled();
    await expect(page.getByTestId('file-preview-close')).toBeDisabled();
    await page.getByTestId('file-preview-close').evaluate(element => element.click());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('file-preview-modal-panel')).toBeVisible();
    assert.equal(await page.getByTestId('file-preview-unsaved-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.writes.length), 1);
    await page.evaluate(() => window.finishSave({ok: false, error: {message: 'Disk is busy'}}));
    await expect(page.getByRole('alert')).toContainText('Disk is busy');
    await expect(editor).toBeEnabled();
    await expect(editor).toHaveValue('Draft to save');
    await page.evaluate(() => {window.deferSave = false;});
    await page.getByTestId('file-preview-save').click();
    await expect(page.getByTestId('file-preview-saved')).toBeVisible();
    await expect(page.getByTestId('file-preview-dirty')).toHaveCount(0);
  } finally {
    await page.evaluate(() => {window.deferSave = false;});
    await closePreview();
  }
});

test('file preview and dirty confirmation have complete shadows in both themes and short windows', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    for (const [width, height] of [[1100, 800], [800, 560]]) {
      await page.setViewportSize({ width, height });
      await openPreview();
      try {
        await page.getByTestId('file-preview-copy').hover();
        const previewResult = await page.evaluate(`(${clipSource})({viewport:true})`);
        receipts.push({theme, width, height, state: 'preview-hover', ...previewResult});
        assert.equal(previewResult.cut, 0, JSON.stringify(previewResult.issues));
        await page.getByTestId('file-preview-edit').click();
        await page.getByTestId('file-preview-editor').fill('A dirty draft');
        await page.getByTestId('file-preview-close').click();
        await page.getByTestId('file-preview-unsaved-panel').waitFor();
        const geometry = await page.getByTestId('file-preview-unsaved-panel').evaluate(element => {
          const rect = element.getBoundingClientRect();
          const gutter = parseFloat(getComputedStyle(element.parentElement).paddingTop);
          const spare = window.innerHeight - 2 * gutter - rect.height;
          return {actual: rect.top, expected: gutter + spare * 0.382};
        });
        assert.ok(Math.abs(geometry.actual - geometry.expected) < 1, JSON.stringify(geometry));
        const confirmationResult = await page.evaluate(`(${clipSource})({viewport:true})`);
        receipts.push({theme, width, height, state: 'dirty-confirmation', ...confirmationResult});
        assert.equal(confirmationResult.cut, 0, JSON.stringify(confirmationResult.issues));
        await page.screenshot({path: join(artifactDirectory, `${theme}-${width}x${height}-dirty.png`)});
      } finally { await closePreview(); }
    }
  }
});

test('a truncated file preview cannot overwrite the complete source with its visible prefix', async () => {
  await page.evaluate(() => {window.previewTruncated = true; window.writes = [];});
  await openPreview();
  try {
    await expect(page.getByTestId('file-preview-truncated')).toBeVisible();
    await expect(page.getByTestId('file-preview-edit')).toHaveCount(0);
    await expect(page.getByTestId('file-preview-truncated-readonly')).toContainText('无法编辑');
    assert.deepEqual(await page.evaluate(() => window.writes), []);
  } finally {
    await page.evaluate(() => {window.previewTruncated = false;});
    await closePreview();
  }
});
