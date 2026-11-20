import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page;
const errors = [];
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-import-state-'));
  await build({stdin: {contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, MotionConfig, domAnimation} from 'motion/react';
    import {ImportDialog} from './src/renderer/literature/ImportDialog';
    function Harness() {
      const [open, setOpen] = useState(true);
      const [item, setItem] = useState({id: 'paper-a', title: 'Paper A'});
      window.refreshItem = (id = item.id) => flushSync(() => setItem({id, title: 'Refreshed title'}));
      window.setImportOpen = value => flushSync(() => setOpen(value));
      return React.createElement(ImportDialog, {open, onClose: () => setOpen(false),
        projectId: 'project-fixture', client: {}, onZoteroImported: () => {},
        selectedItem: {id: item.id, title: item.title}, canAttachToSelection: true,
        pickFile: async () => '/fixture/source.pdf'});
    }
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion:'always'},
      React.createElement(LazyMotion, {features:domAnimation, strict:true}, React.createElement(Harness)))));
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
  bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), '<html data-theme="light"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script></html>');
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:1100,height:720})
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
  await page.getByTestId('literature-import-pick-document').click();
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '/fixture/source.pdf（PDF）');
  await refreshItem();
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '/fixture/source.pdf（PDF）');
  assert.equal(await page.getByTestId('literature-import-document-submit').isEnabled(), true);
  await page.getByTestId('literature-import-tab-doi').click();
  await page.getByTestId('literature-import-doi').fill('10.1234/retained');
  await refreshItem();
  assert.equal(await page.getByTestId('literature-import-doi').inputValue(), '10.1234/retained');
});

test('reopening and changing selected literature reset the import form', async () => {
  await page.evaluate(() => window.setImportOpen(false));
  await page.getByTestId('literature-import-dialog').waitFor({state:'hidden'});
  await page.evaluate(() => window.setImportOpen(true));
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '未选择');
  await page.getByTestId('literature-import-pick-document').click();
  await refreshItem('paper-b');
  assert.equal(await page.getByTestId('literature-import-document-path').innerText(), '未选择');
  assert.equal(await page.getByTestId('literature-import-document-submit').isDisabled(), true);
});

async function refreshItem(id) {
  await page.evaluate(async id => {
    window.refreshItem(id);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, id);
}


test('manual import keeps navigation visible and the unsaved draft across wide and narrow windows', async () => {
  await page.getByTestId('literature-import-tab-manual').click();
  const title='A retained scientific title with a long description of the research question';
  await page.getByTestId('literature-import-manual-title').fill(title);
  await page.getByTestId('literature-import-manual-abstract').fill('Long abstract with results and limitations. '.repeat(40));
  const source=readFileSync(join(process.cwd(),'.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
  for(const theme of ['light','dark']) for(const width of [1100,420]) {
    await page.setViewportSize({width,height:800});
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
