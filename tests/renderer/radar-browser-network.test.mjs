import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, artifacts, app, page, auditSource;
const errors = [];
const coolUrl = 'https://papers.cool/arxiv/cs.AI';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-radar-network-'));
  await mkdir(join(process.cwd(), '.artifacts'), {recursive: true});
  artifacts = await mkdtemp(join(process.cwd(), '.artifacts/radar-network-'));
  auditSource = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import RadarBrowser from './src/renderer/literature/RadarBrowser';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    const root=createRoot(document.getElementById('root'));
    window.receipts=[];
    const client={api:{research:{radarBrowser:async input=>{
      const result=await window.nativeRadar.run(input);
      window.receipts.push({input,result});return result;
    }}}};
    function Browser(){
      const [source,setSource]=useState('cool');
      return <ViewActivity active><div style={{height:700,display:'flex',flexDirection:'column'}}>
        <button type="button" onClick={()=>setSource('modelscope')}>切换魔搭论文</button>
        <RadarBrowser key={source} client={client} source={source} active projectId="radar-fixture"
          writable onImported={()=>{}}/>
      </div></ViewActivity>;
    }
    window.mountRadar=()=>{window.receipts=[];flushSync(()=>root.render(<Browser/>));};
    window.clearRadar=()=>flushSync(()=>root.render(null));
  `, style: 'html,body{margin:0}body{padding:16px;background:var(--bg);color:var(--ink)}'});
  await writeFile(join(directory, 'preload.cjs'), `
    const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('nativeRadar',{
      run:input=>ipcRenderer.invoke('roc:research:radar-browser',input)
    });
  `);
  await build({
    stdin: {resolveDir: process.cwd(), contents: `
      import {app,BrowserWindow,ipcMain,session} from 'electron';
      import {registerRadarBrowserIpc} from './src/main/ipc/radar-browser-ipc';
      app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
      app.whenReady().then(async()=>{
        const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{
          preload:${JSON.stringify(join(directory, 'preload.cjs'))},
          sandbox:true,contextIsolation:true,nodeIntegration:false
        }});
        registerRadarBrowserIpc((channel,handler)=>ipcMain.handle(channel,handler),window);
        globalThis.radarFixture={mode:'fail',requests:[],pending:[]};
        session.fromPartition('radar-'+window.id).protocol.handle('https',request=>{
          const fixture=globalThis.radarFixture;
          fixture.requests.push(request.url);
          const success=()=>new Response('<!doctype html><title>Recovered radar page</title>'+
            '<article class="paper"><h2>Recovered paper</h2>'+
            '<a href="https://arxiv.org/abs/2611.00001">Paper</a></article>',
            {headers:{'content-type':'text/html'}});
          if(new URL(request.url).hostname!=='papers.cool')return success();
          if(fixture.mode==='fail')return Response.error();
          if(fixture.mode==='hold')return new Promise(resolve=>fixture.pending.push(fail=>
            resolve(fail?Response.error():success())));
          return success();
        });
        await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
      });
    `},
    outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], logLevel: 'silent'
  });
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mountRadar === 'function');
});

after(async () => {
  try {
    if (page) await page.screenshot({path: join(artifacts, 'last-state.png')}).catch(() => {});
    await page?.evaluate(() => clearRadar()).catch(() => {});
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
  console.log(`Radar network screenshots: ${artifacts}`);
});

const nativeState = () => app.evaluate(({BrowserWindow}) => {
  const window = BrowserWindow.getAllWindows()[0];
  return window.contentView.children
    .filter(view => view.webContents && view.webContents !== window.webContents)
    .map(view => ({url: view.webContents.getURL(), visible: view.getVisible()}));
});
const mode = value => app.evaluate((_, value) => {globalThis.radarFixture.mode = value;}, value);
const release = fail => app.evaluate((_, fail) => {
  for (const finish of globalThis.radarFixture.pending.splice(0)) finish(fail);
}, fail);
async function mount(value) {
  await page.evaluate(() => clearRadar());
  await release(true);
  await mode(value);
  await page.evaluate(async () => {
    const bounds = {x: 0, y: 0, width: 0, height: 0};
    await window.nativeRadar.run({action: 'open', source: 'modelscope', bounds});
    await window.nativeRadar.run({action: 'hide', source: 'modelscope', bounds});
  });
  await page.evaluate(() => mountRadar());
}
const receipt = action => page.evaluate(action =>
  window.receipts.findLast(receipt => receipt.input.action === action)?.result, action);

test('native navigation failure is actionable and hides the failed page', async () => {
  await mount('fail');
  await expect.poll(() => receipt('open')).toMatchObject({
    ok: false, error: {code: 'radar_browser_load_failed', category: 'external', retryable: true}
  });
  await expect(page.getByRole('alert')).toContainText('Cool Papers');
  await expect(page.getByRole('alert')).not.toContainText('Roc 内部错误');
  await expect(page.getByText('正在加载 Cool Papers…', {exact: true})).toHaveCount(0);
  await expect.poll(nativeState).toMatchObject([{visible: false}]);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    const audit = await page.evaluate(source => (0, eval)(source)({root: 'body', viewport: true}), auditSource);
    assert.equal(audit.cut, 0, `${theme} error state must not clip`);
    await page.screenshot({path: join(artifacts, `load-error-${theme}.png`)});
  }
});

test('refresh retries the failed URL and waits for the real native load result', async () => {
  await mount('fail');
  await expect(page.getByRole('alert')).toBeVisible();
  await mode('hold');
  await page.getByRole('button', {name: '刷新网页', exact: true}).focus();
  await expect(page.getByRole('button', {name: '刷新网页', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  await expect(page.getByRole('button', {name: '刷新网页', exact: true})).toBeDisabled();
  assert.equal(await receipt('reload'), undefined, 'refresh cannot succeed before its navigation');
  await release(false);
  await expect.poll(() => receipt('reload')).toMatchObject({ok: true, data: {url: coolUrl}});
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', {name: '刷新网页', exact: true})).toBeEnabled();
  await expect.poll(nativeState).toMatchObject([{url: coolUrl, visible: true}]);
  const isolation = await app.evaluate(async ({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(view =>
      view.webContents && view.webContents !== window.webContents);
    return view.webContents.executeJavaScript(
      '({title:document.title,node:typeof require,bridge:typeof window.roc})');
  });
  assert.deepEqual(isolation, {title: 'Recovered radar page', node: 'undefined', bridge: 'undefined'});
  await page.getByRole('button', {name: '读取当前页论文 / 入库', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Recovered paper', exact: true})).toBeVisible();
  await expect.poll(nativeState).toMatchObject([{visible: false}]);
});

test('refresh during the initial load waits for its own navigation rather than the canceled load', async () => {
  await mount('hold');
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  await page.getByRole('button', {name: '刷新网页', exact: true}).click();
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(2);
  assert.equal(await receipt('reload'), undefined, 'a canceled old load cannot complete the new refresh');
  await expect(page.getByRole('button', {name: '刷新网页', exact: true})).toBeDisabled();
  await release(false);
  await expect.poll(() => receipt('reload')).toMatchObject({ok: true, data: {url: coolUrl}});
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(nativeState).toMatchObject([{url: coolUrl, visible: true}]);
});

test('a failed refresh of a loaded page reports the failure and retains the URL for retry', async () => {
  await mount('success');
  await expect.poll(() => receipt('open')).toMatchObject({ok: true, data: {url: coolUrl}});
  await mode('hold');
  await page.getByRole('button', {name: '刷新网页', exact: true}).click();
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  assert.equal(await receipt('reload'), undefined);
  await release(true);
  await expect.poll(() => receipt('reload')).toMatchObject({
    ok: false, error: {code: 'radar_browser_load_failed', category: 'external', retryable: true}
  });
  await expect(page.getByRole('alert')).toContainText('Cool Papers');
  await expect(page.getByText('正在加载 Cool Papers…', {exact: true})).toHaveCount(0);
  await expect.poll(nativeState).toMatchObject([{visible: false}]);
  await mode('success');
  await page.getByRole('button', {name: '刷新网页', exact: true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(nativeState).toMatchObject([{url: coolUrl, visible: true}]);
});

test('a failed back navigation reports its result and retries the history destination', async () => {
  await mount('success');
  await expect.poll(() => receipt('open')).toMatchObject({ok: true});
  await app.evaluate(async ({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(view =>
      view.webContents && view.webContents !== window.webContents);
    await view.webContents.loadURL('https://papers.cool/arxiv/cs.LG');
  });
  await mode('hold');
  await page.getByRole('button', {name: '后退', exact: true}).click();
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  assert.equal(await receipt('back'), undefined);
  await release(true);
  await expect.poll(() => receipt('back')).toMatchObject({
    ok: false, error: {code: 'radar_browser_load_failed', category: 'external'}
  });
  await expect.poll(nativeState).toMatchObject([{visible: false}]);
  await mode('success');
  await page.getByRole('button', {name: '刷新网页', exact: true}).click();
  await expect.poll(() => receipt('reload')).toMatchObject({ok: true, data: {url: coolUrl}});
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('blocked cross-origin navigation cannot change the refresh destination', async () => {
  await mount('success');
  await expect.poll(() => receipt('open')).toMatchObject({ok: true});
  const attempt = await app.evaluate(async ({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.find(view =>
      view.webContents && view.webContents !== window.webContents);
    const attempted = new Promise(resolve => view.webContents.once('will-navigate',
      (event, url) => resolve({url, blocked: event.defaultPrevented})));
    await view.webContents.executeJavaScript(`(() => {
      const link=document.createElement('a');link.href='https://outside.example/paper';
      document.body.append(link);link.click();
    })()`);
    return attempted;
  });
  assert.deepEqual(attempt, {url: 'https://outside.example/paper', blocked: true});
  await mode('hold');
  await page.getByRole('button', {name: '刷新网页', exact: true}).click();
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  const requested = await app.evaluate(() => globalThis.radarFixture.requests.at(-1));
  assert.equal(requested, coolUrl);
  await release(false);
  await expect.poll(() => receipt('reload')).toMatchObject({ok: true, data: {url: coolUrl}});
});

test('a resize while loading cannot discard the initial navigation failure', async () => {
  await mount('hold');
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
  await page.waitForFunction(() => window.receipts.some(receipt => receipt.input.action === 'bounds'));
  await release(true);
  await expect(page.getByRole('alert')).toContainText('Cool Papers');
  await expect(page.getByRole('alert')).not.toContainText('Roc 内部错误');
  await expect.poll(nativeState).toMatchObject([{visible: false}]);
});

test('switching sources cancels an old native load without an internal error', async () => {
  await mount('hold');
  await expect.poll(() => app.evaluate(() => globalThis.radarFixture.pending.length)).toBe(1);
  await page.getByRole('button', {name: '切换魔搭论文', exact: true}).click();
  await expect.poll(nativeState).toMatchObject([{url: 'https://modelscope.cn/papers', visible: true}]);
  await release(true);
  await expect.poll(() => page.evaluate(() => window.receipts
    .find(receipt => receipt.input.action === 'open' && receipt.input.source === 'cool')?.result))
    .toMatchObject({ok: true});
  await expect(page.getByRole('alert')).toHaveCount(0);
});
