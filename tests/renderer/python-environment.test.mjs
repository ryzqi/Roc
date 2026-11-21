import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';

let directory, app, page;
const errors = [];
const clipAudit = readFileSync(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-python-ui-'));
  await esbuild.build({
    stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {PythonEnvironmentSection} from './src/renderer/management/sections/PythonEnvironmentSection';
      const root = createRoot(document.getElementById('root'));
      window.makeSelection = (projectId = 'a', id = 'selection-a') => ({
        snapshot: {id, request: {projectId}, selectedExecutable: '/private/selected env/bin/python3',
          version: '3.14.7', recordedAt: '2026-11-05T00:00:00.000Z'}, snapshotHash: 'a'.repeat(64)
      });
      window.deferred = () => {
        let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};
      };
      window.client = {api: {research: {
        getProject: request => {calls.push({method: 'project', request}); return Promise.resolve(projectResponse);},
        listPythonEnvironmentSelections: request => {calls.push({method: 'list', request}); return Promise.resolve(listResponse);},
        selectPythonEnvironment: request => {calls.push({method: 'select', request}); return Promise.resolve(selectResponse);}
      }}};
      window.mount = (projectId = 'a') => flushSync(() => root.render(
        React.createElement(React.StrictMode, null, React.createElement(PythonEnvironmentSection, {key: projectId, client, projectId}))
      ));
      window.clear = () => flushSync(() => root.render(null));
      window.reset = () => {
        clear(); window.calls = [];
        window.projectResponse = {ok: true, data: {id: 'a', status: 'active', workspacePath: '/workspace'}};
        window.listResponse = {ok: true, data: []};
        window.selectResponse = {ok: true, data: null};
      };
      reset();
    `},
    outfile: join(directory, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  const cssRoot = resolve('dist/renderer/assets');
  const css = readdirSync(cssRoot).filter(name => name.endsWith('.css')).map(name => readFileSync(join(cssRoot, name), 'utf8')).join('\n');
  writeFileSync(join(directory, 'ui.css'), css);
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="ui.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    #root{max-width:680px}</style><div id="root"></div><script src="ui.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:760,height:680}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try { await app?.close(); }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});
const ready = () => page.getByText('Python 环境将在项目使用时自动准备。', {exact: true}).waitFor();

test('environment prepares automatically without asking for interpreter or lock selection', async () => {
  await page.evaluate(() => { reset(); mount(); });
  await ready();
  assert.equal(await page.getByTestId('mgmt-python-environment-select').count(), 0);
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'select').length), 0);
  assert.match(await page.getByTestId('mgmt-python-environment').innerText(), /无需选择解释器/u);
});

test('automatic preparation errors expose keyboard retry and real environment records', async () => {
  await page.evaluate(() => { reset(); listResponse = {ok: false, error: {message: 'runtime_unavailable'}}; mount(); });
  await page.getByRole('alert').filter({hasText: 'runtime_unavailable'}).waitFor();
  await page.evaluate(() => { listResponse = {ok: true, data: [makeSelection()]}; });
  const retry = page.getByRole('button', {name: '重试读取 Python 环境'});
  await retry.focus(); await page.keyboard.press('Enter');
  const history = page.getByTestId('mgmt-python-environment-history');
  await history.locator('summary').click();
  await history.locator('li').waitFor({state: 'visible'});
  assert.equal(await history.locator('li').count(), 1);
  assert.match(await history.innerText(), /记录时已核验，运行前会再次检查/u);
  assert.match(await history.innerText(), /private\/selected env\/bin\/python3/u);
});

test('project switch drops stale automatic preparation results', async () => {
  await page.evaluate(() => { reset(); window.oldRead = deferred(); listResponse = oldRead.promise; mount(); });
  await page.getByText('读取 Python 环境中…', {exact: true}).waitFor();
  await page.evaluate(() => {
    projectResponse = {ok: true, data: {id: 'b', status: 'active', workspacePath: '/b'}};
    listResponse = {ok: true, data: []}; mount('b'); oldRead.resolve({ok: true, data: [makeSelection()]});
  });
  await ready();
  assert.equal(await page.getByTestId('mgmt-python-environment-history').count(), 0);
});

test('foreign records fail while archived and workspace-less projects explain their state', async () => {
  await page.evaluate(() => { reset(); listResponse = {ok: true, data: [makeSelection('foreign')]}; mount(); });
  await page.getByRole('alert').filter({hasText: 'research_python_selection_project_mismatch'}).waitFor();
  await page.evaluate(() => { reset(); projectResponse.data.status = 'archived'; mount(); });
  await page.getByText('项目已归档，环境记录只读。', {exact: true}).waitFor();
  await page.evaluate(() => { reset(); projectResponse.data.workspacePath = null; mount(); });
  await page.getByText('请先为项目设置工作目录。', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'select').length), 0);
});

test('automatic environment history fits light and dark compact desktop layouts', async () => {
  await page.evaluate(() => {
    reset(); const value = makeSelection(); value.snapshot.selectedExecutable = '/private/' + 'long-environment-name/'.repeat(25) + 'bin/python3';
    listResponse = {ok: true, data: [value]}; mount();
  });
  const summary = page.getByTestId('mgmt-python-environment-history').locator('summary');
  await summary.click();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(480, 680));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await summary.focus(); await expect(summary).toBeFocused();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const audit = await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`);
    assert.equal(audit.cut, 0);
    await page.screenshot({path: join(directory, `${theme}.png`)});
  }
});
