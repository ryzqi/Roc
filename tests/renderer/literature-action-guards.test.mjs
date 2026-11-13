import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-literature-action-guards-'));
  await buildViteRenderer({directory, script: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {requestNavigation} from './src/renderer/app/navigation-guard';
    import ReadingDiscoveryPanel from './src/renderer/literature/ReadingDiscoveryPanel';
    import AcademicRadarPanel from './src/renderer/literature/AcademicRadarPanel';
    import {LibraryList} from './src/renderer/literature/LibraryList';
    import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
    import {readingDiscoveryRequestSchema, readingDiscoveryResultSchema, radarArticleSchema,
      radarFeedSchema, radarFeedSaveSchema, radarImportSchema, radarRefreshSchema,radarBrowserRequestSchema,
      radarCapturePageSchema}
      from './src/shared/schemas/research-reading';
    const root = createRoot(document.getElementById('root'));
    const ok = data => ({ok:true, data});
    const feed = id => radarFeedSchema.parse({id,projectId:'project-a',title:id,url:'https://example.invalid/'+id,
      pinned:false,archived:false,revision:1,refreshedAt:null,error:null});
    const article = (id, importedItemId = null) => radarArticleSchema.parse({id,feedId:'feed-a',
      title:id,url:'https://example.invalid/'+id,summary:'Source '+id,authors:[],publishedAt:null,
      arxivId:null,doi:null,read:false,importedItemId,score:null});
    const rows = [article('paper-a'), article('paper-b'), article('paper-saved','saved-item')];
    window.discovery = readingDiscoveryResultSchema.parse({articles:rows,source:'Synthetic source',
      fetchedAt:'2026-11-12',cached:false,nextOffset:null,warnings:[]});
    const schemas = {discoverReadingRelations:readingDiscoveryRequestSchema, importRadarArticle:radarImportSchema,
      saveRadarFeed:radarFeedSaveSchema, refreshRadarFeed:radarRefreshSchema,radarBrowser:radarBrowserRequestSchema,
      captureRadarPage:radarCapturePageSchema};
    function call(method,input,data) {
      schemas[method]?.parse(input);
      calls.push({method,input});
      if (held.has(method)) return new Promise(resolve => pending.push({method,input,resolve}));
      return Promise.resolve(ok(data));
    }
    const client = {api:{research:{
      discoverReadingRelations:input => call('discoverReadingRelations',input,discovery),
      importRadarArticle:input => call('importRadarArticle',input,{itemId:'saved-'+input.articleId}),
      listRadarFeeds:input => call('listRadarFeeds',input,[...radarFeeds.values()]),
      listRadarArticles:input => call('listRadarArticles',input,rows),
      saveRadarFeed:input => call('saveRadarFeed',input,{...feed(input.id),title:input.title,url:input.url,
        revision:input.expectedRevision+1}).then(result=>{
          if(result.ok)radarFeeds.set(result.data.id,result.data);return result;
        }),
      refreshRadarFeed:input => call('refreshRadarFeed',input,{}),
      markRadarArticle:input => call('markRadarArticle',input,{}),
      radarBrowser:input => call('radarBrowser',input,{url:'https://papers.cool/arxiv/cs.AI',
        papers:[{title:'Browser paper',url:'https://papers.cool/arxiv/2601.12345',doi:null,arxivId:'2601.12345'}]}),
      captureRadarPage:input => call('captureRadarPage',input,article('captured-paper'))
    }}};
    window.clear = () => flushSync(() => root.render(null));
    window.navigateAway=()=>requestNavigation({page:'project',projectId:'project-b'},()=>window.navigations++);
    window.mountPanels = kind => {
      clear(); window.calls=[]; window.pending=[]; window.held=new Set(); window.imported=0;
      window.navigations=0; window.radarFeeds=new Map(['feed-a','feed-b'].map(id=>[id,feed(id)]));
      const onImported = () => window.imported++;
      const library={items:[{id:'paper-copy',metadata:{title:'Citation paper',authors:[],publishedYear:2026,citationCount:null,source:'doi'},
        bibliography:{citationKey:'author2026paper',fields:{}},projectIds:['project-a'],archived:false}],status:'ready',
        query:'',selectedId:null,projectId:'project-a',includeArchived:false,action:{error:null},
        setQuery:()=>{},reload:()=>{},setIncludeArchived:()=>{},select:()=>{}};
      flushSync(() => root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict><div style={{height:700}}>
        {kind==='discovery'
          ? <ReadingDiscoveryPanel client={client} projectId="project-a" itemId="item-a" writable onImported={onImported}/>
          :kind==='library'?<LiteratureScopeProvider value={library}><LibraryList onRequestImport={()=>{}}/></LiteratureScopeProvider>
          : <AcademicRadarPanel client={client} projectId="project-a" writable active onImported={onImported}/>}
      </div></LazyMotion></MotionConfig>));
    };
    window.resolveNext = (method,response) => {
      const index=pending.findIndex(entry => entry.method===method);
      if(index<0) throw new Error('No pending '+method);
      pending.splice(index,1)[0].resolve(response);
    };
    window.resolveBrowser = (action,response) => {
      const request=calls.find(call=>call.method==='radarBrowser'&&call.input.action===action);
      const index=pending.findIndex(entry=>entry.method==='radarBrowser'&&entry.input===request?.input);
      if(index<0)throw new Error('No pending browser '+action);
      pending.splice(index,1)[0].resolve(response);
    };
  `, style: 'html,body{margin:0}body{padding:16px;background:var(--bg);color:var(--ink)}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850})
      .loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory,'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mountPanels === 'function');
});
after(async () => {
  await page?.evaluate(() => clear()).catch(() => {});
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive:true,force:true});}
  assert.deepEqual(errors, []);
});

const count = method => page.evaluate(method => calls.filter(call => call.method===method).length, method);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mount(kind) {
  await page.evaluate(kind => mountPanels(kind),kind);
  if (kind==='radar') await expect(page.getByRole('button',{name:'paper-a',exact:true})).toBeVisible();
}
async function discovery() {
  await mount('discovery');
  await page.getByRole('button',{name:'发现论文',exact:true}).click();
  await expect(page.getByText('paper-a',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'全选',exact:true}).click();
}

test('discovery serializes repeated requests before React disables the controls', async () => {
  await mount('discovery');
  await page.evaluate(() => {
    held.add('discoverReadingRelations');
    const button=[...document.querySelectorAll('button')].find(button => button.textContent==='发现论文');
    button.click(); button.click();
  });
  assert.equal(await count('discoverReadingRelations'),1);
  await expect(page.getByLabel('引文方向')).toBeDisabled();
  await page.evaluate(() => resolveNext('discoverReadingRelations',{ok:true,data:discovery}));
  await expect(page.getByRole('button',{name:'发现论文',exact:true})).toBeEnabled();
});

test('discovery batch keeps failed selections and reports only committed imports', async () => {
  await discovery();
  await page.evaluate(() => {
    held.add('importRadarArticle');
    const button=[...document.querySelectorAll('button')].find(button => button.textContent.startsWith('批量入库'));
    button.click(); button.click();
  });
  assert.equal(await count('importRadarArticle'),1);
  await page.evaluate(() => resolveNext('importRadarArticle',{ok:false,error:{message:'Synthetic import rejected'}}));
  await page.waitForFunction(() => calls.filter(call => call.method==='importRadarArticle').length===2);
  await page.evaluate(() => resolveNext('importRadarArticle',{ok:true,data:{itemId:'saved-paper-b'}}));
  await expect(page.getByRole('status').filter({hasText:'已加入文献库 1 篇'})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('paper-a:');
  await expect(page.getByRole('alert')).toContainText('Synthetic import rejected');
  await expect(page.getByRole('button',{name:'批量入库 (1)',exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(() => imported),1);
});

test('discovery unmount stops the remaining batch requests and late refresh callback', async () => {
  await discovery();
  await page.evaluate(() => held.add('importRadarArticle'));
  await page.getByRole('button',{name:'批量入库 (2)',exact:true}).click();
  assert.equal(await count('importRadarArticle'),1);
  await page.evaluate(() => {clear(); resolveNext('importRadarArticle',{ok:true,data:{itemId:'saved-paper-a'}});});
  await settle();
  assert.equal(await count('importRadarArticle'),1);
  assert.equal(await page.evaluate(() => imported),0);
});

test('radar feed submission locks its fields and does not refresh a saved feed after unmount', async () => {
  await mount('radar');
  await page.getByLabel('订阅名称',{exact:true}).fill('Submitted feed');
  await page.getByLabel('RSS 地址',{exact:true}).fill('https://example.invalid/feed');
  await page.evaluate(() => {
    held.add('saveRadarFeed'); const form=document.querySelector('form');
    form.requestSubmit(); form.requestSubmit();
  });
  assert.equal(await count('saveRadarFeed'),1);
  await expect(page.getByLabel('订阅名称',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('RSS 地址',{exact:true})).toBeDisabled();
  await page.evaluate(() => {
    const input=calls.find(call => call.method==='saveRadarFeed').input;
    clear(); resolveNext('saveRadarFeed',{ok:true,data:{...input,revision:1,refreshedAt:null,error:null}});
  });
  await settle();
  assert.equal(await count('refreshRadarFeed'),0);
});

test('radar bulk selection excludes imported rows and freezes the chosen import set', async () => {
  await mount('radar');
  await page.getByRole('button',{name:'全选',exact:true}).click();
  await expect(page.getByRole('button',{name:'入库所选 (2)',exact:true})).toBeVisible();
  await expect(page.getByLabel('选择 paper-saved',{exact:true})).toBeDisabled();
  await page.evaluate(() => {
    held.add('importRadarArticle');
    const button=[...document.querySelectorAll('button')].find(button => button.textContent.startsWith('入库所选'));
    button.click(); button.click();
  });
  assert.equal(await count('importRadarArticle'),1);
  await expect(page.getByLabel('选择 paper-a',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'全选',exact:true})).toBeDisabled();
  await page.evaluate(() => {clear(); resolveNext('importRadarArticle',{ok:true,data:{itemId:'saved-paper-a'}});});
  await settle();
  assert.equal(await count('importRadarArticle'),1);
  assert.equal(await page.evaluate(() => imported),0);
});

test('radar refresh stops later feeds after the current panel is unmounted', async () => {
  await mount('radar');
  await page.evaluate(() => held.add('refreshRadarFeed'));
  await page.getByRole('button',{name:'刷新全部',exact:true}).click();
  assert.equal(await count('refreshRadarFeed'),1);
  await page.evaluate(() => {clear(); resolveNext('refreshRadarFeed',{ok:true,data:{}});});
  await settle();
  assert.equal(await count('refreshRadarFeed'),1);
});

test('radar feed form ignores composition confirmation and allows the next deliberate Enter', async () => {
  await mount('radar');
  const input=page.getByLabel('订阅名称',{exact:true});
  await input.fill('Chinese feed');
  await page.getByLabel('RSS 地址',{exact:true}).fill('https://example.invalid/feed');
  await input.focus();
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await page.keyboard.press('Enter');
  assert.equal(await count('saveRadarFeed'),0);
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await page.keyboard.press('Enter');
  assert.equal(await count('saveRadarFeed'),0);
  await page.evaluate(() => held.add('saveRadarFeed'));
  await page.keyboard.press('Enter');
  assert.equal(await count('saveRadarFeed'),1);
});

test('RSS drafts survive source tabs and independently guard project navigation and native unload', async () => {
  await mount('radar'); await page.getByLabel('订阅名称',{exact:true}).fill('Draft feed');
  await page.getByLabel('RSS 地址',{exact:true}).fill('https://example.invalid/draft');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await page.getByRole('tab',{name:'每日 arXiv',exact:true}).click();
  await page.getByRole('tab',{name:'RSS 订阅',exact:true}).click();
  await expect(page.getByLabel('订阅名称',{exact:true})).toHaveValue('Draft feed');
  await expect(page.getByLabel('RSS 地址',{exact:true})).toHaveValue('https://example.invalid/draft');
  await page.evaluate(() => navigateAway());
  await page.getByTestId('literature-editor-discard-cancel').click();
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  assert.equal(await page.evaluate(() => navigations),0);
  await page.evaluate(() => {
    window.otherVeto=event=>event.preventDefault();window.addEventListener('roc:before-navigate',window.otherVeto);navigateAway();
  });
  await page.getByTestId('literature-editor-discard-confirm').click();
  assert.equal(await page.evaluate(() => navigations),0);
  await page.evaluate(() => window.removeEventListener('roc:before-navigate',window.otherVeto));
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await expect(page.getByLabel('订阅名称',{exact:true})).toHaveValue('');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
});

test('RSS shortcut subscription preserves the unrelated form draft and source tabs move physical focus', async () => {
  await mount('radar'); await page.getByLabel('订阅名称',{exact:true}).fill('Draft feed');
  await page.getByLabel('RSS 地址',{exact:true}).fill('https://example.invalid/draft');
  await page.getByRole('button',{name:'订阅 cs.AI',exact:true}).click();
  await expect(page.getByRole('button',{name:'订阅 cs.AI',exact:true})).toBeEnabled();
  await expect(page.getByLabel('订阅名称',{exact:true})).toHaveValue('Draft feed');
  await expect(page.getByLabel('RSS 地址',{exact:true})).toHaveValue('https://example.invalid/draft');
  const rss=page.getByRole('tab',{name:'RSS 订阅',exact:true}),daily=page.getByRole('tab',{name:'每日 arXiv',exact:true});
  await rss.focus(); await page.keyboard.press('End');
  await expect(daily).toBeFocused();await expect(daily).toHaveAttribute('aria-selected','true');
  await expect(rss).toHaveAttribute('tabindex','-1');
  await page.keyboard.press('ArrowLeft');
  await expect(rss).toBeFocused();await expect(rss).toHaveAttribute('tabindex','0');
  await expect(page.getByLabel('订阅名称',{exact:true})).toHaveValue('Draft feed');
});

test('RSS rename draft has explicit save, one pending request and preserves failure for exact retry', async () => {
  await mount('radar');await page.getByText('管理订阅',{exact:true}).click();
  const input=page.getByLabel('重命名 feed-a',{exact:true});
  await input.fill('Renamed feed');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await page.evaluate(() => {
    held.add('saveRadarFeed');
    const row=[...document.querySelectorAll('input')].find(input=>input.getAttribute('aria-label')==='重命名 feed-a').parentElement;
    const save=[...row.querySelectorAll('button')].find(button=>button.textContent==='保存名称');
    save.click();save.click();
  });
  assert.equal(await count('saveRadarFeed'),1);await expect(input).toBeDisabled();
  await page.evaluate(() => resolveNext('saveRadarFeed',{ok:false,error:{message:'Synthetic rename rejected'}}));
  await expect(page.getByRole('alert')).toContainText('Synthetic rename rejected');
  await expect(input).toHaveValue('Renamed feed');await expect(input).toBeEnabled();
  await input.locator('..').getByRole('button',{name:'保存名称',exact:true}).click();
  await page.evaluate(() => {
    const requests=calls.filter(call=>call.method==='saveRadarFeed');
    if(JSON.stringify(requests[0].input)!==JSON.stringify(requests[1].input))throw new Error('rename retry changed its revision');
    const input=requests[1].input;
    resolveNext('saveRadarFeed',{ok:true,data:{...input,revision:2,refreshedAt:null,error:null}});
  });
  await expect(page.getByLabel('重命名 Renamed feed',{exact:true})).toHaveValue('Renamed feed');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
});

async function browser(inspect=true) {
  await mount('radar');await page.getByRole('tab',{name:'Cool Papers',exact:true}).click();
  await page.waitForFunction(()=>calls.some(call=>call.method==='radarBrowser'&&call.input.action==='open'));
  if(inspect){
    await page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Browser paper',exact:true})).toBeVisible();
  }
}

test('browser inspection is synchronous and protects native unload until its actual receipt', async () => {
  await browser(false);
  await page.evaluate(()=>{
    held.add('radarBrowser');const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='读取当前页论文 / 入库');
    button.click();button.click();
  });
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='radarBrowser'&&call.input.action==='inspect').length),1);
  await expect(page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true})).toBeDisabled();
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await page.evaluate(()=>resolveBrowser('inspect',{ok:false,error:{message:'Synthetic inspection rejected'}}));
  await expect(page.getByRole('alert')).toContainText('Synthetic inspection rejected');
  await expect(page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
});

test('browser import locks both its request and parent source selection before React renders', async () => {
  await browser();
  await page.evaluate(()=>{
    held.add('captureRadarPage');
    const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='加入文献库');
    button.click();button.click();
    [...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='RSS 订阅').click();
  });
  assert.equal(await count('captureRadarPage'),1);
  await expect(page.getByRole('tab',{name:'Cool Papers',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'RSS 订阅',exact:true})).toBeDisabled();
  await page.evaluate(()=>resolveNext('captureRadarPage',{ok:true,data:{id:'captured-paper'}}));
  await expect(page.getByRole('status').filter({hasText:'已入库：Browser paper'})).toBeVisible();
  assert.equal(await count('importRadarArticle'),1);assert.equal(await page.evaluate(()=>imported),1);
});

test('browser unmount stops the subsequent import stage and refresh callback', async () => {
  await browser();await page.evaluate(()=>held.add('captureRadarPage'));
  await page.getByRole('button',{name:'加入文献库',exact:true}).click();
  await page.evaluate(()=>{clear();resolveNext('captureRadarPage',{ok:true,data:{id:'captured-paper'}});});
  await settle();assert.equal(await count('importRadarArticle'),0);assert.equal(await page.evaluate(()=>imported),0);
});

test('library citation copy exposes clipboard rejection and clears it after a successful retry', async () => {
  await mount('library');
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error('Synthetic clipboard rejection');};});
  await page.getByRole('button',{name:'复制引用键 author2026paper',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('剪贴板不可用，请手动复制。');
  await page.evaluate(()=>{navigator.clipboard.writeText=async value=>{window.copiedKey=value;};});
  await page.getByRole('button',{name:'复制引用键 author2026paper',exact:true}).click();
  await expect(page.getByRole('button',{name:'已复制引用键 author2026paper',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>copiedKey),'author2026paper');await expect(page.getByRole('alert')).toHaveCount(0);
});
