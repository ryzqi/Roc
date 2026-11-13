import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = resolve('.artifacts/research-optimization/pr08-a3b-ui');
const clipAudit = readFileSync(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-python-ui-'));
  mkdirSync(artifacts, { recursive: true });
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
const selectButton = () => page.getByTestId('mgmt-python-environment-select');
const ready = () => page.waitForFunction(() => !document.querySelector('[data-testid="mgmt-python-environment-select"]').disabled);

test('keyboard selection has a real pending state, cancellation and fresh path-free request identities', async () => {
  await page.evaluate(() => { reset(); window.held = deferred(); selectResponse = held.promise; mount(); });
  await ready();
  await selectButton().focus();
  await page.keyboard.press('Enter');
  await page.getByText('选择并核验中…', { exact: true }).waitFor();
  assert.equal(await selectButton().isDisabled(), true);
  await page.evaluate(() => held.resolve({ ok: true, data: null }));
  await page.getByText('已取消选择。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('mgmt-python-environment-history').count(), 0);
  await selectButton().click();
  await page.waitForFunction(() => calls.filter(call => call.method === 'select').length === 2);
  const requests = await page.evaluate(() => calls.filter(call => call.method === 'select').map(call => call.request));
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['projectId', 'requestId']);
    assert.equal(request.projectId, 'a'); assert.match(request.requestId, /^[a-f0-9-]{36}$/u);
  }
  assert.notEqual(requests[0].requestId, requests[1].requestId);
});

test('selection failure surfaces the actual error and retains exact historical records', async () => {
  await page.evaluate(() => {
    reset(); listResponse = {ok: true, data: [makeSelection()]};
    selectResponse = {ok: false, error: {code: 'lock_mismatch', message: 'research_python_lock_mismatch'}}; mount();
  });
  await ready();
  await selectButton().click();
  await page.getByRole('alert').filter({ hasText: 'research_python_lock_mismatch' }).waitFor();
  const history = page.getByTestId('mgmt-python-environment-history');
  await history.locator('summary').click();
  await history.locator('li').waitFor({ state: 'visible' });
  assert.match(await history.innerText(), /选择时已核验，当前可用性将在运行前检查/u);
  assert.match(await history.innerText(), /private\/selected env\/bin\/python3/u);
  assert.equal(await history.locator('li').count(), 1);
});

test('successful selection reloads main history instead of inventing a current environment', async () => {
  await page.evaluate(() => {
    reset(); selectResponse = {ok: true, data: makeSelection()}; mount();
  });
  await ready();
  await page.evaluate(() => { listResponse = {ok: true, data: [makeSelection()]}; });
  await selectButton().click();
  await page.getByText('环境选择已记录。', { exact: true }).waitFor();
  await page.getByTestId('mgmt-python-environment-history').waitFor();
  await page.getByTestId('mgmt-python-environment-history').locator('summary').click();
  assert.equal(await page.getByTestId('mgmt-python-environment-history').locator('li').count(), 1);
  assert.ok((await page.evaluate(() => calls.filter(call => call.method === 'list').length)) >= 3);
});
test('native environment selection serializes same-event clicks and does not reload after unmount', async () => {
  await page.evaluate(() => {reset(); window.held = deferred(); selectResponse = held.promise; mount();});
  await ready();
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="mgmt-python-environment-select"]');
    button.click(); button.click();
  });
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'select').length), 1);
  await expect(selectButton()).toBeDisabled();
  const reads = await page.evaluate(() => calls.filter(call => call.method === 'list').length);
  await page.evaluate(() => {clear(); held.resolve({ok: true, data: makeSelection()});});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'list').length), reads);
});

test('project switch drops pending old reads and old selection results', async () => {
  await page.evaluate(() => {
    reset(); window.oldRead = deferred(); listResponse = oldRead.promise; mount();
  });
  await page.getByText('读取 Python 环境中…', { exact: true }).waitFor();
  await page.evaluate(() => {
    projectResponse = {ok: true, data: {id: 'b', status: 'active', workspacePath: '/b'}};
    listResponse = {ok: true, data: []}; mount('b');
    oldRead.resolve({ok: true, data: [makeSelection()]});
  });
  await ready();
  assert.equal(await page.getByTestId('mgmt-python-environment-history').count(), 0);
  await page.evaluate(() => { window.oldSelect = deferred(); selectResponse = oldSelect.promise; });
  await selectButton().click();
  await page.getByText('选择并核验中…', { exact: true }).waitFor();
  await page.evaluate(() => {
    projectResponse = {ok: true, data: {id: 'c', status: 'active', workspacePath: '/c'}};
    mount('c'); oldSelect.resolve({ok: true, data: makeSelection('b')});
  });
  await ready();
  assert.equal(await page.getByText('环境选择已记录。', { exact: true }).count(), 0);
  assert.equal(await page.getByTestId('mgmt-python-environment-history').count(), 0);
});

test('unreadable, foreign, archived and workspace-less projects cannot initiate selection', async () => {
  await page.evaluate(() => { reset(); listResponse = {ok: false, error: {message: 'damaged_selection'}}; mount(); });
  await page.getByRole('alert').filter({hasText: 'damaged_selection'}).waitFor();
  assert.equal(await selectButton().isDisabled(), true);
  await page.evaluate(() => { listResponse = {ok: true, data: [makeSelection('foreign')]}; });
  await page.getByRole('button', {name: '重试读取 Python 环境'}).click();
  await page.getByRole('alert').filter({hasText: 'research_python_selection_project_mismatch'}).waitFor();
  assert.equal(await selectButton().isDisabled(), true);
  await page.evaluate(() => { reset(); projectResponse.data.status = 'archived'; mount(); });
  await page.getByText('项目已归档，环境记录只读。', {exact: true}).waitFor();
  assert.equal(await selectButton().isDisabled(), true);
  await page.evaluate(() => { reset(); projectResponse.data.workspacePath = null; mount(); });
  await page.getByText('请先为项目设置工作目录。', {exact: true}).waitFor();
  assert.equal(await selectButton().isDisabled(), true);
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'select').length), 0);
});

test('expanded long paths fit light and dark narrow desktop layouts with visible keyboard focus', async () => {
  await page.evaluate(() => {
    reset(); const value = makeSelection(); value.snapshot.selectedExecutable = '/private/' + 'long-environment-name/'.repeat(25) + 'bin/python3';
    listResponse = {ok: true, data: [value]}; mount();
  });
  await ready();
  const history = page.getByTestId('mgmt-python-environment-history');
  const audit = { closed: await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`) };
  assert.equal(audit.closed.cut, 0);
  await history.locator('summary').click();
  await history.locator('li').waitFor({ state: 'visible' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 680));
  await history.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await selectButton().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const focus = await selectButton().evaluate(button => ({style: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth}));
    assert.notEqual(focus.style, 'none'); assert.notEqual(focus.width, '0px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await selectButton().hover();
    audit[theme] = await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`);
    assert.equal(audit[theme].cut, 0);
    assert.match(await history.innerText(), /选择时已核验，当前可用性将在运行前检查/u);
    await page.screenshot({path: join(artifacts, `${theme}.png`)});
  }
  writeFileSync(join(artifacts, 'clip-audit.json'), JSON.stringify(audit, null, 2));
});
