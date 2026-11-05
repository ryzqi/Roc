import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let directory, app, page;
const errors = [], requests = [];
const artifacts = resolve('.artifacts/research-optimization/xnb-a3-ui');
const clipAudit = readFileSync(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-notebook-ui-'));
  mkdirSync(artifacts, { recursive: true });
  await esbuild.build({
    stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import NotebookPreview from './src/renderer/canvas/files/NotebookPreview';
      const root = createRoot(document.getElementById('root'));
      window.makePreview = (sha256 = 'a'.repeat(64)) => ({
        schemaVersion:1, format:'nbformat-4.5', sha256, size:80000, language:'python', kernel:'python3',
        execution:'static', outputTrust:'untrusted', cells:[
          {id:'code-1',index:0,cellType:'code',sourceHash:'b'.repeat(64),cellHash:'c'.repeat(64),
            source:'%load_ext custom\\nprint(1)\\n',sourceCharacters:26,executionCount:9,
            reviewIssues:[{kind:'magic',line:1,detail:'requires review'}], attachments:[],
            outputs:[{index:0,kind:'display_data',mimeTypes:['text/html','application/javascript','image/svg+xml','text/plain'],
              text:'<img src="https://untrusted.invalid/asset" onerror="window.notebookExecuted=true"><script>window.notebookExecuted=true</script>',
              textCharacters:139,hash:'d'.repeat(64),trust:'untrusted'}]},
          {id:'markdown-1',index:1,cellType:'markdown',sourceHash:'e'.repeat(64),cellHash:'f'.repeat(64),
            source:'# Heading\\n<iframe src="https://untrusted.invalid/frame"></iframe>',sourceCharacters:69,executionCount:null,
            reviewIssues:[],attachments:[{name:'evil.svg',mimeTypes:['image/svg+xml'],hash:'f'.repeat(64)}],outputs:[]}
        ]
      });
      window.makeImported = (projectId = 'a', id = 'notebook-1', sha256 = 'a'.repeat(64), path = 'analysis.ipynb') => ({
        receipt:{snapshot:{schemaVersion:1,id,request:{projectId,path,requestId:'saved',expectedSha256:sha256},
          actor:{kind:'user',id:'window:72'},workspacePath:'/'+projectId,sha256,size:80000,recordedAt:'2026-11-06T00:00:00Z'},
          snapshotHash:'1'.repeat(64)}, preview:makePreview(sha256)
      });
      window.deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
      window.client = {api:{research:{
        getProject:request=>{calls.push({method:'project',request});return Promise.resolve(projectResponse);},
        previewNotebook:request=>{calls.push({method:'preview',request});return Promise.resolve(previewResponse);},
        listNotebooks:request=>{calls.push({method:'list',request});return Promise.resolve(typeof listResponse==='function'?listResponse(request):listResponse);},
        getNotebook:request=>{calls.push({method:'get',request});return Promise.resolve(getResponse);},
        importNotebook:request=>{calls.push({method:'import',request});return Promise.resolve(importResponse);}
      }}};
      window.mount = (projectId = 'a', writable = true) => flushSync(()=>root.render(
        React.createElement(React.StrictMode,null,React.createElement(NotebookPreview,{
          client,projectId,workspacePath:'/'+projectId,relativePath:'analysis.ipynb',writable,onClose:()=>window.closedPreview=true
        }))
      ));
      window.clear = () => flushSync(()=>root.render(null));
      window.reset = () => {
        clear(); window.calls=[];delete window.notebookExecuted;window.closedPreview=false;
        window.projectResponse={ok:true,data:{id:'a',workspacePath:'/a',status:'active'}};
        window.previewResponse={ok:true,data:makePreview()};
        window.listResponse={ok:true,data:{items:[],total:0}};
        window.getResponse={ok:true,data:makeImported()};
        window.importResponse={ok:true,data:makeImported()};
      }; reset();
    ` },
    outfile: join(directory, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  const cssRoot = resolve('dist/renderer/assets');
  writeFileSync(join(directory, 'ui.css'), readdirSync(cssRoot).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(cssRoot, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="ui.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    #root{height:620px}</style><div id="root"></div><script src="ui.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:680}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('https://untrusted.invalid')) requests.push(request.url()); });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try { await app?.close(); } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
});
const ready = () => page.getByTestId('file-notebook-cells').waitFor();
const importButton = () => page.getByTestId('file-notebook-import');
const openHistory = async () => {
  const history = page.getByTestId('file-notebook-history');
  await history.locator('summary').click();
  await history.locator('[data-testid="file-notebook-history-item"]').first().waitFor({ state: 'visible' });
};

test('untrusted code, Markdown, HTML, scripts, SVG and old outputs only create literal text nodes', async () => {
  await page.evaluate(() => { reset(); mount(); }); await ready();
  assert.match(await page.getByTestId('file-notebook-source').first().innerText(), /%load_ext/u);
  assert.match(await page.getByTestId('file-notebook-output').innerText(), /<script>window.notebookExecuted=true<\/script>/u);
  await page.getByTestId('file-notebook-cell').nth(1).locator('summary').first().click();
  await page.getByTestId('file-notebook-source').nth(1).waitFor({ state: 'visible' });
  assert.match(await page.getByTestId('file-notebook-source').nth(1).innerText(), /<iframe/u);
  assert.equal(await page.locator('#root script,#root iframe,#root img,#root svg[onload]').count(), 0);
  assert.equal(await page.evaluate(() => window.notebookExecuted), undefined);
  assert.match(await page.getByTestId('file-notebook-review').innerText(), /第 1 行 magic/u);
  await page.getByTestId('file-notebook-cell-origin').first().locator('summary').click();
  await page.getByTestId('file-notebook-cell-origin').first().locator('p').first().waitFor({ state: 'visible' });
  assert.match(await page.getByTestId('file-notebook-cell-origin').first().innerText(), /bbbbbbbbbbbbbbbb/u);
});

test('keyboard import freezes the preview hash, waits for the real response and refreshes server history', async () => {
  await page.evaluate(() => { reset(); window.held=deferred(); importResponse=held.promise; mount(); }); await ready();
  await importButton().focus(); await page.keyboard.press('Enter');
  await page.getByText('导入中…', { exact: true }).waitFor();
  assert.equal(await importButton().isDisabled(), true);
  assert.equal(await page.getByTestId('file-notebook-frozen').count(), 0);
  await page.evaluate(() => {
    listResponse={ok:true,data:{items:[makeImported().receipt],total:1}};
    held.resolve({ok:true,data:makeImported()});
  });
  await page.getByTestId('file-notebook-frozen').waitFor(); await ready();
  await openHistory();
  const request = await page.evaluate(() => calls.find(call=>call.method==='import').request);
  assert.deepEqual(Object.keys(request).sort(), ['expectedSha256','path','projectId','requestId']);
  assert.equal(request.expectedSha256, 'a'.repeat(64)); assert.match(request.requestId, /^[a-f0-9-]{36}$/u);
  assert.equal(await page.getByTestId('file-notebook-history-item').count(), 1);
  await importButton().click();
  const requests = await page.evaluate(() => calls.filter(call=>call.method==='import').map(call=>call.request));
  assert.notEqual(requests[0].requestId, requests[1].requestId);
});

test('changed and missing current files keep exact frozen history readable; corrupted reads fail visibly', async () => {
  await page.evaluate(() => {
    reset(); previewResponse={ok:true,data:makePreview('9'.repeat(64))};
    listResponse={ok:true,data:{items:[makeImported().receipt],total:1}}; mount();
  }); await ready(); await openHistory();
  await page.getByTestId('file-notebook-history-item').click();
  await page.getByTestId('file-notebook-source-changed').waitFor();
  assert.match(await page.getByTestId('file-notebook-source').first().innerText(), /print\(1\)/u);
  await page.evaluate(() => { previewResponse={ok:false,error:{message:'ENOENT'}}; });
  await page.getByRole('button', { name: '重新读取 Notebook' }).click();
  await page.getByText('当前文件无法读取，导入版本保持可读。', { exact: true }).waitFor();
  assert.equal(await importButton().isDisabled(), true); await ready();
  await page.evaluate(() => { getResponse={ok:false,error:{message:'research_notebook_bytes_invalid'}}; });
  await page.getByRole('button', { name: '重新读取 Notebook' }).click();
  await page.getByRole('alert').filter({ hasText: 'research_notebook_bytes_invalid' }).waitFor();
});

test('project changes discard pending old reads and imports; archived or mismatched scopes cannot import', async () => {
  await page.evaluate(() => { reset(); window.old=deferred(); previewResponse=old.promise; mount(); });
  await page.getByText('读取 Notebook 中…', { exact: true }).waitFor();
  await page.evaluate(() => {
    projectResponse={ok:true,data:{id:'b',workspacePath:'/b',status:'active'}};previewResponse={ok:true,data:makePreview('9'.repeat(64))};
    mount('b');old.resolve({ok:true,data:makePreview()});
  }); await ready();
  assert.equal(await page.getByTestId('file-notebook-source-changed').count(), 0);
  await page.evaluate(() => { window.oldImport=deferred();importResponse=oldImport.promise; }); await importButton().click();
  await page.getByText('导入中…', { exact: true }).waitFor();
  await page.evaluate(() => {
    projectResponse={ok:true,data:{id:'c',workspacePath:'/c',status:'archived'}};mount('c',false);
    oldImport.resolve({ok:true,data:makeImported('b','notebook-b','9'.repeat(64))});
  }); await ready();
  assert.equal(await page.getByTestId('file-notebook-frozen').count(), 0);
  assert.equal(await importButton().isDisabled(), true);
  await page.evaluate(() => { reset();projectResponse.data.workspacePath='/foreign';mount(); });
  await page.getByRole('alert').filter({ hasText: 'research_notebook_workspace_changed' }).waitFor();
  assert.equal(await importButton().isDisabled(), true);
});

test('history pagination only fetches selected source and import failures never manufacture a saved version', async () => {
  await page.evaluate(() => {
    reset();
    listResponse=request=>({ok:true,data:{items:[makeImported('a','notebook-'+request.offset).receipt],total:21}});
    importResponse={ok:false,error:{message:'research_notebook_source_changed'}};mount();
  }); await ready(); await openHistory();
  assert.equal(await page.evaluate(() => calls.filter(call=>call.method==='get').length), 0);
  await page.getByRole('button', { name: '下一页' }).click();
  await page.waitForFunction(() => calls.some(call=>call.method==='list'&&call.request.offset===20));
  await page.evaluate(() => { getResponse={ok:true,data:makeImported('a','notebook-20')}; });
  await page.getByTestId('file-notebook-history-item').click(); await ready();
  const get = await page.evaluate(() => calls.find(call=>call.method==='get').request);
  assert.equal(get.notebookId, 'notebook-20'); assert.equal(get.expectedHash, '1'.repeat(64));
  await page.getByRole('button', { name: '当前文件', exact: true }).click();
  await importButton().click();
  await page.getByRole('alert').filter({ hasText: 'research_notebook_source_changed' }).waitFor();
  assert.equal(await page.getByTestId('file-notebook-frozen').count(), 0);
  await page.evaluate(() => { importResponse={ok:true,data:makeImported('foreign')}; });
  await importButton().click();
  await page.getByRole('alert').filter({ hasText: 'research_notebook_import_identity_mismatch' }).waitFor();
  assert.equal(await page.getByTestId('file-notebook-frozen').count(), 0);
});

test('long source and provenance fit narrow light and dark windows with focus and zero cut shadows', async () => {
  await page.evaluate(() => {
    reset(); previewResponse.data.cells[0].source='x'.repeat(8000);previewResponse.data.cells[0].sourceCharacters=90000;
    listResponse={ok:true,data:{items:[makeImported().receipt],total:1}};mount();
  }); await ready();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 680));
  const audit = { default: await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`) };
  assert.equal(audit.default.cut, 0);
  await openHistory(); await page.getByTestId('file-notebook-cell-origin').first().locator('summary').click();
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme=theme, theme);
    await importButton().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.notEqual(await importButton().evaluate(button=>getComputedStyle(button).outlineStyle), 'none');
    await importButton().hover();
    await page.getByTestId('file-notebook-history').evaluate(async element =>
      Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished)));
    audit[theme] = await page.evaluate(`(${clipAudit})({root:'#root',viewport:true})`);
    assert.equal(audit[theme].cut, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth), true);
    assert.match(await page.getByTestId('file-notebook-scroll').innerText(), /源码预览 8000\/90000/u);
    await page.screenshot({ path: join(artifacts, theme+'.png') });
  }
  writeFileSync(join(artifacts,'clip-audit.json'),JSON.stringify(audit,null,2));
});
