// Real Electron and literature store; only IPC is replaced.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

test('literature searches release obsolete results and reload revisited queries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-audit-renderer-'));
  let app;
  const errors = [];
  try {
    await build({stdin: {contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {SWRConfig, useSWRConfig} from 'swr';
      import {APP_SWR_CONFIG} from './src/renderer/app/swr-config';
      import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
      import {useAppRoute} from './src/renderer/app/use-app-route';
      const root = createRoot(document.getElementById('root'));
      const client = {api: {research: {
        listLibraryPage: async ({query}) => { window.libraryRequests = (window.libraryRequests ?? 0) + 1; return ({ok: true, data: {items:Array.from({length:200}, (_,n) =>
          ({id:query+':'+n, title:query, abstract:'x'.repeat(4096)})),total:200,hasMore:false,nextCursor:null}}); },
        wikiSnapshot: async () => ({ok:true, data:{sources:[]}}),
        listDocuments: async () => ({ok:true, data:[]}),
        onLibraryChanged: () => () => {}
      }}};
      function CacheCapture() {window.auditCache = useSWRConfig().cache; return null;}
      function Store({projectId}) {
        window.auditStore = useLiteratureStore(client, projectId);
        const {route,navigate}=useAppRoute();
        window.openGuardedPaper=id=>window.auditStore.select(id,commitSelection=>navigate({...route,projectId,view:'library'},
          {onNavigated:()=>{commitSelection();window.objectOpened=true;}}));
        return null;
      }
      window.mount = (projectId, visible = true) => flushSync(() => root.render(
        React.createElement(SWRConfig, {value:APP_SWR_CONFIG}, React.createElement(CacheCapture),
          visible ? React.createElement(Store, {projectId}) : null)));
      window.inspectCache = () => {
        const entries = [...window.auditCache.values()].filter(v => Array.isArray(v.data));
        return {entries:entries.length, retainedItems:entries.reduce((n,v)=>n+v.data.length,0),
          payloadChars:entries.reduce((n,v)=>n+JSON.stringify(v.data).length,0)};
      };
      window.mount('audit-project');
    `, resolveDir:process.cwd(), loader:'js'}, outfile:join(dir,'renderer.js'),
      bundle:true, platform:'browser', format:'iife', logLevel:'silent'});
    writeFileSync(join(dir,'index.html'), '<div id="root"></div><script src="renderer.js"></script>');
    writeFileSync(join(dir,'main.cjs'), `
      const {app,BrowserWindow}=require('electron');
      app.setPath('userData', ${JSON.stringify(join(dir,'data'))});
      app.whenReady().then(()=>{const w=new BrowserWindow({show:false}); w.loadFile(${JSON.stringify(join(dir,'index.html'))});});
    `);
    app = await _electron.launch({executablePath:electronPath,args:[join(dir,'main.cjs')]});
    const page = await app.firstWindow();
    page.on('pageerror', e=>errors.push(e.message));
    await page.waitForFunction(()=>window.auditStore?.status==='ready');

    for (let n=0; n<20; n++) {
      const q = `query-${n}`;
      await page.evaluate(q=>window.auditStore.setQuery(q),q);
      await page.waitForFunction(q=>window.auditStore.status==='ready' && window.auditStore.items[0]?.title===q,q);
    }
    const afterSearch = await page.evaluate(()=>window.inspectCache());
    await page.evaluate(()=>window.mount(null,false));
    const afterUnmount = await page.evaluate(()=>window.inspectCache());
    assert.ok(afterSearch.entries <= 1, 'obsolete query results must not accumulate in the renderer cache');
    assert.ok(afterUnmount.entries <= 1);
    await page.evaluate(()=>window.mount('audit-project'));
    await page.waitForFunction(()=>window.auditStore?.status === 'ready');
    await page.evaluate(()=>window.auditStore.setQuery('query-0'));
    await page.waitForFunction(()=>window.auditStore.status === 'ready' && window.auditStore.items[0]?.title === 'query-0');
    assert.equal(await page.evaluate(()=>window.libraryRequests), 23, 'revisited query must read current data');
    for(const eventName of ['roc:before-reading-change','roc:before-navigate']) {
      const blocked=await page.evaluate(eventName=>{
        const veto=event=>event.preventDefault();
        window.addEventListener(eventName,veto);
        window.openGuardedPaper('query-0:0');
        window.removeEventListener(eventName,veto);
        return {selected:window.auditStore.selectedId,opened:window.objectOpened??false};
      },eventName);
      assert.deepEqual(blocked,{selected:null,opened:false},eventName+' must preserve both the selection and object target');
    }
    await page.evaluate(()=>window.openGuardedPaper('query-0:0'));
    await page.waitForFunction(()=>window.auditStore.selectedId==='query-0:0' && window.objectOpened);
    assert.deepEqual(errors,[]);

  } finally {
    try {await app?.close();} finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('library and document-status failures expose independent retries without replacing loaded rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-literature-retained-errors-'));
  const artifacts = process.env.ROC_RETENTION_ARTIFACT_DIR ?? '/tmp/roc-ui-phase2-retention-20261127';
  mkdirSync(artifacts, {recursive: true});
  let app;
  const errors = [];
  try {
    await buildViteRenderer({directory: dir, plugins: [tailwindcss()],
      style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}',
      script: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {LazyMotion,domAnimation} from 'motion/react';
        import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
        import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
        import {LibraryList} from './src/renderer/literature/LibraryList';
        import './src/renderer/styles/index.css';
        const ok=data=>({ok:true,data});
        const rows=Array.from({length:200},(_,index)=>({
          id:'paper-'+index,revision:1,archived:false,projectIds:['project-a'],
          updatedAt:new Date(Date.UTC(2026,10,27)-index*1000).toISOString(),
          metadata:{title:'Paper '+String(index).padStart(3,'0'),authors:['Fixture Author'],publishedYear:2026},
          bibliography:{citationKey:'fixture'+index,entryType:'article',fields:{}}
        }));
        const listeners=new Set();
        window.calls={list:0,statuses:0};window.failList=null;
        window.failStatuses='Initial processing check unavailable';
        const research={
          listLibraryPage:async()=>{
            window.calls.list++;
            if(window.failList)return {ok:false,error:{message:window.failList}};
            return ok({items:structuredClone(rows),total:200,hasMore:false,nextCursor:null});
          },
          getDocumentStatuses:async({libraryItemIds})=>{
            window.calls.statuses++;
            if(window.failStatuses)throw new Error(window.failStatuses);
            return ok({items:libraryItemIds.map(libraryItemId=>({libraryItemId,documents:[{
              id:'document-'+libraryItemId,status:'ready',currentParseId:'parse-'+libraryItemId,
              indexStatus:'ready',error:null
            }]}))});
          },
          listDocuments:async()=>ok([]),wikiSnapshot:async()=>ok({claims:[],sources:[]}),
          onLibraryChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}
        };
        const client={api:{research}};
        window.changed=()=>{for(const listener of listeners)listener({affectedProjectIds:['project-a']});};
        function Harness(){
          const store=useLiteratureStore(client,'project-a');window.store=store;
          return <LiteratureScopeProvider value={store}><LazyMotion features={domAnimation}>
            <label style={{display:'block',height:32}}>当前草稿<input aria-label="当前草稿"/></label>
            <main style={{height:'calc(100% - 32px)'}}><LibraryList onRequestImport={()=>{}}/></main>
          </LazyMotion></LiteratureScopeProvider>;
        }
        createRoot(document.getElementById('root')).render(<Harness/>);
      `});
    writeFileSync(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(join(dir, 'data'))});
      app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:760})
        .loadFile(${JSON.stringify(join(dir, 'index.html'))}));`);
    app = await _electron.launch({executablePath: electronPath, args: [join(dir, 'main.cjs')]});
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await expect.poll(() => page.getByTestId('literature-count').ariaSnapshot()).toBe('- text: 已加载 200 / 200 条');
    await expect(page.getByTestId('literature-status-error')).toContainText('Initial processing check unavailable');
    await expect(page.getByTestId('literature-status-ready')).toHaveCount(0);
    await page.evaluate(() => {window.failStatuses = null;});
    await page.getByTestId('literature-status-error').getByRole('button', {name: '重试', exact: true}).click();
    await expect(page.getByTestId('literature-status-error')).toHaveCount(0);
    await page.waitForFunction(() => window.store.documentStatuses.size === 200);
    await expect(page.getByTestId('literature-status-ready')).toBeVisible();

    const scroller = page.locator('.library-virtual-list');
    await scroller.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => document.querySelector('.library-virtual-list').scrollTop > 400);
    await page.getByRole('textbox', {name: '当前草稿'}).fill('继续写作时保留焦点');
    const before = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.retainedScroller = document.querySelector('.library-virtual-list');
      window.retainedRow = document.querySelector('[data-testid^="literature-row-"]');
      return {scrollTop: window.retainedScroller.scrollTop, rowCount: document.querySelectorAll('.library-row').length,
        listRect: document.querySelector('[data-testid="literature-list-body"]').getBoundingClientRect().toJSON(),
        rowHeight: window.retainedRow.getBoundingClientRect().height};
    });
    await page.evaluate(() => {
      window.failList = 'List refresh unavailable';
      window.failStatuses = 'Processing check unavailable';
      window.changed();
    });
    await expect(page.getByTestId('literature-refresh-error')).toContainText('List refresh unavailable');
    await expect(page.getByTestId('literature-status-error')).toContainText('Processing check unavailable');
    await expect.poll(() => page.getByTestId('literature-count').ariaSnapshot()).toBe('- text: 已加载 200 / 200 条');
    await expect(page.getByRole('textbox', {name: '当前草稿'})).toBeFocused();
    await expect(page.getByTestId('literature-status-ready')).toBeVisible();
    const retained = await page.evaluate(() => ({
      status: window.store.status, itemCount: window.store.items.length, statusCount: window.store.documentStatuses.size,
      sameScroller: window.retainedScroller === document.querySelector('.library-virtual-list'),
      sameRow: window.retainedRow === document.querySelector('[data-testid^="literature-row-"]'),
      scrollTop: window.retainedScroller.scrollTop,
      rowCount: document.querySelectorAll('.library-row').length,
      listRect: document.querySelector('[data-testid="literature-list-body"]').getBoundingClientRect().toJSON(),
      rowHeight: window.retainedRow.getBoundingClientRect().height
    }));
    assert.equal(retained.status, 'ready');
    assert.equal(retained.itemCount, 200);
    assert.equal(retained.statusCount, 200, 'failed background reads retain the previous verified observations');
    assert.equal(retained.sameScroller, true);
    assert.equal(retained.sameRow, true);
    assert.deepEqual(retained.listRect, before.listRect);
    assert.ok(Math.abs(retained.scrollTop - before.scrollTop) < 2);
    assert.equal(retained.rowHeight, 64);
    assert.equal(retained.rowHeight, before.rowHeight);
    assert.ok(retained.rowCount < 40);
    await page.screenshot({path: join(artifacts, 'retained-background-errors.png')});

    await page.evaluate(() => {window.failList = null;});
    await page.getByTestId('literature-refresh-error').getByRole('button', {name: '重试', exact: true}).click();
    await expect(page.getByTestId('literature-refresh-error')).toHaveCount(0);
    await expect(page.getByTestId('literature-status-error')).toContainText('Processing check unavailable');
    await page.evaluate(() => {window.failStatuses = null;});
    await page.getByTestId('literature-status-error').getByRole('button', {name: '重试', exact: true}).click();
    await expect(page.getByTestId('literature-status-error')).toHaveCount(0);
    await page.waitForFunction(() => window.store.documentStatusesStatus === 'ready');
    assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - before.scrollTop) < 2);

    await page.evaluate(() => {window.failStatuses = 'Refresh must retry status observations'; window.store.reloadDocumentStatuses();});
    await expect(page.getByTestId('literature-status-error')).toContainText('Refresh must retry status observations');
    const callsBeforeRefresh = await page.evaluate(() => ({...window.calls}));
    await page.evaluate(() => {window.failStatuses = null;});
    await page.getByTestId('literature-filter-toggle').click();
    await page.getByTestId('literature-refresh').click();
    await expect(page.getByTestId('literature-status-error')).toHaveCount(0);
    await page.waitForFunction(() => window.store.documentStatusesStatus === 'ready' && !window.store.refreshing);
    const callsAfterRefresh = await page.evaluate(() => ({...window.calls}));
    assert.ok(callsAfterRefresh.list > callsBeforeRefresh.list);
    assert.ok(callsAfterRefresh.statuses > callsBeforeRefresh.statuses,
      'explicit library refresh also retries status observations when loaded IDs are unchanged');
    await page.keyboard.press('Escape');
    await page.screenshot({path: join(artifacts, 'retained-background-recovered.png')});
    assert.deepEqual(errors, []);
  } finally {
    try {await app?.close();} finally {rmSync(dir, {recursive: true, force: true});}
  }
});
