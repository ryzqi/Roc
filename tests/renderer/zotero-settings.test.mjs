import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/zotero-settings-ui');
const at = '2026-11-04T00:00:00.000Z';
const connected = {status: 'connected', serverId: 'synthetic-instance', apiVersion: 3, schemaVersion: 40, checkedAt: at};
const status = (connection, installation = {status: 'not_found'}) => ({connection, installation});

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-zotero-settings-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await esbuild.build({stdin: {contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, MotionConfig, domAnimation} from 'motion/react';
    import {ZoteroSection} from './src/renderer/settings/sections/ZoteroSection';
    import {ModalShell} from './src/renderer/shell/ModalShell';
    const root = createRoot(document.getElementById('root'));
    let generation = 0;
    const client = {api:{research:{getZoteroStatus: async request => {
      window.calls.push(request);
      return new Promise(resolve => window.reply = resolve);
    }}}};
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button id="open" onClick={() => setOpen(true)}>设置</button>
        <ModalShell open={open} onClose={() => setOpen(false)} title="文献与解析"
          testId="zotero-settings-dialog" widthClassName="w-[672px]">
          <ZoteroSection client={client} />
        </ModalShell></>;
    }
    window.mount = () => {
      window.calls = [];
      flushSync(() => root.render(<MotionConfig reducedMotion="user">
        <LazyMotion features={domAnimation} strict><Harness key={++generation}/></LazyMotion>
      </MotionConfig>));
    };
  `, resolveDir: process.cwd(), loader: 'tsx'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(file => file.endsWith('.css'))
    .map(file => readFileSync(join(assets, file), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
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
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
async function open() {
  await page.evaluate(() => mount());
  await page.locator('#open').click();
  await page.getByTestId('settings-zotero').waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="zotero-settings-dialog-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
}
async function probe(value) {
  const count = await page.evaluate(() => calls.length);
  await page.getByTestId('settings-zotero-check').click();
  await page.waitForFunction(count => calls.length === count + 1, count);
  await page.getByTestId('settings-zotero-status').waitFor({state: 'detached'});
  await page.evaluate(value => reply({ok: true, data: value}), value);
  await page.getByTestId('settings-zotero-status').waitFor();
}
async function inspect(label) {
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const audit = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(audit, null, 2));
  assert.equal(audit.cut, 0);
  assert.equal(audit.hidden, 0);
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}
test('Zotero settings probes only on explicit action and keeps installation separate from API availability', async () => {
  await open();
  assert.deepEqual(await page.evaluate(() => calls), []);
  await page.getByTestId('settings-zotero-check').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => calls.length === 1);
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-zotero-check"]').disabled);
  assert.equal(await page.getByTestId('settings-zotero-check').isDisabled(), true);
  await page.evaluate(value => reply({ok: true, data: value}), status(connected));
  await page.getByTestId('settings-zotero-status').waitFor();
  assert.match(await page.getByTestId('settings-zotero-installation').innerText(), /常用应用目录未发现/u);
  assert.match(await page.getByTestId('settings-zotero-connection').innerText(), /已连接/u);
  assert.match(await page.getByTestId('settings-zotero-capabilities').innerText(), /预览收录/u);
  await inspect('connected-default');
  await page.getByTestId('settings-zotero-check').hover();
  await inspect('connected-hover');
  await page.getByTestId('settings-zotero-check').click();
  await page.waitForFunction(() => calls.length === 2);
  assert.equal(await page.getByTestId('settings-zotero-status').count(), 0, 'previous connected state is not current while checking');
  await page.evaluate(value => reply({ok: true, data: value}),
    status({status: 'disabled', errorCode: 'zotero_api_disabled', checkedAt: at}, {status: 'found', location: 'system'}));
  await page.getByTestId('settings-zotero-status').waitFor();
  assert.match(await page.getByTestId('settings-zotero-connection').innerText(), /未启用通信/u);
  assert.match(await page.getByTestId('settings-zotero-help').innerText(), /高级设置/u);
  assert.equal(await page.getByTestId('settings-zotero-capabilities').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'open');
});
test('Zotero settings discloses failures and drops a late response after closing', async () => {
  await open();
  for (const state of ['unreachable', 'unsupported', 'invalid_response']) {
    await probe(status({status: state, errorCode: `zotero_${state}`, checkedAt: at}));
    const label = await page.getByTestId('settings-zotero-connection').innerText();
    assert.match(label, state === 'unreachable' ? /不可达/u : state === 'unsupported' ? /版本不支持/u : /响应无效/u);
    assert.equal(await page.getByTestId('settings-zotero-help').count(), 1);
  }
  await page.getByTestId('settings-zotero-check').click();
  await page.waitForFunction(() => calls.length === 4);
  await page.evaluate(() => reply({ok: false, error: {message: 'Synthetic directory read denied'}}));
  await page.getByTestId('settings-zotero-error').waitFor();
  assert.match(await page.getByTestId('settings-zotero-error').innerText(), /Synthetic directory read denied/u);
  assert.equal(await page.getByTestId('settings-zotero-status').count(), 0);
  await page.getByTestId('settings-zotero-check').click();
  await page.waitForFunction(() => calls.length === 5);
  await page.keyboard.press('Escape');
  await page.getByTestId('zotero-settings-dialog-panel').waitFor({state: 'detached'});
  await page.evaluate(value => reply({ok: true, data: value}), status(connected));
  await page.locator('#open').click();
  assert.equal(await page.getByTestId('settings-zotero-status').count(), 0);
  assert.equal(await page.evaluate(() => calls.length), 5, 'reopening never starts a probe');
});
test('Zotero settings stays readable in light dark and reduced-motion at shell drawer boundary', async () => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await open();
  await probe(status({status: 'unreachable', errorCode: 'zotero_unreachable', checkedAt: at}));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 1099, 800]) {
      await page.setViewportSize({width, height: 720});
      const layout = await page.getByTestId('settings-zotero').evaluate(element => ({
        overflow: element.scrollWidth > element.clientWidth,
        minFont: Math.min(...[...element.querySelectorAll('button,h3,dt,dd,p')].map(node => parseFloat(getComputedStyle(node).fontSize)))
      }));
      assert.equal(layout.overflow, false);
      assert.ok(layout.minFont >= 12);
      await inspect(`${theme}-${width}`);
    }
  }
});
