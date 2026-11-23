import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-literature-pages-'));
  await buildViteRenderer({directory, plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}', script: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      import {LibraryList} from './src/renderer/literature/LibraryList';
      import './src/renderer/styles/index.css';
      const ok=data=>({ok:true,data});
      const record=(projectId,index)=>({id:projectId+'-'+index,revision:1,archived:false,
        metadata:{title:'Paper '+index,authors:['Fixture Author'],publishedYear:2026},
        bibliography:{citationKey:'fixture'+index,entryType:'article',fields:{}},projectIds:[projectId],
        updatedAt:'2026-11-23T00:00:00.000Z'});
      const rows=projectId=>Array.from({length:437},(_,index)=>record(projectId,index));
      const client={api:{research:{
        listLibraryPage:request=>{
          window.calls.push(request);
          const all=rows(request.projectId).filter(item=>item.metadata.title.includes(request.query));
          const offset=request.cursor===null?0:all.findIndex(item=>item.id===request.cursor.id)+1;
          const items=all.slice(offset,offset+request.limit), hasMore=offset+items.length<all.length;
          const data={items,total:all.length,hasMore,nextCursor:hasMore?{id:items.at(-1).id,updatedAt:items.at(-1).updatedAt}:null};
          if(window.hold) return new Promise(resolve=>window.pending.push({request,resolve,data}));
          return Promise.resolve(ok(data));
        },
        getLibraryItem:async({id})=>ok(rows(id.startsWith('project-b')?'project-b':'project-a').find(item=>item.id===id)),
        listDocuments:async()=>ok([]),wikiSnapshot:async()=>ok({claims:[],sources:[]}),onLibraryChanged:()=>()=>{}
      }}};
      const root=createRoot(document.getElementById('root'));let key=0;
      function Harness({projectId}) {
        const store=useLiteratureStore(client,projectId);window.store=store;
        return <LiteratureScopeProvider value={store}><main style={{height:'100%',width:240}}>
          <LibraryList compact onRequestImport={()=>{}}/>
          </main></LiteratureScopeProvider>;
      }
      window.mount=(projectId='project-a',reset=true)=>{if(reset){window.calls=[];window.hold=false;window.pending=[];key++;}
        flushSync(()=>root.render(<Harness key={key} projectId={projectId}/>));};
      window.finish=(error=null)=>{const next=window.pending.shift();next.resolve(error?{ok:false,error:{message:error}}:ok(next.data));};
      window.mount();
    `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:700,height:700}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.store?.status === 'ready');
});
after(async () => {try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);});

test('manual pages keep the total honest, retry in place and retain selection without loading all rows', async () => {
  await page.evaluate(() => window.mount());
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  await page.getByTestId('literature-row-project-a-0').click();
  await page.locator('.library-virtual-list').evaluate(element => element.scrollTo({top: 10000}));
  await expect(page.getByTestId('literature-row-project-a-0')).toHaveCount(0);
  const scrollBefore = await page.locator('.library-virtual-list').evaluate(element => element.scrollTop);
  await page.evaluate(() => {window.hold = true;});
  const more = page.getByTestId('literature-load-more');
  await more.focus(); await page.keyboard.press('Enter');
  await expect(more).toBeDisabled();
  await page.evaluate(() => {window.store.loadMore(); window.store.loadMore();});
  assert.equal(await page.evaluate(() => window.pending.length), 1);
  await page.evaluate(() => window.finish('Next page unavailable'));
  await expect(page.getByRole('alert')).toContainText('Next page unavailable');
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  await expect(more).toHaveText('重试加载');
  await more.click();
  await page.evaluate(() => {window.hold = false; window.finish();});
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 400 / 437 条');
  assert.equal(await page.evaluate(() => window.store.selectedId), 'project-a-0');
  assert.ok(Math.abs(await page.locator('.library-virtual-list').evaluate(element => element.scrollTop) - scrollBefore) < 2,
    'appending a page must not scroll back to the selected item');
  await more.click();
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 437 / 437 条');
  await expect(more).toHaveCount(0);
  assert.equal(await page.evaluate(() => new Set(window.store.items.map(item => item.id)).size), 437);
  assert.ok(await page.locator('[data-testid^="literature-row-"]').count() < 40);
  await page.evaluate(() => window.store.select('project-a-430'));
  await expect(page.getByTestId('literature-row-project-a-430')).toBeVisible();
  await page.getByTestId('literature-search').fill('Paper 2');
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 111 / 111 条');
  await page.waitForFunction(() => window.store.selected?.id === 'project-a-430');
});

test('old pages cannot publish after query edits, reloads or project switches', async () => {
  await page.evaluate(() => window.mount());
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  await page.evaluate(() => {window.hold = true; window.store.loadMore();});
  await page.waitForFunction(() => window.pending.length === 1);
  await page.getByTestId('literature-search').fill('Paper 436');
  await page.evaluate(() => {window.hold = false; window.finish();});
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 1 / 1 条');
  assert.deepEqual(await page.evaluate(() => window.store.items.map(item => item.id)), ['project-a-436']);

  await page.evaluate(() => window.mount());
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  await page.evaluate(() => {window.hold = true; window.store.loadMore();});
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {window.hold = false; window.store.reload(); window.finish();});
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  assert.equal(await page.evaluate(() => window.store.items.length), 200);

  await page.evaluate(() => {window.hold = true; window.store.loadMore();});
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {window.hold = false; window.mount('project-b', false); window.finish();});
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 437 条');
  assert.equal(await page.evaluate(() => window.store.items.every(item => item.id.startsWith('project-b-'))), true);
});
