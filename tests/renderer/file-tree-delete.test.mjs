import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, workspace, artifactDirectory, app, page;
const errors = [];
const receipts = [];
const clipSource = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-file-tree-delete-'));
  workspace = join(directory, 'workspace');
  artifactDirectory = process.env.ROC_UI_AUDIT_DIR ?? join(directory, 'screenshots');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(workspace, 'notes.md'), 'Research notes to preserve in the recovery snapshot.');
  await writeFile(join(workspace, 'nested', 'result.txt'), 'Nested result');
  await build({ stdin: { contents: `
    export {FileService} from './src/main/services/file-service';
    export {WorkspaceService} from './src/main/services/workspace-service';
    export {executeIpcRequest} from './src/main/ipc/ipc-common';
    export {pluginCapabilityMappings} from './src/shared/ipc-generated';
    export {bindNativeContextMenu} from './src/main/native-context-menu';
  `, resolveDir: process.cwd() }, outfile: join(directory, 'services.cjs'), bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await buildViteRenderer({ directory, style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {FileSidebarPanel} from './src/renderer/canvas/files/FileSidebarPanel';
    import {WindowChrome} from './src/renderer/shell/WindowChrome';
    const client = {api: window.roc};
    const workspace = ${JSON.stringify(workspace)};
    window.deleted = [];
    window.gitOpened = 0;
    function Harness({writable}) {
      const [selected, setSelected] = useState('notes.md');
      window.selected = selected;
      return <main style={{display:'flex',flexDirection:'column',height:'100%'}}>
        <WindowChrome projectName="文件删除验证" projectId="delete-test" projects={[]}
          onOpenProject={()=>{}} onBackToPortal={()=>{}} onOpenSearch={()=>{}}
          sidebarCollapsed={false} onToggleSidebar={()=>{}} assistantOpen={false}
          onToggleAssistant={()=>{}} assistantRunning={false} onOpenGit={()=>window.gitOpened++}
          onOpenManagement={()=>{}} branchLabel="main" gitChangeCount={2}
          layoutPreset="research" onChangePreset={()=>{}} />
        <div style={{width:260,flex:1,minHeight:0}}>
          <FileSidebarPanel client={client} workspacePathKey={workspace} projectId="delete-test"
            writable={writable} openFile={selected} onOpenFile={setSelected}
            onFileDeleted={path=>{window.deleted.push(path);setSelected(null);}} />
        </div>
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    let key = 0;
    window.mount = (writable = true) => flushSync(() => root.render(
      <MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <Harness key={++key} writable={writable} />
      </LazyMotion></MotionConfig>
    ));
    window.mount();
  ` });
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow, ipcMain} = require('electron');
    const {FileService, WorkspaceService, executeIpcRequest, pluginCapabilityMappings, bindNativeContextMenu} = require('./services.cjs');
    const workspacePath = ${JSON.stringify(workspace)};
    const workspace = Object.create(WorkspaceService.prototype);
    workspace.requireWorkspace = () => ({path: workspacePath, id: 'delete-test'});
    global.deleteCalls = [];
    global.snapshots = [];
    const service = new FileService({tasksDir: ${JSON.stringify(join(directory, 'tasks'))}},
      {db: {prepare: () => ({run: (...args) => global.snapshots.push(args)})}}, workspace);
    const handlers = {
      'files.listTree': request => service.listTree(request),
      'files.preview': request => service.readPreview(request),
      'files.delete': async request => {
        global.deleteCalls.push(request);
        if (global.failDelete) throw new Error('Simulated delete failure');
        if (global.deferDelete) await new Promise(resolve => {global.finishDelete = resolve;});
        return service.deleteFile(request.relativePath);
      }
    };
    for (const mapping of pluginCapabilityMappings) {
      if (!handlers[mapping.capabilityName]) continue;
      ipcMain.handle(mapping.channel, (event, ...args) => executeIpcRequest(mapping.channel, event, args,
        async (_event, request) => ({ok: true, data: await handlers[mapping.capabilityName](request)})));
    }
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 1100, height: 800,
        webPreferences: {preload: ${JSON.stringify(resolve('dist/preload/index.cjs'))}, contextIsolation: true}});
      bindNativeContextMenu(window.webContents);
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('file-tree-row-notes.md').waitFor();
});

after(async () => {
  if (artifactDirectory) await writeFile(join(artifactDirectory, 'file-delete-clip-receipts.json'), JSON.stringify(receipts, null, 2));
  try { await app?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});

test('context click opens confirmation without preview or deletion; cancel restores tree focus', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByTestId('file-tree-row-notes.md').click({ button: 'right' });
    await expect(page.getByTestId('file-delete-confirm-panel')).toBeVisible();
    await expect(page.getByTestId('file-delete-confirm-message')).toContainText('notes.md');
    await expect(page.getByTestId('file-delete-confirm-cancel')).toBeFocused();
    assert.equal(await page.getByTestId('file-preview-modal-panel').count(), 0);
    assert.deepEqual(await app.evaluate(() => global.deleteCalls), []);
    const audit = await page.evaluate(source => new Function('return (' + source + ')')()({viewport: true}), clipSource);
    receipts.push({theme, audit});
    assert.equal(audit.cut, 0);
    await page.screenshot({ path: join(artifactDirectory, 'file-delete-' + theme + '.png') });
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('file-delete-confirm-confirm')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('file-delete-confirm-panel')).toHaveCount(0);
    await expect(page.getByTestId('file-tree-scroll')).toBeFocused();
  }
});

test('keyboard deletion reports failure, blocks repeat submission, saves recovery and refreshes tree', async () => {
  await app.evaluate(() => { global.failDelete = true; });
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('file-delete-confirm-confirm').click();
  await expect(page.getByRole('alert')).toContainText('Roc 内部错误，已记录到本地日志。');
  await access(join(workspace, 'notes.md'));
  await app.evaluate(() => { global.failDelete = false; global.deferDelete = true; });
  await page.getByTestId('file-delete-confirm-confirm').click();
  await expect(page.getByTestId('file-delete-confirm-confirm')).toBeDisabled();
  await expect(page.getByTestId('file-delete-confirm-cancel')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-delete-confirm-panel')).toBeVisible();
  await expect.poll(() => app.evaluate(() => typeof global.finishDelete)).toBe('function');
  await app.evaluate(() => { global.deferDelete = false; global.finishDelete(); });
  await expect(page.getByTestId('file-delete-confirm-panel')).toHaveCount(0);
  await expect(page.getByTestId('file-tree-row-notes.md')).toHaveCount(0);
  await assert.rejects(access(join(workspace, 'notes.md')), {code: 'ENOENT'});
  const snapshots = await app.evaluate(() => global.snapshots);
  assert.equal(snapshots.length, 1);
  assert.equal(await readFile(snapshots[0][2], 'utf8'), 'Research notes to preserve in the recovery snapshot.');
  assert.deepEqual(await page.evaluate(() => ({deleted: window.deleted, selected: window.selected})),
    {deleted: ['notes.md'], selected: null});
  assert.equal((await app.evaluate(() => global.deleteCalls)).length, 2);
});

test('nested file deletes refresh expanded directories; read-only files and directories have no deletion action', async () => {
  await page.evaluate(() => window.mount(false));
  await page.getByTestId('file-tree-row-nested').click();
  await page.getByTestId('file-tree-row-nested/result.txt').click({button: 'right'});
  await expect(page.getByTestId('file-delete-confirm-panel')).toHaveCount(0);
  await page.getByTestId('file-tree-scroll').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.getByTestId('file-delete-confirm-panel')).toHaveCount(0);
  await page.evaluate(() => window.mount());
  await page.getByTestId('file-tree-row-nested').click({button: 'right'});
  await expect(page.getByTestId('file-delete-confirm-panel')).toHaveCount(0);
  await page.getByTestId('file-tree-row-nested/result.txt').click({button: 'right'});
  await expect(page.getByTestId('file-delete-confirm-message')).toContainText('nested/result.txt');
  await page.getByTestId('file-delete-confirm-confirm').click();
  await expect(page.getByTestId('file-tree-row-nested/result.txt')).toHaveCount(0);
  await expect(page.getByTestId('file-tree-row-nested')).toBeVisible();
  await assert.rejects(access(join(workspace, 'nested', 'result.txt')), {code: 'ENOENT'});
});

test('Git button stays borderless, keyboard accessible and functional in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const button = page.getByTestId('titlebar-git');
    await button.focus();
    assert.equal(await button.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    await page.keyboard.press('Enter');
    await button.hover();
    await page.screenshot({path: join(artifactDirectory, 'git-borderless-' + theme + '.png')});
  }
  assert.equal(await page.evaluate(() => window.gitOpened), 2);
});
