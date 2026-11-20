import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {_electron, chromium, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-p5-literature-processing-'));
  await buildViteRenderer({directory, plugins: [tailwindcss()], script: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LiteratureProcessingPanel} from './src/renderer/literature/LiteratureProcessingPanel';
    import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    import './src/renderer/styles/index.css';
    const root = createRoot(document.getElementById('root'));
    const ok = data => ({ok:true, data});
    window.job = (id='a', overrides={}) => ({id:'job-'+id, projectId:'project-a', libraryItemId:'item-'+id,
      title:'Paper '+id, generation:'generation-'+id, stage:'resolve', status:'queued', attempts:0,
      nextRetryAt:null, documentId:null, receipt:null, errorCode:null, updatedAt:'2026-11-19T00:00:00.000Z', ...overrides});
    window.pdf = {id:'receipt-a', generation:'generation-a', sha256:'a'.repeat(64), bytes:100,
      sourceUrl:'https://example.invalid/a.pdf',provider:'synthetic',version:'published',license:null,
      doi:null,arxivId:null,relativePath:'.roc/literature/a.pdf',acquiredAt:'2026-11-19T00:00:00.000Z'};
    const listeners = new Set();
    function call(method,input,data) {
      calls.push({method,input});
      if(held.has(method)) return new Promise(resolve=>pending.push({method,resolve}));
      return Promise.resolve(ok(data));
    }
    const client = {api:{research:{
      listAcquisition: input => call('listAcquisition',input, response(input)),
      acquisitionSettings: input => call('acquisitionSettings',input,{versionPreference:'balanced',unpaywallEmail:null}),
      saveAcquisitionSettings: input => call('saveAcquisitionSettings',input,input),
      retryAcquisition: input => call('retryAcquisition',input,job(input.jobId.slice(4),{generation:'generation-new',documentId:input.replacementDocumentId??null})),
      cancelAcquisition: input => call('cancelAcquisition',input,job(input.jobId.slice(4),{status:'cancelled'})),
      listLibrary: async () => ok([]),
      wikiSnapshot: async () => ok({sources:[]}),
      importDocument: input => call('importDocument',input,{id:'manual-document'}),
      onLibraryChanged: listener => {listeners.add(listener); return ()=>listeners.delete(listener);}
    }}};
    window.clear = () => flushSync(()=>root.render(null));
    window.renderPanel = () => flushSync(()=>root.render(<ViewActivity active={active}>
      <LiteratureProcessingPanel client={client} projectId={projectId} writable={writable}
        pickFile={async()=>{const result=await call('pickFile',{},pickedPath);return result.data;}}
        addPdfToItem={async input=>{const result=await call('addPdfToItem',input,importOutcome);return result.data;}}
        onOpenPdf={path=>calls.push({method:'openPdf',input:path})}
        onOpenItem={id=>calls.push({method:'openItem',input:id})}
        onDocumentsChanged={()=>calls.push({method:'documentsChanged'})}/>
    </ViewActivity>));
    window.mount = (options={}) => {
      clear(); window.calls=[]; window.pending=[]; window.held=new Set();
      window.projectId='project-a';window.writable=true;window.active=true;window.pickedPath='/synthetic/manual.PDF';
      window.importOutcome={ok:true,createdCount:1,duplicateCount:0,documentId:'manual-document'};
      window.response=()=>({jobs:[job('a',{stage:'index',status:'blocked',documentId:'document-a',receipt:pdf,
        errorCode:'embedding_unconfigured',nextRetryAt:'2026-11-19T01:00:00Z'}),job('b',{stage:'wiki',status:'ready',documentId:'document-b'})],total:22,nextOffset:20});
      if(options.empty) window.response=()=>({jobs:[],total:0,nextOffset:null});
      if(options.readonly) window.writable=false;
      renderPanel();
    };
    function StoreProbe() {window.literatureStore=useLiteratureStore(client,projectId);return null;}
    window.mountStore=()=>{mount();clear();flushSync(()=>root.render(<StoreProbe/>));};
    window.resolveNext = (method,result) => {
      const index=pending.findIndex(entry=>entry.method===method);
      if(index<0)throw new Error('No pending '+method);
      pending.splice(index,1)[0].resolve(result);
    };
    window.libraryChanged = project => {for(const listener of listeners) listener({affectedProjectIds:[project]});};
    window.listenerCount = () => listeners.size;
  `, style: 'html,body,#root{margin:0;min-height:100%}body{background:var(--bg);color:var(--ink)}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:700})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  // Explicit component-only mode is useful when Electron is absent. Never silently substitute it
  // for the default Electron check: neither mode claims to exercise the real preload/IPC bridge.
  if (process.env.ROC_P5_BROWSER_ONLY === '1') {
    console.info('P5 component fixture: Chromium only (Electron and real IPC not exercised).');
    app = await chromium.launch({headless: true, executablePath: process.env.ROC_P5_BROWSER_EXECUTABLE,
      args: ['--allow-file-access-from-files']});
    page = await app.newPage({viewport: {width: 1000, height: 700}});
    await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  } else {
    const {default: electronPath} = await import('electron');
    app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
    page = await app.firstWindow();
  }
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  await page?.evaluate(() => clear()).catch(() => {});
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

const count = method => page.evaluate(method => calls.filter(call => call.method === method).length, method);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const toggle = () => page.getByRole('button', {name: '文献处理', exact: true});
async function mount(options) {
  await page.evaluate(options => mount(options), options);
  await expect(page.getByRole('status').first()).toContainText(options?.empty ? '暂无任务' : '共 22 篇任务');
}
async function expand() {await toggle().click();}

test('progress is page-local and truthful, with keyboard disclosure, exact stage/errors and existing document actions', async () => {
  await mount();
  await expect(page.getByLabel('本页处理概况')).toBeHidden();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await toggle().focus(); await page.keyboard.press('Enter');
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('本页处理概况')).toHaveText('元数据 2 篇PDF 2 篇全文索引 1 篇知识库 1 篇');
  await expect(page.getByText('全文索引：受阻', {exact: true})).toBeVisible();
  await expect(page.getByText('错误：embedding_unconfigured', {exact: true})).toBeVisible();
  await expect(page.getByText('计划重试：2026-11-19T01:00:00Z', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: '打开 PDF：Paper a', exact: true}).click();
  await page.getByRole('button', {name: 'Paper a', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => calls.filter(call => ['openPdf','openItem'].includes(call.method))), [
    {method: 'openPdf', input: '.roc/literature/a.pdf'}, {method: 'openItem', input: 'item-a'}
  ]);
  assert.equal(await page.getByRole('button', {name: '取消处理：Paper b', exact: true}).count(), 0);
});

test('acquisition preferences save explicit consent and receipt shows actual version/license at desktop size', async () => {
  await mount(); await expand();
  await page.getByRole('button', {name:'获取偏好', exact:true}).click();
  await page.getByLabel('PDF 版本偏好').selectOption('published');
  await page.getByLabel('Unpaywall 联系邮箱（可选）').fill('contact@example.org');
  await page.getByRole('button', {name:'保存获取偏好', exact:true}).click();
  await expect(page.getByText('获取偏好已保存。')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => calls.find(call=>call.method==='saveAcquisitionSettings').input),
    {versionPreference:'published',unpaywallEmail:'contact@example.org'});
  await expect(page.getByText('全文来源：synthetic，版本：正式发表版，许可证：未标注')).toBeVisible();
  await page.setViewportSize({width:1000,height:700});
  if (process.env.ROC_P5_SCREENSHOT_DIR) {
    const {mkdir} = await import('node:fs/promises');
    await mkdir(process.env.ROC_P5_SCREENSHOT_DIR, {recursive:true});
  }
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
    if (process.env.ROC_P5_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.ROC_P5_SCREENSHOT_DIR,'acquisition-'+theme+'.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
});

test('retry prevents duplicate writes, sends exact generation and refreshes after conflict without replay', async () => {
  await mount(); await expand();
  await page.evaluate(() => {
    held.add('retryAcquisition'); const button=document.querySelector('[aria-label="重试处理：Paper a"]');
    button.click();button.click();
  });
  assert.equal(await count('retryAcquisition'), 1);
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'retryAcquisition').input),
    {projectId: 'project-a', destination: 'current_project', jobId: 'job-a', generation: 'generation-a'});
  await expect(page.getByRole('button', {name: '手动补充 PDF：Paper a', exact: true})).toBeDisabled();
  const reads = await count('listAcquisition');
  await page.evaluate(() => resolveNext('retryAcquisition', {ok:false,error:{code:'research_acquisition_generation_conflict',message:'Generation changed. Refresh required.'}}));
  await expect(page.getByRole('alert')).toHaveText('Generation changed. Refresh required.');
  await expect.poll(() => count('listAcquisition')).toBeGreaterThan(reads);
  assert.equal(await count('retryAcquisition'), 1);
  await expect(page.getByRole('button', {name: '重试处理：Paper a', exact: true})).toBeEnabled();
});

test('successful retry reports background acceptance and cancellation respects returned state', async () => {
  await mount(); await expand();
  await page.evaluate(() => {
    response=()=>({jobs:[job('a',{generation:'generation-new'})],total:1,nextOffset:null});
  });
  await page.getByRole('button', {name: '重试处理：Paper a', exact: true}).click();
  await expect(page.getByRole('status').filter({hasText:'已提交后台重试'})).toBeVisible();
  await expect(page.getByText('查找 PDF：后台排队中', {exact:true})).toBeVisible();
  await page.evaluate(() => {held.add('cancelAcquisition');});
  await page.getByRole('button', {name: '取消处理：Paper a', exact:true}).click();
  assert.equal(await count('cancelAcquisition'), 1);
  await page.evaluate(() => resolveNext('cancelAcquisition',{ok:false,error:{message:'Cancellation rejected'}}));
  await expect(page.getByRole('alert')).toHaveText('Cancellation rejected');
  await expect(page.getByText('查找 PDF：后台排队中', {exact:true})).toBeVisible();
  await page.evaluate(() => {held.delete('cancelAcquisition');response=()=>({jobs:[job('a',{status:'cancelled'})],total:1,nextOffset:null});});
  await page.getByRole('button', {name: '取消处理：Paper a', exact:true}).click();
  await expect(page.getByText('查找 PDF：已取消', {exact:true})).toBeVisible();
});

test('manual PDF supplement retries the exact job with the imported document and reports acceptance only after success', async () => {
  await mount(); await expand();
  await page.evaluate(() => held.add('retryAcquisition'));
  await page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true}).click();
  await expect.poll(() => count('retryAcquisition')).toBe(1);
  await expect(page.getByRole('status').filter({hasText:'已提交后台重试'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true})).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'addPdfToItem').input),
    {sourcePath:'/synthetic/manual.PDF',libraryItemId:'item-a'});
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'retryAcquisition').input),
    {projectId:'project-a',destination:'current_project',jobId:'job-a',generation:'generation-a',replacementDocumentId:'manual-document'});
  await page.evaluate(() => resolveNext('retryAcquisition',{ok:true,data:job('a',{generation:'generation-new',documentId:'manual-document'})}));
  await expect(page.getByRole('status').filter({hasText:'PDF 已补充，已提交后台重试'})).toBeVisible();
  await page.evaluate(() => {pickedPath=null;});
  await page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true}).click();
  await expect(page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true})).toBeEnabled();
  assert.equal(await count('addPdfToItem'), 1);
  await page.evaluate(() => {pickedPath='/synthetic/not-a-pdf.txt';});
  await page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('请选择 PDF 文件。');
  assert.equal(await count('addPdfToItem'), 1);
  assert.equal(await count('retryAcquisition'), 1);
});

test('real literature store returns the attached document ID for replacement retry', async () => {
  await page.evaluate(() => mountStore());
  await page.waitForFunction(() => literatureStore.status === 'ready');
  const result=await page.evaluate(() => literatureStore.addPdfToItem({sourcePath:'/synthetic/manual.PDF',libraryItemId:'item-a'}));
  assert.deepEqual(result,{ok:true,createdCount:1,duplicateCount:0,documentId:'manual-document'});
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'importDocument').input),
    {target:'library-item',sourcePath:'/synthetic/manual.PDF',libraryItemId:'item-a',projectId:'project-a'});
});

test('failed import or a missing returned document ID cannot retry the old PDF or claim queued work', async () => {
  for (const [outcome,message] of [
    [{ok:false,message:'PDF import rejected'},'PDF import rejected'],
    [{ok:true,createdCount:1,duplicateCount:0},'PDF 已补充，但未返回文档 ID，未提交后台重试。']
  ]) {
    await mount(); await expand();
    await page.evaluate(value => {importOutcome=value;},outcome);
    await page.getByRole('button',{name:'手动补充 PDF：Paper a',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveText(message);
    assert.equal(await count('retryAcquisition'),0);
    await expect(page.getByRole('status').filter({hasText:'已提交后台重试'})).toHaveCount(0);
  }
});

test('replacement retry failure refreshes progress and preserves the import without claiming queued work or replaying', async () => {
  await mount(); await expand();
  await page.evaluate(() => held.add('retryAcquisition'));
  const reads=await count('listAcquisition'),changed=await count('documentsChanged');
  await page.getByRole('button',{name:'手动补充 PDF：Paper a',exact:true}).click();
  await expect.poll(() => count('retryAcquisition')).toBe(1);
  await expect.poll(() => count('documentsChanged')).toBeGreaterThan(changed);
  await page.evaluate(() => resolveNext('retryAcquisition',{ok:false,error:{code:'literature_acquisition_changed',message:'Replacement retry rejected'}}));
  await expect(page.getByRole('alert')).toHaveText('Replacement retry rejected');
  await expect(page.getByRole('status').filter({hasText:'已提交后台重试'})).toHaveCount(0);
  await expect.poll(() => count('listAcquisition')).toBeGreaterThan(reads);
  assert.equal(await count('retryAcquisition'),1);
  assert.equal(await count('addPdfToItem'),1);
});

test('project switch, unmount or readonly transition during PDF import prevents the follow-up replacement retry', async () => {
  for (const transition of ['project','unmount','readonly']) {
    await mount(); await expand();
    await page.evaluate(() => held.add('addPdfToItem'));
    await page.getByRole('button',{name:'手动补充 PDF：Paper a',exact:true}).click();
    await expect.poll(() => count('addPdfToItem')).toBe(1);
    await page.evaluate(transition => {
      if(transition==='project') {projectId='project-b';response=()=>({jobs:[],total:0,nextOffset:null});renderPanel();}
      else if(transition==='unmount') clear();
      else {writable=false;renderPanel();}
      resolveNext('addPdfToItem',{ok:true,data:{ok:true,createdCount:1,duplicateCount:0,documentId:'manual-document'}});
    },transition);
    await settle();
    assert.equal(await count('retryAcquisition'),0,transition);
  }
});

test('a cancellation race reports the authoritative ready state instead of claiming cancellation', async () => {
  await mount(); await expand();
  await page.evaluate(() => held.add('cancelAcquisition'));
  await page.getByRole('button',{name:'取消处理：Paper a',exact:true}).click();
  await page.evaluate(() => {
    const ready=job('a',{stage:'wiki',status:'ready',documentId:'document-a'});
    response=()=>({jobs:[ready],total:1,nextOffset:null});
    resolveNext('cancelAcquisition',{ok:true,data:ready});
  });
  await expect(page.getByRole('status').filter({hasText:'取消请求已处理'})).toHaveText('取消请求已处理，当前状态：已就绪。已生成的文件保留。');
  await expect(page.getByText('生成 Wiki：已就绪',{exact:true})).toBeVisible();
});

test('project switch fences a pending native picker and late query responses', async () => {
  await mount(); await expand();
  await page.evaluate(() => {held.add('pickFile');});
  await page.getByRole('button', {name: '手动补充 PDF：Paper a', exact:true}).click();
  await page.evaluate(() => {projectId='project-b';response=()=>({jobs:[],total:0,nextOffset:null});renderPanel();});
  await expect(page.getByRole('status').first()).toContainText('暂无任务');
  await page.evaluate(() => resolveNext('pickFile',{ok:true,data:'/synthetic/old.pdf'}));
  await settle();
  assert.equal(await count('addPdfToItem'), 0);
  assert.equal(await page.getByRole('button', {name:'Paper a',exact:true}).count(), 0);
  await page.evaluate(() => {
    held.add('listAcquisition');projectId='project-a';renderPanel();
  });
  await expect.poll(() => page.evaluate(() => pending.filter(call => call.method==='listAcquisition').length)).toBe(1);
  await page.evaluate(() => {held.delete('listAcquisition');projectId='project-b';renderPanel();});
  await expect(page.getByRole('status').first()).toContainText('暂无任务');
  await page.evaluate(() => resolveNext('listAcquisition',{ok:true,data:{jobs:[job()],total:1,nextOffset:null}}));
  await settle();
  await expect(page.getByRole('status').first()).toContainText('暂无任务');
});

test('unmount ignores a late mutation result and unsubscribes from project changes', async () => {
  await mount(); await expand();
  assert.equal(await page.evaluate(() => listenerCount()), 1);
  await page.evaluate(() => held.add('retryAcquisition'));
  await page.getByRole('button', {name:'重试处理：Paper a',exact:true}).click();
  const before = await count('listAcquisition'), changed = await count('documentsChanged');
  await page.evaluate(() => {clear();resolveNext('retryAcquisition',{ok:true,data:job('a',{generation:'generation-new'})});libraryChanged('project-a');});
  await settle();
  assert.equal(await page.evaluate(() => listenerCount()), 0);
  assert.equal(await count('listAcquisition'), before);
  assert.equal(await count('documentsChanged'), changed);
});

test('readonly project permits document navigation and disables all mutations, including after a held picker', async () => {
  await mount({readonly:true}); await expand();
  for (const name of ['重试处理：Paper a','取消处理：Paper a','手动补充 PDF：Paper a']) {
    await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
  }
  await page.getByRole('button',{name:'打开 PDF：Paper a',exact:true}).click();
  assert.equal(await count('openPdf'),1);
  await mount(); await expand();
  await page.evaluate(() => held.add('pickFile'));
  await page.getByRole('button',{name:'手动补充 PDF：Paper a',exact:true}).click();
  await page.evaluate(() => {writable=false;renderPanel();resolveNext('pickFile',{ok:true,data:'/synthetic/manual.pdf'});});
  await settle();
  assert.equal(await count('addPdfToItem'),0);
});

test('pagination is bounded and project-specific events discover jobs on an empty page', async () => {
  await mount(); await expand();
  await page.evaluate(() => {response=input=>({jobs:[job('c')],total:22,nextOffset:input.offset===0?20:null});});
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('button',{name:'Paper c',exact:true})).toBeVisible();
  assert.deepEqual(await page.evaluate(() => calls.filter(call=>call.method==='listAcquisition').at(-1).input),
    {projectId:'project-a',destination:'current_project',offset:20,limit:20});
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  await expect(page.getByText('第 1 页',{exact:true})).toBeVisible();
  await mount({empty:true});
  const reads = await count('listAcquisition');
  await page.evaluate(() => libraryChanged('project-b')); await settle();
  assert.equal(await count('listAcquisition'),reads);
  await page.evaluate(() => {response=()=>({jobs:[job()],total:1,nextOffset:null});libraryChanged('project-a');});
  await expect(page.getByRole('status').first()).toContainText('共 1 篇任务');
});

test('light/dark and narrow canvas retain controls, semantic colors, visible keyboard focus and no horizontal overflow', async () => {
  await mount(); await expand();
  for (const theme of ['light','dark']) for (const width of [760,320]) {
    await page.evaluate(({theme,width}) => {
      document.documentElement.dataset.theme=theme;document.getElementById('root').style.width=width+'px';
    }, {theme,width});
    await toggle().focus(); await page.keyboard.press('Tab');
    const layout = await page.getByTestId('literature-processing').evaluate(element => {
      const focused=document.activeElement, style=getComputedStyle(focused);
      return {width:element.clientWidth,scroll:element.scrollWidth,outline:style.outlineStyle,
        outlineWidth:parseFloat(style.outlineWidth),radius:getComputedStyle(element.querySelector('button')).borderRadius,
        text:getComputedStyle(element).color};
    });
    assert.ok(layout.scroll<=layout.width+1,JSON.stringify({theme,width,...layout}));
    assert.equal(layout.outline,'solid');assert.ok(layout.outlineWidth>=2);
    await page.getByRole('button',{name:'打开 PDF：Paper a',exact:true}).click();
    if (process.env.ROC_P5_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.ROC_P5_SCREENSHOT_DIR,`literature-${theme}-${width}.png`)});
  }
  assert.equal(await count('openPdf'),4);
  await page.evaluate(() => {document.getElementById('root').style.width='';document.documentElement.dataset.theme='light';});
});
