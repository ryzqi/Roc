import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {measureRendererWorkload} from '../../scripts/performance/renderer-workload-metrics.mjs';

let directory, app, page, clipAudit;
const errors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-literature-zero-reflow-'));
  clipAudit = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  await buildViteRenderer({
    directory,
    plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}#root{width:1280px;max-width:100%}',
    script: `
      import React,{useCallback,useMemo,useRef,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LiteratureHubView} from './src/renderer/literature/LiteratureHubView';
      import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
      import {ViewActivity} from './src/renderer/shared/view-activity';
      import './src/renderer/styles/index.css';
      const ok=data=>({ok:true,data});
      const record=index=>({
        id:'paper-'+index,revision:1,archived:false,projectIds:['fixture'],
        updatedAt:new Date(Date.UTC(2026,10,27)-index*1000).toISOString(),
        metadata:{
          title:String(index).padStart(4,'0')+' Understanding long scientific titles without changing the literature list geometry',
          authors:['Alexandria Researcher','A second author with a deliberately long name'],
          publishedYear:2026,citationCount:null,doi:null,url:null,openAccessUrl:null,source:'local'
        },
        bibliography:{title:'Scientific evidence',citationKey:'researcher2026'+index,entryType:'article',
          fields:{journal:'Proceedings of a deliberately long scientific publication venue'}},
        sources:[]
      });
      const documentFor=(id,status='ready')=>({
        id:'document-'+id,libraryItemId:id,filename:'scientific-evidence.pdf',mediaType:'application/pdf',
        status,sourceHash:'a'.repeat(64),currentParseId:status==='ready'?'parse':null,
        activeParseId:status==='parsing'?'parse-pending':null
      });
      const blocks=[
        {id:'heading',kind:'heading',label:'Introduction',text:'Evidence and understanding',
          locator:'page:1',locations:[],imageAssetId:null},
        {id:'paragraph',kind:'paragraph',label:'Introduction',
          text:'A reading workspace preserves the context of the selected paper. '.repeat(30),
          locator:'page:1',locations:[],imageAssetId:null}
      ];
      function makeClient(items){
        const job={id:'job',projectId:'fixture',libraryItemId:'paper-0',title:items[0].metadata.title,
          generation:'generation',stage:'parse',status:'failed',attempts:1,nextRetryAt:null,
          documentId:'document-paper-0',receipt:null,errorCode:'fixture_parse_failure',
          updatedAt:'2026-11-27T00:00:00.000Z'};
        return {api:{files:{selectFromDialog:async()=>ok({filePaths:[]})},research:{
          listLibraryPage:async()=>ok({items,total:items.length,hasMore:false,nextCursor:null}),
          getLibraryItem:async({id})=>ok(items.find(item=>item.id===id)??null),
          wikiSnapshot:async()=>ok({claims:[],sources:[]}),
          getModelsStatus:async()=>ok({ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}),
          listAcquisition:async({libraryItemId}={})=>{
            const jobs=libraryItemId===undefined||libraryItemId===job.libraryItemId?[job]:[];
            return ok({jobs,total:jobs.length,nextOffset:null});
          },
          onLibraryChanged:()=>()=>{},
          resolveDocumentParse:async({libraryItemId})=>ok(documentFor(libraryItemId??'paper-0')),
          listReadingNotes:async()=>ok([]),
          exportBibliography:async()=>ok({content:'@article{fixture2026}'}),
          searchWiki:async()=>ok({pages:[],nextOffset:null,mode:'keyword',degradation:null}),
          knowledgeJobs:async()=>ok([]),listIndexedFiles:async()=>ok([]),listIndexJobs:async()=>ok([]),
          getIndexStatus:async()=>ok({phase:'idle',generation:1,error:null,workspacePath:'/synthetic',
            lastScanAt:null,counts:{total:0,ready:0,queued:0,running:0,failed:0},
            settings:{revision:1,projectId:'fixture',paused:false,watch:false,kinds:[],include:[],
              exclude:[],embeddingConfigId:null}})
        }}};
      }
      function Harness({count}){
        const all=useMemo(()=>Array.from({length:count},(_,index)=>record(index)),[count]);
        const client=useMemo(()=>makeClient(all),[all]);
        const sharedStore=useLiteratureStore(client,'fixture');
        const [selectedId,setSelected]=useState(null);
        const [documentStatus,setDocumentStatus]=useState('ready');
        const [view,setView]=useState('library');
        const [literatureRequest,setLiteratureRequest]=useState(null);
        const requestNonce=useRef(0);
        const select=useCallback((id,whenReady)=>{
          if(whenReady)whenReady(()=>setSelected(id));else setSelected(id);
        },[]);
        const reloadDocuments=useCallback(()=>{},[]);
        const openLiterature=useCallback(target=>{
          if(target.kind==='reader')setSelected(target.libraryItemId??'paper-0');
          setView(target.kind==='concept'?'knowledge':'library');
          setLiteratureRequest({projectId:'fixture',nonce:++requestNonce.current,target});
        },[]);
        window.openLiteratureObject=openLiterature;
        window.selectLiteratureItem=setSelected;
        window.setDocumentStatus=setDocumentStatus;
        const selected=all.find(item=>item.id===selectedId)??null;
        const store={...sharedStore,client,projectId:'fixture',items:all,total:all.length,hasMore:false,
          loadingMore:false,loadMoreError:null,status:'ready',error:null,selected,selectedId,
          selectedStatus:'ready',selectedError:null,documentsStatus:'ready',
          documents:selected?[documentFor(selected.id,documentStatus)]:[],
          claims:[],evidence:[],derivedStatus:'ready',derivedError:null,
          action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null,
          select,reloadDocuments,
          loadDocumentContent:async()=>ok({run:{id:'parse',documentId:'document-'+selectedId},
            content:{sourceHash:'a'.repeat(64),pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks}})
        };
        return <WorkspaceScopeProvider value={{client,projectId:'fixture',workspacePath:'/synthetic',
          writable:true,workspaceStatus:'ready',workspaceError:null,contextDrawerOpen:false,
          openFileInCanvas(){},openReviewInspector(){},openView:(next,onNavigated)=>{setView(next);onNavigated?.();},
          openLiterature,literatureRequest,
          consumeLiteratureRequest:nonce=>setLiteratureRequest(current=>current?.nonce===nonce?null:current)}}>
          <LiteratureScopeProvider value={store}>
            <ViewActivity active><LiteratureHubView view={view} projectId="fixture"/></ViewActivity>
          </LiteratureScopeProvider>
        </WorkspaceScopeProvider>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.mount=(count=1000)=>flushSync(()=>root.render(<Harness key={++key} count={count}/>));
      window.layoutShiftEntries=[];
      window.layoutShiftObserver=new PerformanceObserver(list=>{
        window.layoutShiftEntries.push(...list.getEntries().map(entry=>({
          value:entry.value,hadRecentInput:entry.hadRecentInput,
          sources:entry.sources.map(source=>({
            testId:source.node?.getAttribute?.('data-testid')??null,
            className:typeof source.node?.className==='string'?source.node.className:null,
            previous:source.previousRect.toJSON(),current:source.currentRect.toJSON()
          }))
        })));
      });
      window.layoutShiftObserver.observe({type:'layout-shift',buffered:true});
    `
  });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1450,height:900})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function settleRendering() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function mount({count = 1000, width = 1280, windowWidth = 1450, theme = 'light'} = {}) {
  await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 860), windowWidth);
  await page.evaluate(({count, width, theme}) => {
    document.documentElement.dataset.theme = theme;
    document.getElementById('root').style.width = width + 'px';
    window.mount(count);
  }, {count, width, theme});
  await expect(page.getByTestId('literature-library-browse')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-0')).toBeVisible();
  await settleRendering();
}

async function geometry({includeFirstRow = true} = {}) {
  return page.evaluate(includeFirstRow => {
    const selectors = {
      hubToolbar: '.literature-toolbar',
      listToolbar: '.library-list-toolbar',
      list: '[data-testid="literature-list"]',
      viewport: '.library-virtual-list',
      ...(includeFirstRow ? {firstRow: '[data-testid="literature-row-paper-0"]'} : {})
    };
    return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing geometry target: ' + selector);
      const {x, y, width, height} = element.getBoundingClientRect();
      return [name, {x, y, width, height}];
    }));
  }, includeFirstRow);
}

function assertStableGeometry(before, after, action) {
  for (const [name, bounds] of Object.entries(before)) {
    for (const [dimension, value] of Object.entries(bounds)) {
      assert.equal(after[name][dimension], value, `${action} changed ${name}.${dimension}`);
    }
  }
}

async function resetLayoutShifts() {
  await settleRendering();
  await page.evaluate(() => {
    window.layoutShiftObserver.takeRecords();
    window.layoutShiftEntries = [];
  });
}

async function assertNoLayoutShift(action) {
  await settleRendering();
  const entries = await page.evaluate(() => {
    window.layoutShiftEntries.push(...window.layoutShiftObserver.takeRecords().map(entry => ({
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
      sources: entry.sources.map(source => ({
        testId: source.node?.getAttribute?.('data-testid') ?? null,
        className: typeof source.node?.className === 'string' ? source.node.className : null
      }))
    })));
    return window.layoutShiftEntries;
  });
  const cls = entries.reduce((sum, entry) => sum + entry.value, 0);
  assert.equal(cls, 0, `${action}: ${JSON.stringify(entries)}`);
}

async function auditFloatingSurfaces(state) {
  // The shadow-bearing surface must be a descendant of the audit root.
  const result = await page.evaluate(source => (0, eval)(source)({root: 'body', viewport: true}), clipAudit);
  assert.equal(result.cut, 0, `${state}: ${JSON.stringify(result.issues)}`);
  return result;
}

async function capture(name) {
  if (!process.env.ROC_LITERATURE_CAPTURE) return;
  await mkdir(process.env.ROC_LITERATURE_CAPTURE, {recursive: true});
  await page.screenshot({path: join(process.env.ROC_LITERATURE_CAPTURE, name + '.png')});
}

test('filter portals preserve list geometry and return keyboard focus after Escape, toggling and outside press', async () => {
  for (const theme of ['light', 'dark']) {
    await mount({theme});
    const trigger = page.getByTestId('literature-filter-toggle');
    const popover = page.getByTestId('literature-filter-popover');
    const baseline = await geometry();
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflowY);
    await auditFloatingSurfaces(theme + ' default list');
    await resetLayoutShifts();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('literature-archived-toggle')).toBeFocused();
    const portal = await popover.evaluate(element => ({
      bodyContains: document.body.contains(element),
      rootContains: document.getElementById('root').contains(element),
      position: getComputedStyle(element).position,
      bodyOverflow: getComputedStyle(document.body).overflowY
    }));
    assert.deepEqual(portal, {bodyContains: true, rootContains: false, position: 'fixed', bodyOverflow});
    assertStableGeometry(baseline, await geometry(), 'open filter');
    await auditFloatingSurfaces(theme + ' filter open');
    await capture('zero-reflow-filter-' + theme);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    assertStableGeometry(baseline, await geometry(), 'Escape filter');

    await trigger.click();
    await expect(popover).toBeVisible();
    await trigger.click();
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    assertStableGeometry(baseline, await geometry(), 'repeat filter trigger');

    await trigger.click();
    await expect(popover).toBeVisible();
    await page.getByTestId('literature-search').click();
    await expect(popover).toBeHidden();
    await expect(page.getByTestId('literature-search')).toBeFocused();
    assertStableGeometry(baseline, await geometry(), 'outside filter press');
    await assertNoLayoutShift(theme + ' filter interactions');
  }
});

test('non-modal filter Tab order reaches the next toolbar control and rapid toggles finish cleanly', async () => {
  await mount();
  const trigger = page.getByTestId('literature-filter-toggle');
  const popover = page.getByTestId('literature-filter-popover');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-archived-toggle')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('literature-multiselect')).toBeFocused();
  await expect(popover).toBeHidden();

  const baseline = await geometry();
  await resetLayoutShifts();
  await trigger.focus();
  const elapsed = await trigger.evaluate(async element => {
    const start = performance.now();
    for (let index = 0; index < 5; index++) {
      element.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return performance.now() - start;
  });
  assert.ok(elapsed < 500, `Five filter toggles took ${elapsed}ms`);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(popover).toHaveCount(1);
  await expect(popover).toHaveAttribute('data-state', 'open');
  assertStableGeometry(baseline, await geometry(), 'rapid filter toggles');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();
  await assertNoLayoutShift('rapid filter toggles');
  await auditFloatingSurfaces('filter exit final state');
});

test('paper selection, fixed status tracks and Inspector processing details never resize the list', async () => {
  for (const theme of ['light', 'dark']) {
    await mount({theme});
    await page.getByTestId('literature-row-paper-0').click();
    const inspector = page.getByTestId('literature-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveAttribute('data-presentation', 'docked');
    assert.equal((await page.getByTestId('literature-inspector-track').boundingBox()).width, 340);
    const baseline = await geometry();
    await resetLayoutShifts();
    for (const id of ['paper-1', 'paper-2', 'paper-0']) {
      await page.getByTestId('literature-row-' + id).click();
      await expect(page.getByTestId('literature-row-' + id)).toHaveAttribute('aria-current', 'true');
      await expect(inspector).toContainText(id.replace('paper-', '').padStart(4, '0') + ' Understanding');
      assertStableGeometry(baseline, await geometry(), 'select ' + id);
    }
    for (const status of ['parsing', 'failed', 'cancelled', 'ready']) {
      await page.evaluate(status => window.setDocumentStatus(status), status);
      await settleRendering();
      const row = await page.getByTestId('literature-row-paper-0').evaluate(element => {
        const wrapper = element.closest('.library-row');
        return {rowHeight: wrapper.getBoundingClientRect().height,
          statusWidth: wrapper.querySelector('.library-row-status').getBoundingClientRect().width};
      });
      assert.equal(row.rowHeight, 64);
      assert.equal(row.statusWidth, 92);
      assertStableGeometry(baseline, await geometry(), 'document status ' + status);
    }
    await capture('zero-reflow-inspector-' + theme);
    const processingToggle = page.getByTestId('literature-processing-toggle');
    await processingToggle.click();
    await expect(page.locator('#literature-processing-details')).toBeVisible();
    await expect(page.getByTestId('literature-processing-job-job')).toBeVisible();
    assert.equal(await page.getByTestId('literature-processing').evaluate(element =>
      element.closest('[data-testid="literature-inspector"]') !== null), true);
    assertStableGeometry(baseline, await geometry(), 'processing expansion');
    await page.getByTestId('literature-processing-job-job').getByTestId('pipeline-stage-parse').click();
    await expect(page.getByTestId('literature-processing-stage-detail')).toBeVisible();
    assertStableGeometry(baseline, await geometry(), 'processing stage detail');
    await auditFloatingSurfaces(theme + ' processing details expanded');
    await capture('zero-reflow-processing-' + theme);
    await processingToggle.click();
    await expect(page.locator('#literature-processing-details')).toBeHidden();
    assertStableGeometry(baseline, await geometry(), 'processing collapse');
    await assertNoLayoutShift(theme + ' paper and processing interactions');
    await auditFloatingSurfaces(theme + ' Inspector exit final state');
  }
});

test('narrow canvas and narrow native window use a dismissible Inspector overlay without reducing list width', async () => {
  for (const theme of ['light', 'dark']) {
    for (const {width, windowWidth} of [{width: 820, windowWidth: 1450}, {width: 1100, windowWidth: 1100}, {width: 440, windowWidth: 960}]) {
      await mount({theme, width, windowWidth});
      const toggle = page.getByTestId('literature-toggle-inspector');
      const inspector = page.getByTestId('literature-inspector');
      const baseline = await geometry();
      await resetLayoutShifts();
      await page.getByTestId('literature-row-paper-0').click();
      await expect(inspector).toBeVisible();
      await expect(inspector).toHaveAttribute('data-presentation', 'overlay');
      assert.equal((await inspector.boundingBox()).width, 340);
      assertStableGeometry(baseline, await geometry(), 'narrow Inspector selection');
      const roots = await inspector.evaluate(element => {
        const list = document.querySelector('[data-testid="literature-list"]').getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return {overlaps: bounds.x < list.right && bounds.right > list.x,
          position: getComputedStyle(element).position};
      });
      assert.equal(roots.overlaps, true, JSON.stringify({theme, width, windowWidth, roots}));
      assert.ok(['fixed', 'absolute'].includes(roots.position), JSON.stringify(roots));
      await auditFloatingSurfaces(theme + ' narrow Inspector ' + width);
      await capture('zero-reflow-overlay-' + theme + '-' + width + '-' + windowWidth);
      await page.keyboard.press('Escape');
      await expect(inspector).toBeHidden();
      assertStableGeometry(baseline, await geometry(), 'narrow Inspector Escape');
      await toggle.click();
      await expect(inspector).toBeVisible();
      await toggle.click();
      await expect(inspector).toBeHidden();
      await expect(toggle).toBeFocused();
      assertStableGeometry(baseline, await geometry(), 'narrow Inspector repeated trigger');
      await toggle.click();
      await expect(inspector).toBeVisible();
      await page.getByTestId('literature-search').click({position: {x: 4, y: 12}});
      await expect(inspector).toBeHidden();
      await expect(page.getByTestId('literature-search')).toBeFocused();
      assertStableGeometry(baseline, await geometry(), 'narrow Inspector outside press');
      await assertNoLayoutShift(theme + ' narrow Inspector ' + width);
    }
  }
});

test('one thousand papers mount only the visible range and keep 64px rows through keyboard jumps', async () => {
  await mount();
  const metrics = await page.locator('.library-virtual-list').evaluate(element => ({
    count: element.querySelectorAll('.library-row').length,
    viewportHeight: element.clientHeight,
    heights: Array.from(element.querySelectorAll('.library-row'), row => row.getBoundingClientRect().height),
    gutter: getComputedStyle(element).scrollbarGutter
  }));
  assert.ok(metrics.count > 0 && metrics.count < 40, JSON.stringify(metrics));
  assert.ok(metrics.count < Math.ceil(metrics.viewportHeight / 64) + 10, JSON.stringify(metrics));
  assert.ok(metrics.heights.every(height => height === 64), JSON.stringify(metrics.heights));
  assert.equal(metrics.gutter, 'stable');
  await expect(page.getByTestId('literature-count')).toContainText('1,000');
  const first = page.getByTestId('literature-row-paper-0');
  await first.focus();
  await page.keyboard.press('End');
  const last = page.getByTestId('literature-row-paper-999');
  await expect(last).toBeVisible();
  await expect(last).toBeFocused();
  await expect(first).toHaveCount(0);
  assert.ok(await page.locator('.library-row').count() < 40);
  await page.keyboard.press('Home');
  await expect(first).toBeVisible();
  await expect(first).toBeFocused();
  await expect(last).toHaveCount(0);
  assert.ok(await page.locator('.library-row').count() < 40);
});

test('single click selects an Inspector and explicit reading still opens the retained full reader', async () => {
  await mount();
  await page.getByTestId('literature-row-paper-0').click();
  await expect(page.getByTestId('literature-inspector')).toBeVisible();
  await expect(page.getByTestId('literature-library-browse')).toBeVisible();
  await expect(page.getByTestId('paper-reader')).toBeHidden();
  await page.getByTestId('literature-row-paper-0').hover();
  const baseline = await geometry();
  await page.getByTestId('literature-read-paper-0').hover();
  assertStableGeometry(baseline, await geometry(), 'hover reading action');
  await auditFloatingSurfaces('literature reading action hover');
  await capture('zero-reflow-reading-action-hover');
  await page.getByTestId('literature-read-paper-0').click();
  await expect(page.getByTestId('reader-title')).toContainText('0000 Understanding');
  await expect(page.getByTestId('literature-library-browse')).toBeHidden();
  const reader = await page.getByTestId('paper-reader').boundingBox();
  assert.ok(reader.width >= 1278, `Full reader width: ${reader.width}`);

  await page.evaluate(() => window.openLiteratureObject({kind: 'reader', libraryItemId: 'paper-1'}));
  await expect(page.getByTestId('reader-title')).toContainText('0001 Understanding');
  await expect(page.getByTestId('literature-library-browse')).toBeHidden();
});

test('four-times CPU slowdown preserves geometry and zero layout shift while switching twenty papers', async t => {
  await mount();
  await page.getByTestId('literature-row-paper-0').click();
  await expect(page.getByTestId('literature-inspector-title')).toContainText('0000 Understanding');
  await settleRendering();
  const baseline = await geometry({includeFirstRow: false});
  const cdp = await page.context().newCDPSession(page);
  let workload;
  try {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    await resetLayoutShifts();
    const rawTracePath = process.env.ROC_LITERATURE_CAPTURE
      ? join(process.env.ROC_LITERATURE_CAPTURE, 'zero-reflow-4x-' + Date.now() + '.trace.json')
      : null;
    workload = await measureRendererWorkload(page, async () => {
      await page.getByTestId('literature-row-paper-0').focus();
      for (let index = 1; index <= 20; index++) {
        await page.keyboard.press('ArrowDown');
        await expect(page.getByTestId('literature-row-paper-' + index)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('literature-inspector-title')).toContainText(
          String(index).padStart(4, '0') + ' Understanding');
        assertStableGeometry(baseline, await geometry({includeFirstRow: false}), '4x paper ' + index);
      }
      const filter = page.getByTestId('literature-filter-toggle');
      await filter.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('literature-filter-popover')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('literature-filter-popover')).toBeHidden();
      await page.getByTestId('literature-processing-toggle').click();
      await expect(page.getByTestId('literature-processing-job-job')).toBeVisible();
      assertStableGeometry(baseline, await geometry({includeFirstRow: false}), '4x processing');
      await assertNoLayoutShift('4x twenty papers, filter and processing');
    }, {rawTracePath});
  } finally {
    try {
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    } finally {
      await cdp.detach();
    }
  }
  assert.ok(await page.locator('.library-row').count() < 40);
  t.diagnostic(JSON.stringify({
    cpuThrottlingRate: 4,
    paperSwitches: 20,
    cls: 0,
    mountedRows: await page.locator('.library-row').count(),
    longestTaskMs: workload.trace.longestTaskMs,
    layoutMs: workload.trace.layoutMs,
    paintMs: workload.trace.paintMs,
    frameIntervalMs: workload.frameIntervalMs,
    observedRafHz: workload.observedRafHz,
    inputToSecondRafMs: workload.inputToSecondRafMs,
    measurement: workload.measurement,
    rawTracePath: workload.rawTracePath
  }));
});
