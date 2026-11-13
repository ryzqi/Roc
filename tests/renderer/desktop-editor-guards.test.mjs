import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-desktop-editor-guards-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {ImportDialog} from './src/renderer/literature/ImportDialog';
    import {MemorySection} from './src/renderer/management/sections/MemorySection';
    import {useMemoryFiles} from './src/renderer/management/use-memory';
    import {MEMORY_SLOTS} from './src/renderer/management/memory-model';
    import {BEFORE_NAVIGATE, requestNavigation} from './src/renderer/app/navigation-guard';
    const ok = data => ({ok: true, data});
    const meta = slot => ({scope: slot.scope, kind: slot.kind, exists: true, effective: true,
      charCount: 5, charLimit: 20000, absolutePath: slot.virtualPath, updatedAt: null});
    const client = {api: {
      memory: {
        status: async () => ok({root: '/memory', workspaceHash: 'workspace-a', workspaceLabel: 'Project A',
          files: MEMORY_SLOTS.map(meta), autoMemory: {recent: []}, snapshot: {enabled: true, totalChars: 5, totalLimit: 20000},
          sessionMessages: {totalRows: 0, retentionDays: 30, oldestAt: null}, fullTextIndex: {healthy: true}}),
        readFile: async () => ok('Saved'),
        writeFile: request => {window.writes.push(request); return new Promise(resolve => {window.finishWrite = resolve;});}
      },
      sessions: {search: request => {
        if (window.throwSessionQuery) throw new Error('Session bridge disconnected');
        window.sessionQueries.push(request);
        return new Promise(resolve => {window.finishSessionQuery = resolve;});
      }}
    }};
    function ImportHarness() {
      const [open, setOpen] = useState(true);
      window.setImportOpen = value => flushSync(() => setOpen(value));
      const imported = request => {
        window.imports.push(request);
        if (window.throwImport) throw new Error('Import bridge disconnected');
        return new Promise(resolve => {window.finishImport = resolve;});
      };
      return <ImportDialog open={open} onClose={() => setOpen(false)} initialTab="doi"
        client={client} projectId="project-a" selectedItem={null} canAttachToSelection={false} onZoteroImported={() => {}}
        importDoi={doi => imported({doi})} importBibliographyFile={(path, format) => imported({path, format})}
        importRecord={record => imported({record})} addDocumentToNewItem={imported} addDocumentToItem={imported}
        addCandidate={(searchId, candidateId) => imported({searchId, candidateId})}
        pickFile={() => {
          window.picks++;
          if (window.throwPick) throw new Error('Native file dialog unavailable');
          return new Promise(resolve => {window.finishPick = resolve;});
        }}
        searchLiterature={(query, sources, limit) => {
          window.searches.push({query, sources, limit});
          if (window.throwSearch) throw new Error('Literature search disconnected');
          return new Promise(resolve => {window.finishSearch = resolve;});
        }} />;
    }
    function MemoryHarness() {
      const store = useMemoryFiles(client);
      window.memoryStore = store;
      return <MemorySection store={store} scope={{client, onAskAssistant: () => {}, onOpenThread: () => {}}} />;
    }
    const root = createRoot(document.getElementById('root'));
    let instance = 0;
    window.mount = mode => {
      window.imports = []; window.picks = 0; window.searches = []; window.writes = []; window.sessionQueries = [];
      window.throwImport = false; window.throwPick = false; window.throwSearch = false; window.navigations = 0;
      window.throwSessionQuery = false;
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <main key={++instance} style={{padding: 40, height: '100%', boxSizing: 'border-box'}}>
          {mode === 'memory' ? <MemoryHarness /> : <ImportHarness />}
        </main>
      </LazyMotion></MotionConfig>));
    };
    window.navigate = () => requestNavigation({page: 'home'}, () => {window.navigations++;});
    window.blockNavigation = enabled => {
      window.navigationBlocker ??= event => event.preventDefault();
      if (enabled) window.addEventListener(BEFORE_NAVIGATE, window.navigationBlocker);
      else window.removeEventListener(BEFORE_NAVIGATE, window.navigationBlocker);
    };
    window.mount('import');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1100, height: 800})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('literature-import-doi').waitFor();
});
after(async () => {
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, [], 'editor operations must surface errors in the UI');
});

test('import drafts require a deliberate discard for Escape, close and project navigation', async () => {
  await page.evaluate(() => window.mount('import'));
  const input = page.getByTestId('literature-import-doi');
  await input.fill('10.1234/retained');
  await input.press('Escape');
  await expect(page.getByTestId('literature-import-discard')).toBeVisible();
  await page.getByTestId('literature-import-discard-cancel').click();
  await page.getByTestId('literature-import-discard').waitFor({state: 'hidden'});
  await expect(input).toHaveValue('10.1234/retained');
  await page.evaluate(() => window.navigate());
  await expect(page.getByTestId('literature-import-discard')).toBeVisible();
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await page.getByTestId('literature-import-discard-cancel').click();
  await page.getByTestId('literature-import-discard').waitFor({state: 'hidden'});
  await page.getByTestId('literature-import-dialog-close').click();
  await page.getByTestId('literature-import-discard-confirm').click();
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  await page.evaluate(() => window.setImportOpen(true));
  await expect(input).toHaveValue('');
  await input.fill('10.1234/navigate');
  await page.evaluate(() => window.navigate());
  await page.getByTestId('literature-import-discard-confirm').click();
  await page.waitForFunction(() => window.navigations === 1);
});

test('local imports freeze their submitted fields, reject repeat clicks and retain failed drafts', async () => {
  await page.evaluate(() => window.mount('import'));
  const input = page.getByTestId('literature-import-doi');
  const submit = page.getByTestId('literature-import-doi-submit');
  await input.fill('10.1234/snapshot');
  await submit.evaluate(button => {button.click(); button.click();});
  assert.equal(await page.evaluate(() => window.imports.length), 1);
  await expect(input).toBeDisabled();
  await expect(page.getByTestId('literature-import-tab-manual')).toBeDisabled();
  await page.getByTestId('literature-import-dialog-close').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('literature-import-dialog')).toBeVisible();
  await page.evaluate(() => window.finishImport({ok: false, message: 'Import refused'}));
  await expect(page.getByTestId('literature-import-message')).toContainText('Import refused');
  await expect(input).toHaveValue('10.1234/snapshot');
  await page.evaluate(() => {window.throwImport = true;});
  await submit.click();
  await expect(page.getByTestId('literature-import-message')).toContainText('Import bridge disconnected');
  await page.evaluate(() => {window.throwImport = false;});
  await submit.click();
  await page.evaluate(() => window.finishImport({ok: true, createdCount: 1, duplicateCount: 0}));
  await expect(page.getByTestId('literature-import-message')).toContainText('已导入 1 条');
  await page.getByTestId('literature-import-dialog-close').click();
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  assert.equal(await page.getByTestId('literature-import-discard').count(), 0);
});

test('native import picking reports failures and ignores paths from a closed dialog session', async () => {
  await page.evaluate(() => window.mount('import'));
  await page.getByTestId('literature-import-tab-document').click();
  await page.getByTestId('literature-import-pick-document').click();
  await expect(page.getByTestId('literature-import-tab-doi')).toBeDisabled();
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  await page.evaluate(() => {window.setImportOpen(true); window.finishPick('/old-session.pdf');});
  await page.getByTestId('literature-import-tab-document').click();
  await expect(page.getByTestId('literature-import-document-path')).toHaveText('未选择');
  await page.evaluate(() => {window.throwPick = true;});
  await page.getByTestId('literature-import-pick-document').click();
  await expect(page.getByTestId('literature-import-message')).toContainText('Native file dialog unavailable');
  await expect(page.getByTestId('literature-import-pick-document')).toBeEnabled();
});

test('literature queries expose search state and discard responses from previous open sessions', async () => {
  await page.evaluate(() => window.mount('import'));
  await page.getByTestId('literature-import-tab-search').click();
  await page.getByTestId('literature-import-search').fill('retained query');
  await page.getByTestId('literature-import-search-submit').click();
  await expect(page.getByTestId('literature-import-pending')).toContainText('正在检索');
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  await page.evaluate(() => {
    window.setImportOpen(true);
    window.finishSearch({ok: true, result: {candidates: [], status: 'completed', searchId: 'old', total: 88, warnings: []}});
  });
  await page.getByTestId('literature-import-tab-search').click();
  assert.equal(await page.getByText('找到 88 篇候选', {exact: false}).count(), 0);
  await page.getByTestId('literature-import-search').fill('new query');
  await page.evaluate(() => {window.throwSearch = true;});
  await page.getByTestId('literature-import-search-submit').click();
  await expect(page.getByTestId('literature-import-panel-search').getByRole('alert')).toContainText('Literature search disconnected');
  await expect(page.getByTestId('literature-import-search-submit')).toBeEnabled();
});

test('memory editor saves respect IME confirmation and preserve refused writes for retry', async () => {
  await page.evaluate(() => window.mount('memory'));
  await page.getByTestId('mgmt-memory-edit').click();
  const textarea = page.getByTestId('mgmt-memory-textarea');
  await textarea.fill('新的研究记忆');
  await textarea.evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', metaKey: true, isComposing: true, bubbles: true, cancelable: true}));
    input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', metaKey: true, bubbles: true, cancelable: true}));
  });
  assert.equal(await page.evaluate(() => window.writes.length), 0);
  await textarea.press('Meta+Enter');
  await expect(textarea).toBeDisabled();
  await page.evaluate(() => window.finishWrite({ok: true, data: {ok: false, reason: 'capacity_exceeded', detail: 'Capacity refused', chars: 21000, limit: 20000}}));
  await expect(page.getByTestId('mgmt-memory-outcome')).toContainText('未保存');
  await expect(textarea).toHaveValue('新的研究记忆');
  await page.getByTestId('mgmt-memory-save').click();
  await page.evaluate(() => window.finishWrite({ok: true, data: {ok: true, meta: {}}}));
  await expect(page.getByTestId('mgmt-memory-reading')).toContainText('新的研究记忆');
});

test('shared memory surfaces issue one write while a save is in flight', async () => {
  await page.evaluate(() => window.mount('memory'));
  await page.getByTestId('mgmt-memory-edit').click();
  await page.getByTestId('mgmt-memory-textarea').fill('Shared draft');
  await page.evaluate(() => {
    window.firstSave = window.memoryStore.save.run();
    window.secondSave = window.memoryStore.save.run();
  });
  assert.equal(await page.evaluate(() => window.writes.length), 1);
  await page.evaluate(() => window.finishWrite({ok: false, error: {message: 'Write failed'}}));
  await expect(page.getByTestId('mgmt-memory-save-error')).toContainText('Write failed');
  assert.equal(await page.evaluate(() => window.memoryStore.dirtyCount), 1);
  assert.deepEqual(await page.evaluate(async () => [await window.firstSave, await window.secondSave]), [false, false]);
});

test('memory session searches invalidate old results when the visible query changes', async () => {
  await page.evaluate(() => window.mount('memory'));
  await page.getByTestId('mgmt-memory-search-toggle').click();
  const input = page.getByTestId('mgmt-memory-search-input');
  await input.fill('old query');
  await page.getByTestId('mgmt-memory-search-run').click();
  await input.fill('new query');
  await page.evaluate(() => window.finishSessionQuery({ok: true, data: {items: [{id: 'old-hit', threadId: 'old-thread', threadTitle: 'Old result',
    createdAt: 0, snippet: 'Old query result'}]}}));
  assert.equal(await page.getByTestId('mgmt-memory-search-open-old-hit').count(), 0);
  await expect(page.getByTestId('mgmt-memory-search-run')).toBeEnabled();
  await page.getByTestId('mgmt-memory-search-run').click();
  await page.evaluate(() => window.finishSessionQuery({ok: false, error: {message: 'Session index unavailable'}}));
  await expect(page.getByTestId('mgmt-memory-search-error')).toContainText('Session index unavailable');
});

test('session search catches a synchronous bridge failure and permits retry', async () => {
  await page.evaluate(() => window.mount('memory'));
  await page.getByTestId('mgmt-memory-search-toggle').click();
  await page.getByTestId('mgmt-memory-search-input').fill('retry query');
  await page.evaluate(() => {window.throwSessionQuery = true;});
  await page.getByTestId('mgmt-memory-search-run').click();
  await expect(page.getByTestId('mgmt-memory-search-error')).toContainText('Session bridge disconnected');
  await page.evaluate(() => {window.throwSessionQuery = false;});
  await page.getByTestId('mgmt-memory-search-run').click();
  await page.evaluate(() => window.finishSessionQuery({ok: true, data: {items: []}}));
  await expect(page.getByTestId('mgmt-memory-search-run')).toBeEnabled();
});

test('an import discard decision cannot bypass another editor navigation veto', async () => {
  await page.evaluate(() => {window.mount('import'); window.blockNavigation(true);});
  try {
    await page.getByTestId('literature-import-doi').fill('10.1234/guarded');
    await page.evaluate(() => window.navigate());
    await page.getByTestId('literature-import-discard-confirm').click();
    assert.equal(await page.evaluate(() => window.navigations), 0);
  } finally {
    await page.evaluate(() => window.blockNavigation(false));
  }
});
