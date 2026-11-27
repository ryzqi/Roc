import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';

let directory, app, page;
const errors = [];
const capture = process.env.ROC_IMPORT_CAPTURE;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-import-state-'));
  if (capture) mkdirSync(capture, {recursive: true});
  await build({stdin: {contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, MotionConfig, domAnimation} from 'motion/react';
    import {ImportDialog} from './src/renderer/literature/ImportDialog';
    window.documentImports = [];
    window.attachedDocumentImports = [];
    window.documentPath = '/fixture/source.pdf';
    window.deferPick = false;
    window.deferImport = false;
    function Harness() {
      const [open, setOpen] = useState(true);
      const [item, setItem] = useState({id: 'paper-a', title: 'Paper A'});
      const [writable, setWritable] = useState(true);
      const [canAttach, setCanAttach] = useState(true);
      window.refreshItem = (id = item.id) => flushSync(() => setItem({id, title: 'Refreshed title'}));
      window.setImportOpen = value => flushSync(() => setOpen(value));
      window.setImportWritable = value => flushSync(() => setWritable(value));
      window.setImportCanAttach = value => flushSync(() => setCanAttach(value));
      return React.createElement(ImportDialog, {open, onClose: () => setOpen(false),
        projectId: 'project-fixture', writable, client: {}, onZoteroImported: () => {},
        selectedItem: {id: item.id, title: item.title}, canAttachToSelection: canAttach,
        pickFile: () => window.deferPick
          ? new Promise(resolve => {window.finishPick = resolve;})
          : Promise.resolve(window.documentPath),
        addDocumentToNewItem: async input => {
          window.documentImports.push(input);
          if (window.deferImport) return new Promise(resolve => {window.finishImport = resolve;});
          return {ok: true, createdCount: 1, duplicateCount: 0};
        },
        addDocumentToItem: async input => {
          window.attachedDocumentImports.push(input);
          return {ok: true, createdCount: 1, duplicateCount: 0};
        }});
    }
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion:'always'},
      React.createElement(LazyMotion, {features:domAnimation, strict:true}, React.createElement(Harness)))));
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
  bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n') + '\n' + readFileSync(join(directory, 'app.css'), 'utf8'));
  writeFileSync(join(directory, 'index.html'), '<html data-theme="light"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script></html>');
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:true,width:1100,height:720})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('literature-import-pick-document').waitFor();
});
after(async () => {
  await page?.evaluate(() => window.setImportOpen(false)).catch(() => {});
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

test('same literature identity preserves selected PDF and typed DOI across parent refreshes', async () => {
  assert.equal(await page.getByRole('tablist', {name: '导入方式'}).getByRole('tab').count(), 4);
  assert.equal(await page.getByTestId('literature-import-tab-manual').isVisible(), false);
  await page.getByTestId('literature-import-pick-document').click();
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '/fixture/source.pdf（PDF）');
  await refreshItem();
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '/fixture/source.pdf（PDF）');
  assert.equal(await page.getByTestId('literature-import-document-submit').isEnabled(), true);
  await page.getByTestId('literature-import-tab-doi').click();
  await page.getByTestId('literature-import-doi').fill('10.1234/retained');
  await refreshItem();
  assert.equal(await page.getByTestId('literature-import-doi').inputValue(), '10.1234/retained');
  await page.getByTestId('literature-import-tab-document').click();
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '/fixture/source.pdf（PDF）');
  await page.getByTestId('literature-import-tab-doi').click();
  assert.equal(await page.getByTestId('literature-import-doi').inputValue(), '10.1234/retained');
});

test('document citation suggestions preserve manual edits and empty values until restored', async () => {
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  await page.evaluate(() => window.setImportOpen(true));
  await page.getByTestId('literature-import-target-new').check();
  await page.getByTestId('literature-import-pick-document').click();
  await page.getByTestId('literature-import-document-metadata-toggle').click();
  const title = page.getByTestId('literature-import-document-title');
  const key = page.getByTestId('literature-import-document-key');
  const submit = page.getByTestId('literature-import-document-submit');
  await title.fill('Alpha study');
  await expect(key).toHaveValue('alpha');
  await key.fill('my-reference');
  await title.fill('Beta study');
  await refreshItem();
  await expect(key).toHaveValue('my-reference');
  await submit.click();
  await page.waitForFunction(() => window.documentImports.length === 1);
  assert.deepEqual(await page.evaluate(() => window.documentImports[0]),
    {sourcePath: '/fixture/source.pdf', title: 'Beta study', citationKey: 'my-reference', metadataMode: 'provided'});

  await key.fill('');
  await title.fill('Gamma study');
  await expect(key).toHaveValue('');
  await expect(submit).toBeDisabled();
  await page.getByTestId('literature-import-document-key-auto').click();
  await expect(key).toHaveValue('gamma');
  await title.fill('Delta study');
  await expect(key).toHaveValue('delta');
  await submit.click();
  await page.waitForFunction(() => window.documentImports.length === 2);
  assert.equal(await page.evaluate(() => window.documentImports[1].citationKey), 'delta');
  await key.fill('retained-reference');
});

test('reopening and changing selected literature reset the import form', async () => {
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state:'hidden'});
  await page.evaluate(() => window.setImportOpen(true));
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '未选择');
  await page.getByTestId('literature-import-target-new').check();
  await expect(page.getByTestId('literature-import-document-title')).toHaveValue('');
  await expect(page.getByTestId('literature-import-document-key')).toHaveValue('');
  await expect(page.getByTestId('literature-import-document-metadata-toggle')).toHaveAttribute('aria-expanded', 'false');
  assert.equal(await page.getByTestId('literature-import-document-key-auto').count(), 0);
  await page.getByTestId('literature-import-document-metadata-toggle').click();
  await page.getByTestId('literature-import-document-title').fill('Retained study');
  await page.getByTestId('literature-import-document-key').fill('manual-reference');
  await page.getByTestId('literature-import-pick-document').click();
  await refreshItem('paper-b');
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '未选择');
  await page.getByTestId('literature-import-target-new').check();
  await expect(page.getByTestId('literature-import-document-title')).toHaveValue('');
  await expect(page.getByTestId('literature-import-document-key')).toHaveValue('');
  assert.equal(await page.getByTestId('literature-import-document-key-auto').count(), 0);
  assert.equal(await page.getByTestId('literature-import-document-submit').isDisabled(), true);
});

async function refreshItem(id) {
  await page.evaluate(async id => {
    window.refreshItem(id);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, id);
}


test('manual import keeps navigation visible and the unsaved draft across wide and narrow windows', async () => {
  await page.getByTestId('literature-import-other').click();
  await page.getByTestId('literature-import-tab-manual').click();
  const title='A retained scientific title with a long description of the research question';
  await page.getByTestId('literature-import-manual-title').fill(title);
  await page.getByTestId('literature-import-manual-abstract').fill('Long abstract with results and limitations. '.repeat(40));
  const source=readFileSync(join(process.cwd(),'scripts/ui-audit/clip-audit.js'),'utf8');
  for(const theme of ['light','dark']) for(const width of [1100,420]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByTestId('literature-import-manual-submit').scrollIntoViewIfNeeded();
    const nav=await page.getByRole('tablist',{name:'导入方式'}).boundingBox();
    assert.ok(nav.y>=0&&nav.y+nav.height<250,JSON.stringify(nav));
    assert.equal(await page.getByTestId('literature-import-manual-title').inputValue(),title);
    const audit=await page.evaluate(source=>(0,eval)(`(${source})`)({root:'body',viewport:true}),source);
    assert.equal(audit.cut,0,JSON.stringify(audit));
    if(process.env.ROC_REDESIGN_SCREENSHOTS) await page.screenshot({path:join(process.env.ROC_REDESIGN_SCREENSHOTS,`import-${theme}-${width}.png`)});
  }
  await page.getByTestId('literature-import-dialog-close').click();
  await page.getByTestId('literature-import-discard').waitFor();
  await page.getByRole('button',{name:'继续录入',exact:true}).click();
  assert.equal(await page.getByTestId('literature-import-manual-title').inputValue(),title);
});

async function reopenDocument() {
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state: 'hidden'});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 800));
  await page.evaluate(() => {
    window.setImportWritable(true);
    window.setImportCanAttach(true);
    window.refreshItem('paper-fixture');
    window.deferPick = false;
    window.deferImport = false;
    window.documentPath = '/fixture/source.pdf';
    window.documentImports = [];
    window.attachedDocumentImports = [];
    document.documentElement.dataset.theme = 'light';
    window.setImportOpen(true);
  });
  await page.getByTestId('literature-import-target-new').check();
}

test('new PDFs import automatically from the chosen file without a title or citation decision', async () => {
  await reopenDocument();
  const disclosure = page.getByTestId('literature-import-document-metadata-toggle');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('literature-import-document-title')).toBeHidden();
  await expect(page.getByTestId('literature-import-document-submit')).toBeDisabled();
  await page.getByTestId('literature-import-pick-document').click();
  await expect(page.getByTestId('literature-import-document-submit')).toBeEnabled();
  await page.getByTestId('literature-import-document-submit').click();
  await expect(page.getByTestId('literature-import-message')).toContainText('已添加 1 份文档');
  assert.deepEqual(await page.evaluate(() => window.documentImports), [{
    sourcePath: '/fixture/source.pdf', title: 'source', citationKey: 'source', metadataMode: 'automatic'
  }]);
  await page.getByTestId('literature-import-dialog-close').click();
  await expect(page.getByTestId('literature-import-dialog')).toBeHidden();
  await expect(page.getByTestId('literature-import-discard')).toHaveCount(0);
});

test('an unused manual override survives automatic import and retains its discard guard', async () => {
  await reopenDocument();
  await page.getByTestId('literature-import-pick-document').click();
  const disclosure = page.getByTestId('literature-import-document-metadata-toggle');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('literature-import-document-title').fill('Retained title');
  await page.getByTestId('literature-import-document-key').fill('chosen-key');
  await disclosure.click();
  await page.getByTestId('literature-import-document-submit').click();
  await expect(page.getByTestId('literature-import-message')).toContainText('已添加 1 份文档');
  assert.deepEqual(await page.evaluate(() => window.documentImports[0]), {
    sourcePath: '/fixture/source.pdf', title: 'source', citationKey: 'source', metadataMode: 'automatic'
  });
  await page.getByTestId('literature-import-dialog-close').click();
  await expect(page.getByTestId('literature-import-discard')).toBeVisible();
  await page.getByTestId('literature-import-discard-cancel').click();
  await page.getByTestId('literature-import-discard').waitFor({state: 'hidden'});
  await disclosure.click();
  await expect(page.getByTestId('literature-import-document-title')).toHaveValue('Retained title');
  await expect(page.getByTestId('literature-import-document-key')).toHaveValue('chosen-key');
});

test('manual document submissions lock their mode and preserve refused fields across readonly changes', async () => {
  await reopenDocument();
  await page.getByTestId('literature-import-pick-document').click();
  const disclosure = page.getByTestId('literature-import-document-metadata-toggle');
  await disclosure.click();
  const title = page.getByTestId('literature-import-document-title');
  const key = page.getByTestId('literature-import-document-key');
  const submit = page.getByTestId('literature-import-document-submit');
  await title.fill('Chosen title');
  await key.fill('chosen-citation');
  await page.evaluate(() => {window.deferImport = true;});
  await submit.evaluate(button => {button.click(); button.click();});
  await expect(disclosure).toHaveAttribute('aria-disabled', 'true');
  await disclosure.evaluate(summary => summary.click());
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(title).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.documentImports), [{
    sourcePath: '/fixture/source.pdf', title: 'Chosen title', citationKey: 'chosen-citation', metadataMode: 'provided'
  }]);
  await page.evaluate(() => {
    window.setImportWritable(false);
    window.finishImport({ok: false, message: 'Document import refused'});
  });
  await expect(page.getByTestId('literature-import-message')).toContainText('Document import refused');
  await expect(submit).toBeDisabled();
  await expect(title).toHaveValue('Chosen title');
  await expect(key).toHaveValue('chosen-citation');
  await page.evaluate(() => {window.setImportWritable(true); window.deferImport = false;});
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('literature-import-message')).toContainText('已添加 1 份文档');
  assert.equal(await page.evaluate(() => window.documentImports.length), 2);
  await page.getByTestId('literature-import-dialog-close').click();
  await expect(page.getByTestId('literature-import-dialog')).toBeHidden();
  await expect(page.getByTestId('literature-import-discard')).toHaveCount(0);
});

test('readonly changes discard late picker results while preserving the open manual draft', async () => {
  await reopenDocument();
  await page.getByTestId('literature-import-document-metadata-toggle').click();
  const title = page.getByTestId('literature-import-document-title');
  const key = page.getByTestId('literature-import-document-key');
  await title.fill('Retained before archive');
  await key.fill('retained-before-archive');
  await page.evaluate(() => {window.deferPick = true;});
  const picker = page.getByTestId('literature-import-pick-document');
  await picker.click();
  await page.evaluate(() => {
    window.setImportWritable(false);
    window.finishPick('/fixture/blocked.pdf');
  });
  await expect(page.getByTestId('literature-import-pending')).toHaveCount(0);
  await expect(page.getByTestId('literature-import-document-path')).toHaveText('未选择');
  await expect(picker).toBeDisabled();
  await expect(page.getByTestId('literature-import-document-submit')).toBeDisabled();
  await expect(page.getByTestId('literature-import-readonly')).toBeVisible();
  await expect(title).toHaveValue('Retained before archive');
  await expect(key).toHaveValue('retained-before-archive');
  await page.getByTestId('literature-import-tab-doi').click();
  await page.getByTestId('literature-import-doi').fill('10.1234/retained');
  await expect(page.getByTestId('literature-import-doi-submit')).toBeDisabled();
  await page.getByTestId('literature-import-tab-search').click();
  await page.getByTestId('literature-import-search').fill('readable search');
  await expect(page.getByTestId('literature-import-search-submit')).toBeEnabled();
  await page.getByTestId('literature-import-tab-document').click();
  await page.evaluate(() => {window.setImportWritable(true); window.deferPick = false;});
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(page.getByTestId('literature-import-document-path')).toHaveText('/fixture/source.pdf（PDF）');
  await expect(page.getByTestId('literature-import-document-submit')).toBeEnabled();
  await expect(title).toHaveValue('Retained before archive');
});

test('existing-item attachments retain their request contract and enforce attachment eligibility', async () => {
  await reopenDocument();
  await page.getByTestId('literature-import-target-existing').check();
  await page.getByTestId('literature-import-pick-document').click();
  await expect(page.getByTestId('literature-import-document-metadata-toggle')).toHaveCount(0);
  await page.evaluate(() => window.setImportCanAttach(false));
  await expect(page.getByTestId('literature-import-target-existing')).toBeDisabled();
  await expect(page.getByTestId('literature-import-document-submit')).toBeDisabled();
  await page.evaluate(() => window.setImportCanAttach(true));
  await page.getByTestId('literature-import-document-submit').click();
  await expect(page.getByTestId('literature-import-message')).toContainText('已添加 1 份文档');
  assert.deepEqual(await page.evaluate(() => window.attachedDocumentImports), [{
    sourcePath: '/fixture/source.pdf', libraryItemId: 'paper-fixture'
  }]);
  assert.equal(await page.evaluate(() => window.documentImports.length), 0);
});

test('automatic and disclosed document forms preserve focus and shadows in both native window sizes and themes', async () => {
  await reopenDocument();
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const assertShadows = async state => {
    const result = await page.evaluate(source => (0, eval)(source)({root: 'body', viewport: true}), auditSource);
    assert.equal(result.cut, 0, JSON.stringify({state, result}));
    assert.equal(result.hidden, 0, JSON.stringify({state, result}));
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 800));
    const disclosure = page.getByTestId('literature-import-document-metadata-toggle');
    if (await disclosure.getAttribute('aria-expanded') === 'true') await disclosure.click();
    await assertShadows(`${theme}:automatic-wide`);
    if (capture) await page.screenshot({path: join(capture, `document-import-automatic-${theme}-1100.png`)});
    await disclosure.focus();
    await page.keyboard.press('Space');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('literature-import-document-title')).toBeFocused();
    await assertShadows(`${theme}:provided-wide`);
    if (capture) await page.screenshot({path: join(capture, `document-import-focus-${theme}-1100.png`)});
    await page.getByTestId('literature-import-document-title').fill('A retained title for a narrow desktop import window');
    await page.getByTestId('literature-import-document-key').fill('retained-narrow');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(420, 800));
    await page.getByTestId('literature-import-document-submit').scrollIntoViewIfNeeded();
    await assertShadows(`${theme}:provided-narrow`);
    await disclosure.hover();
    await assertShadows(`${theme}:hover-narrow`);
    if (capture) await page.screenshot({path: join(capture, `document-import-provided-${theme}-420.png`)});
  }
});
