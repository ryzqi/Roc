import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';

let directory, app, page;
const errors = [];
const clipAudit = readFileSync(resolve('scripts/ui-audit/clip-audit.js'), 'utf8');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-python-ui-'));
  await esbuild.build({
    stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {PythonEnvironmentSection} from './src/renderer/management/sections/PythonEnvironmentSection';
      const root = createRoot(document.getElementById('root'));
      window.makeEnvironment = (projectId = 'a', id = 'environment-a') => ({
        snapshot: {id, request: {projectId}, selectedExecutable: '/private/selected env/bin/python3',
          version: '3.14.10', recordedAt: '2026-11-05T00:00:00.000Z'}, snapshotHash: 'a'.repeat(64)
      });
      window.makeOperation = (phase = 'queued', projectId = 'a') => ({id: 'operation-a', request: {projectId, requestId: 'request-a'}, phase,
        errorCode: phase === 'failed' ? 'research_python_lock_stale' : null, updatedAt: new Date().toISOString(), environmentRef: null});
      window.deferred = () => {
        let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};
      };
      window.client = {api: {research: {
        getProject: request => {calls.push({method: 'project', request}); return Promise.resolve(projectResponse);},
        listPythonEnvironments: request => {calls.push({method: 'list', request}); return Promise.resolve(listResponse);},
        getPythonEnvironmentStatus: request => {calls.push({method: 'status', request}); return Promise.resolve(statusResponse);},
        preparePythonEnvironment: request => {calls.push({method: 'prepare', request}); return Promise.resolve(prepareResponse);},
        cancelPythonEnvironmentPreparation: request => {calls.push({method: 'cancel', request}); return Promise.resolve(cancelResponse);}
      }}};
      window.mount = (projectId = 'a') => flushSync(() => root.render(
        React.createElement(React.StrictMode, null, React.createElement(PythonEnvironmentSection, {key: projectId, client, projectId}))
      ));
      window.clear = () => flushSync(() => root.render(null));
      window.reset = () => {
        clear(); window.calls = [];
        window.projectResponse = {ok: true, data: {id: 'a', status: 'active', workspacePath: '/workspace'}};
        window.listResponse = {ok: true, data: []};
        window.statusResponse = {ok: true, data: {operation: null, environment: null}};
        window.prepareResponse = {ok: true, data: makeOperation()};
        window.cancelResponse = {ok: true, data: makeOperation('cancelled')};
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
const ready = () => page.getByText('暂无环境记录', {exact: true}).waitFor();

test('mount and idle status remain read-only without background polling or interpreter selection', async () => {
  await page.evaluate(() => { reset(); mount(); }); await ready();
  await expect(page.getByTestId('mgmt-python-prepare')).toHaveText('准备环境');
  const reads = await page.evaluate(() => calls.length);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => calls.length), reads);
  assert.equal(await page.evaluate(() => calls.filter(call => ['prepare','cancel'].includes(call.method)).length), 0);
  assert.equal(await page.getByRole('combobox').count(), 0);
});

test('keyboard prepare shows real phases, polls only an active task and freezes duplicate cancellation', async () => {
  await page.evaluate(() => { reset(); mount(); }); await ready();
  await page.evaluate(() => {
    statusResponse = {ok: true, data: {operation: makeOperation('syncing'), environment: null}};
    prepareResponse = {ok: true, data: statusResponse.data.operation};
  });
  await page.getByTestId('mgmt-python-prepare').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('mgmt-python-status')).toHaveText('安装项目依赖');
  assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'prepare').length), 1);
  assert.deepEqual(await page.evaluate(() => Object.keys(calls.find(call => call.method === 'prepare').request).sort()), ['projectId','requestId']);
  const reads = await page.evaluate(() => calls.filter(call => call.method === 'status').length);
  await expect.poll(() => page.evaluate(() => calls.filter(call => call.method === 'status').length)).toBeGreaterThan(reads);
  await page.evaluate(() => { window.pendingCancel = deferred(); cancelResponse = pendingCancel.promise; });
  await page.getByTestId('mgmt-python-cancel').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('mgmt-python-cancel')).toBeDisabled();
  await expect(page.getByTestId('mgmt-python-status')).toHaveText('正在取消准备');
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'cancel').request), {projectId: 'a', operationId: 'operation-a'});
  await page.evaluate(() => {
    const operation = makeOperation('cancelled'); statusResponse = {ok: true, data: {operation, environment: null}};
    pendingCancel.resolve({ok: true, data: operation});
  });
  await expect(page.getByTestId('mgmt-python-status')).toHaveText('已取消准备');
  await expect(page.getByTestId('mgmt-python-prepare')).toHaveText('重试准备');
  const finalReads = await page.evaluate(() => calls.length); await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => calls.length), finalReads);
});

test('failed preparation explains the cause and permits a new preparation request', async () => {
  await page.evaluate(() => { reset(); statusResponse.data.operation = makeOperation('failed'); mount(); });
  await expect(page.getByRole('alert')).toHaveText('项目依赖锁与配置不一致，请更新依赖锁后重试。');
  await expect(page.getByTestId('mgmt-python-prepare')).toHaveText('重试准备');
  await page.evaluate(() => { statusResponse.data.operation = makeOperation('queued'); prepareResponse.data = statusResponse.data.operation; });
  await page.getByTestId('mgmt-python-prepare').click();
  await expect(page.getByTestId('mgmt-python-status')).toHaveText('等待准备');
});

test('read errors expose keyboard retry and successful environment history', async () => {
  await page.evaluate(() => { reset(); listResponse = {ok: false, error: {message: 'runtime_unavailable'}}; mount(); });
  await page.getByRole('alert').filter({hasText: 'runtime_unavailable'}).waitFor();
  await page.evaluate(() => { listResponse = {ok: true, data: [makeEnvironment()]}; });
  const retry = page.getByRole('button', {name: '重试读取 Python 环境'});
  await retry.focus(); await page.keyboard.press('Enter');
  const history = page.getByTestId('mgmt-python-environment-history');
  await history.locator('summary').click(); await history.locator('li').waitFor({state: 'visible'});
  assert.equal(await history.locator('li').count(), 1);
  assert.match(await history.innerText(), /记录时已核验，运行前会再次检查/u);
});

test('project switch discards stale status, history and action completions', async () => {
  await page.evaluate(() => { reset(); window.oldRead = deferred(); listResponse = oldRead.promise; mount(); });
  await page.getByText('读取 Python 环境中…', {exact: true}).waitFor();
  await page.evaluate(() => {
    projectResponse = {ok: true, data: {id: 'b', status: 'active', workspacePath: '/b'}};
    listResponse = {ok: true, data: []}; mount('b'); oldRead.resolve({ok: true, data: [makeEnvironment()]});
  });
  await ready(); assert.equal(await page.getByTestId('mgmt-python-environment-history').count(), 0);
  await page.evaluate(() => { reset(); mount(); }); await ready();
  await page.evaluate(() => { window.oldAction = deferred(); prepareResponse = oldAction.promise; });
  await page.getByTestId('mgmt-python-prepare').click();
  await page.evaluate(() => {
    projectResponse = {ok: true, data: {id: 'b', status: 'active', workspacePath: '/b'}}; mount('b');
    oldAction.resolve({ok: true, data: makeOperation('syncing')});
  });
  await expect(page.getByTestId('mgmt-python-status')).toHaveText('环境尚未准备');
  assert.equal(await page.getByTestId('mgmt-python-cancel').count(), 0);
});

test('foreign records fail and archived or workspace-less projects cannot mutate environments', async () => {
  await page.evaluate(() => { reset(); listResponse = {ok: true, data: [makeEnvironment('foreign')]}; mount(); });
  await page.getByRole('alert').filter({hasText: 'research_python_environment_project_mismatch'}).waitFor();
  for (const variant of ['archived','workspace']) {
    await page.evaluate(variant => { reset(); if (variant === 'archived') projectResponse.data.status = 'archived'; else projectResponse.data.workspacePath = null; mount(); }, variant);
    await page.getByText(variant === 'archived' ? '项目已归档，环境记录只读。' : '请先为项目设置工作目录。', {exact: true}).waitFor();
    assert.equal(await page.getByTestId('mgmt-python-prepare').count(), 0);
  }
});

test('status and long history fit light/dark compact desktop layouts with keyboard focus and reduced motion', async () => {
  await page.evaluate(() => {
    reset(); const value = makeEnvironment(); value.snapshot.selectedExecutable = '/private/' + 'long-environment-name/'.repeat(25) + 'bin/python3';
    listResponse = {ok: true, data: [value]}; statusResponse.data = {operation: makeOperation('ready'), environment: value}; mount();
  });
  await page.emulateMedia({reducedMotion: 'reduce'});
  const summary = page.getByTestId('mgmt-python-environment-history').locator('summary'); await summary.click();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(480, 680));
  await page.waitForFunction(() => innerWidth === 480);
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByTestId('mgmt-python-prepare').focus(); await page.keyboard.press('Tab'); await expect(summary).toBeFocused();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const audit = await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`); assert.equal(audit.cut, 0);
    const artifacts = resolve('.artifacts/research-toolchain-p2/ui-python');
    await mkdir(artifacts, {recursive: true});
    await page.screenshot({path: join(artifacts, `${theme}.png`)});
  }
});
