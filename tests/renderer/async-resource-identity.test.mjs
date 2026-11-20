import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-resource-identity-'));
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {useAsyncResource} from './src/renderer/app/use-async-resource';
    const root=createRoot(document.getElementById('root'));
    window.calls=[];window.pending={};window.frames=[];
    function Harness({initialScope}) {
      const [scope,setScope]=useState(initialScope);
      window.selectScope=next=>flushSync(()=>setScope(next));
      const read=useAsyncResource(scope,()=>new Promise((resolve,reject)=>{
        const id=window.calls.length;window.calls.push({id,scope});window.pending[id]={resolve,reject};
      }),{label:'Read exact scoped resource'});
      window.frames.push({scope,status:read.status,data:read.data,error:read.error,errorCode:read.errorCode});
      return <main><button data-testid="resource-reload" onClick={read.reload}>Reload</button>
        <pre data-testid="resource-state">{JSON.stringify({scope,status:read.status,data:read.data,error:read.error,errorCode:read.errorCode})}</pre></main>;
    }
    let generation=0;
    window.mount=scope=>{window.calls=[];window.pending={};window.frames=[];flushSync(()=>root.render(<Harness key={++generation} initialScope={scope}/>));};
  `, style: 'body{margin:0;padding:16px}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:700}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
async function mount(scope) {
  await page.evaluate(scope => window.mount(scope), scope);
  await page.waitForFunction(() => window.calls.length === 1);
}
async function resolve(id, result) {
  await page.evaluate(({id, result}) => window.pending[id].resolve(result), {id, result});
}
async function state() {
  return JSON.parse(await page.getByTestId('resource-state').innerText());
}
async function waitStatus(status) {
  await page.waitForFunction(status => JSON.parse(document.querySelector('[data-testid="resource-state"]').textContent).status === status, status);
}

test('backend error code/message remain real failures and reload success clears both identities', async () => {
  await mount('project-a:plan');
  await resolve(0, {ok: false, error: {code: 'research_review_screening_plan_not_found', message: 'Actual initial declaration absent'}});
  await waitStatus('error');
  assert.deepEqual(await state(), {scope: 'project-a:plan', status: 'error', data: null,
    error: 'Actual initial declaration absent', errorCode: 'research_review_screening_plan_not_found'});
  await page.getByTestId('resource-reload').click(); await page.waitForFunction(() => window.calls.length === 2);
  await resolve(1, {ok: true, data: {id: 'exact-declaration'}});
  await waitStatus('ready');
  assert.deepEqual(await state(), {scope: 'project-a:plan', status: 'ready', data: {id: 'exact-declaration'}, error: null, errorCode: null});
});

test('first render in a new scope cannot inherit old missing-state error or use it as authority to create', async () => {
  await mount('project-a:plan');
  await resolve(0, {ok: false, error: {code: 'research_review_screening_plan_not_found', message: 'Old scope genuinely missing'}});
  await waitStatus('error');
  await page.evaluate(() => window.selectScope('project-b:plan'));
  await page.waitForFunction(() => window.calls.length === 2);
  const frames = await page.evaluate(() => window.frames.filter(frame => frame.scope === 'project-b:plan'));
  assert.ok(frames.length > 0);
  assert.ok(frames.every(frame => frame.error === null && frame.errorCode === null));
  assert.ok(frames.every(frame => frame.status === 'loading' && frame.data === null));
  await resolve(1, {ok: false, error: {code: 'research_review_screening_snapshot_invalid', message: 'New scope marked receipt corrupt'}});
  await waitStatus('error');
  assert.equal((await state()).errorCode, 'research_review_screening_snapshot_invalid');
  assert.equal((await state()).error, 'New scope marked receipt corrupt');
});

test('late prior request and uncoded transport failure never invent or restore a backend domain identity', async () => {
  await mount('project-a:plan');
  await page.evaluate(() => window.selectScope('project-b:plan')); await page.waitForFunction(() => window.calls.length === 2);
  await resolve(1, {ok: true, data: {id: 'current-b'}});
  await waitStatus('ready');
  await resolve(0, {ok: false, error: {code: 'research_review_screening_plan_not_found', message: 'Late obsolete failure'}});
  assert.deepEqual(await state(), {scope: 'project-b:plan', status: 'ready', data: {id: 'current-b'}, error: null, errorCode: null});
  await page.getByTestId('resource-reload').click(); await page.waitForFunction(() => window.calls.length === 3);
  await page.evaluate(() => window.pending[2].reject(new Error('Transport disconnected')));
  await waitStatus('error');
  assert.equal((await state()).error, 'Transport disconnected');
  assert.equal((await state()).errorCode, null);
  assert.equal((await state()).status, 'error');
});
