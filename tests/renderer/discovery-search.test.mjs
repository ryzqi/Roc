import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-discovery-'));
  await buildViteRenderer({ directory, script: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import DiscoverySearch from './src/renderer/literature/DiscoverySearch';
    import {useLiteratureImportActions} from './src/renderer/literature/use-literature-import-actions';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    const record=id=>({id,title:'Paper '+id,authors:['Author'],publishedYear:2026,openAccessUrl:null,
      abstract:'Abstract for '+id+'. '.repeat(160),doi:'10.1234/'+id,url:'https://example.invalid/'+id});
    const candidate=id=>({candidateId:id,identity:id,record:record(id),archived:false,
      matchedLibraryItemId:id==='known'?'existing':null,conflicts:[],identityConflicts:[],versionRelations:[],
      origins:[{source:'crossref',rank:1,externalId:id,record:record(id),review:{publicationType:null,copies:[],updates:[],retraction:{status:'unknown'}}}]});
    window.searches=[]; window.imports=[]; window.pages=[];
    const progressListeners=new Set();
    window.progressListeners=()=>progressListeners.size;
    window.emitProgress=event=>{for(const listener of progressListeners)listener(event);};
    const client={api:{research:{
      onLiteratureSearchProgress:listener=>{progressListeners.add(listener);return()=>progressListeners.delete(listener);},
      searchLiterature:async input=>{window.searches.push(input);if(window.holdSearch)await new Promise(resolve=>{window.finishSearch=resolve;});
        if(window.failSearch)return {ok:false,error:{message:'Synthetic search unavailable'}};
        const ids=window.pagedResults?Array.from({length:30},(_,i)=>'paged-'+i):window.largeResults?['known','first','second',...Array.from({length:40},(_,i)=>'extra-'+i)]:['known','first','second'];
        return {ok:true,data:{searchId:'search-one',status:'partial',total:window.pagedResults?65:ids.length,nextOffset:window.pagedResults?30:null,
        candidates:ids.map(candidate),warnings:[],truncated:false,
        sources:[{source:'crossref',status:'ok',returnedCount:3,errorCode:null,retryAfterMs:null},
          {source:'semantic_scholar',status:'rate_limited',returnedCount:0,errorCode:'rate_limit',retryAfterMs:30000}]}};},
      readLiteratureSearch:async input=>{window.pages.push(input);if(window.holdPage)await new Promise(resolve=>window.finishPage=resolve);
        if(window.failPage)return {ok:false,error:{message:'Page unavailable'}};
        return {ok:true,data:{searchId:input.searchId,status:'complete',total:65,nextOffset:input.offset===30?60:null,
          candidates:Array.from({length:Math.min(30,65-input.offset)},(_,i)=>candidate('paged-'+(input.offset+i))),sources:[],warnings:[],truncated:false}};},
      addLiterature:async input=>{window.imports.push(input);return {ok:true,data:{operationId:'import-one',status:'partial',
        counts:{created:1,linked:0,alreadyPresent:0,skippedArchived:0,failed:1,cancelled:0,notProcessed:0},
        items:[{entryKey:'first',inputPositions:[0],disposition:'created',errorCode:null},
          {entryKey:'second',inputPositions:[1],disposition:'failed',errorCode:'source_expired'}]}};}
    }}};
    function Harness(){const [projectId,setProject]=useState('fixture');window.setProject=setProject;
      const [active,setActive]=useState(true);window.setActive=setActive;
      const store={client,projectId,items:[{id:'existing'}],reload(){}};const actions=useLiteratureImportActions({store});
      return <ViewActivity active={active}><DiscoverySearch store={store} actions={actions} writable onOpenLibrary={()=>window.openedLibrary=true}/></ViewActivity>;}
    createRoot(document.getElementById('root')).render(<Harness/>);
  `, style: 'html,body,#root{height:100%;margin:0}body{font-family:-apple-system,sans-serif}' });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
});

test('wide search has a separate candidate preview and narrow return keeps query, selection and scroll', async () => {
  await page.reload();
  await page.setViewportSize({width: 1200, height: 900});
  await page.evaluate(() => {window.largeResults = true;});
  await page.getByLabel('研究主题或关键词').fill('retained search');
  await page.getByTestId('discovery-submit').click();
  await expect(page.getByTestId('discovery-preview')).toContainText('Abstract for known');
  const geometry = await page.locator('.discovery-result-workspace').evaluate(element => {
    const list = element.querySelector('.discovery-result-list').getBoundingClientRect();
    const preview = element.querySelector('.discovery-preview').getBoundingClientRect();
    return {ratio: list.width / (list.width + preview.width), beside: preview.left >= list.right - 1};
  });
  assert.ok(geometry.beside && Math.abs(geometry.ratio - .65) < .02, JSON.stringify(geometry));
  await page.getByLabel('选择 Paper first', {exact: true}).check();
  await page.getByTestId('discovery-preview-first').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('discovery-preview')).toContainText('Abstract for first');
  await expect(page.getByTestId('discovery-preview')).toContainText('10.1234/first');

  const audit = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({width: 420, height: 900});
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    await page.getByRole('button', {name: '返回搜索结果'}).click();
    await expect(page.getByTestId('discovery-preview-first')).toBeFocused();
    await page.getByTestId('discovery-preview-extra-30').click();
    const scroll = await page.locator('.discovery-result-list').evaluate(element => element.scrollTop);
    assert.ok(scroll > 0);
    await expect(page.getByTestId('discovery-preview')).toContainText('Abstract for extra-30');
    const clipping = await page.evaluate(source => (0,eval)(source)({root:'#root', viewport:true}), audit);
    assert.equal(clipping.cut, 0, JSON.stringify(clipping.issues));
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discovery-preview-extra-30')).toBeFocused();
    assert.equal(await page.locator('.discovery-result-list').evaluate(element => element.scrollTop), scroll);
    await expect(page.getByLabel('研究主题或关键词')).toHaveValue('retained search');
    await expect(page.getByLabel('选择 Paper first', {exact: true})).toBeChecked();
    // Reopen before the next viewport/theme iteration.
    await page.getByTestId('discovery-preview-first').click();
  }
  await page.getByRole('button', {name: '返回搜索结果'}).click();
  await page.evaluate(() => {window.failSearch = true;});
  await page.getByTestId('discovery-submit').click();
  await expect(page.getByRole('alert')).toContainText('Synthetic search unavailable');
  await expect(page.getByTestId('discovery-preview-first')).toBeVisible();
  await expect(page.getByLabel('选择 Paper first', {exact: true})).toBeChecked();
});

test('discovery keeps a real loading state and accepts one request during same-turn repeat submits', async () => {
  await page.reload();
  await page.getByLabel('研究主题或关键词').fill('evidence retrieval');
  await page.evaluate(() => {
    window.holdSearch = true;
    const form = document.querySelector('[data-testid="discovery-search"] form');
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  });
  await expect(page.getByTestId('discovery-submit')).toBeDisabled();
  await expect(page.getByTestId('discovery-submit')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toContainText('正在检索论文…');
  assert.equal(await page.evaluate(() => window.searches.length), 1);
  await page.evaluate(() => window.finishSearch());
  await expect(page.getByTestId('discovery-submit')).toBeEnabled();
  await expect(page.getByTestId('discovery-source-report')).toContainText('部分来源未完成');
});

test('discovery renders actual early source records and ignores unrelated or late progress', async()=>{
  await page.reload();
  await page.evaluate(()=>{window.holdSearch=true;});
  await page.getByLabel('研究主题或关键词').fill('progress query');
  await page.getByTestId('discovery-submit').click();
  await page.evaluate(()=>{
    const request=window.searches[0];
    const event={requestId:request.requestId,projectId:request.projectId,completedSources:1,totalSources:6,
      source:{source:'crossref',status:'ok',returnedCount:1,errorCode:null,retryAfterMs:null},records:[{title:'Early source record'}]};
    window.emitProgress({...event,requestId:'another-request',records:[{title:'Wrong record'}]});
    window.emitProgress(event);
  });
  await expect(page.getByTestId('discovery-source-progress')).toContainText('Crossref：已返回 1 篇');
  await expect(page.getByTestId('discovery-source-progress')).toContainText('Early source record');
  await expect(page.getByTestId('discovery-source-progress')).not.toContainText('Wrong record');
  assert.equal(await page.getByTestId('discovery-add-selected').count(),0);
  await page.evaluate(()=>window.finishSearch());
  await expect(page.getByTestId('discovery-source-progress')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.progressListeners()),0);
});

test('discovery reads every retained candidate page, preserves selection on failure and caps imports at 30',async()=>{
  await page.reload();await page.evaluate(()=>{window.pagedResults=true;});
  await page.getByLabel('研究主题或关键词').fill('paged query');
  await page.getByTestId('discovery-submit').click();
  await page.getByLabel('选择 Paper paged-0',{exact:true}).check();
  await page.evaluate(()=>{window.failPage=true;});
  await page.getByTestId('discovery-load-more').click();
  await expect(page.getByRole('alert')).toHaveText('Page unavailable');
  await expect(page.getByLabel('选择 Paper paged-0',{exact:true})).toBeChecked();
  await page.evaluate(()=>{window.failPage=false;});
  await page.getByTestId('discovery-load-more').click();
  await expect(page.getByTestId('discovery-load-more')).toHaveText('加载更多（60 / 65）');
  await page.getByTestId('discovery-load-more').click();
  await expect(page.getByTestId('discovery-preview-paged-64')).toBeVisible();
  await expect(page.getByTestId('discovery-load-more')).toHaveCount(0);
  await page.getByLabel('选择可添加文献',{exact:true}).check();
  await expect(page.getByTestId('discovery-add-selected')).toHaveText('加入文献库（30 篇）');
  await page.getByLabel('选择 Paper paged-64',{exact:true}).click();
  await expect(page.getByLabel('选择 Paper paged-64',{exact:true})).not.toBeChecked();
  const requests=await page.evaluate(()=>({search:window.searches[0],pages:window.pages}));
  assert.equal(requests.search.pageSize,30);
  assert.deepEqual(requests.pages.map(item=>[item.offset,item.limit,item.projectId]),[[30,30,'fixture'],[30,30,'fixture'],[60,30,'fixture']]);
});

test('late search and candidate page responses cannot populate a different project',async()=>{
  await page.reload();await page.evaluate(()=>{window.pagedResults=true;});
  await page.getByLabel('研究主题或关键词').fill('old project');await page.getByTestId('discovery-submit').click();
  await page.evaluate(()=>{window.holdPage=true;});await page.getByTestId('discovery-load-more').click();
  await page.evaluate(()=>window.setProject('next-project'));
  await expect(page.getByLabel('研究主题或关键词')).toHaveValue('');
  await page.evaluate(()=>window.finishPage());
  await expect(page.getByTestId('discovery-preview-paged-30')).toHaveCount(0);
  await page.evaluate(()=>{window.holdSearch=true;});
  await page.getByLabel('研究主题或关键词').fill('held search');await page.getByTestId('discovery-submit').click();
  await page.evaluate(()=>window.setProject('third-project'));
  await page.evaluate(()=>window.finishSearch());
  await expect(page.getByTestId('discovery-source-report')).toHaveCount(0);
  await expect(page.getByTestId('discovery-submit')).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>window.progressListeners())).toBe(0);
});
after(async () => {
  try { await app?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});

test('hidden discovery releases result DOM and restores selection, preview and scroll without another search', async () => {
  await page.reload();
  await page.setViewportSize({width: 1200, height: 900});
  await page.evaluate(() => {window.largeResults = true;});
  await page.getByLabel('研究主题或关键词').fill('retained discovery');
  await page.getByTestId('discovery-submit').click();
  await page.getByLabel('选择 Paper first', {exact: true}).check();
  await page.getByTestId('discovery-preview-extra-30').click();
  const before = await page.locator('.discovery-result-list').evaluate(node => node.scrollTop);
  assert.ok(before > 0);
  await page.evaluate(() => window.setActive(false));
  await expect(page.locator('.discovery-result-workspace')).toHaveCount(0);
  await expect(page.getByLabel('研究主题或关键词')).toHaveValue('retained discovery');
  await page.evaluate(() => window.setActive(true));
  await expect(page.getByTestId('discovery-preview')).toContainText('Abstract for extra-30');
  await expect(page.getByLabel('选择 Paper first', {exact: true})).toBeChecked();
  await expect.poll(() => page.locator('.discovery-result-list').evaluate(node => node.scrollTop)).toBe(before);
  assert.equal(await page.evaluate(() => window.searches.length), 1);
});

test('explicit discovery search reports partial sources and excludes known project papers from bulk import', async () => {
  await page.reload();
  await page.getByLabel('研究主题或关键词').fill('agent safety');
  await page.getByRole('button', { name: '近 2 年', exact: true }).click();
  assert.equal(await page.evaluate(() => window.searches.length), 0);
  await page.getByTestId('discovery-submit').click();
  await expect(page.getByTestId('discovery-source-report')).toContainText('部分来源未完成');
  await expect(page.getByTestId('discovery-source-report')).toContainText('Semantic Scholar：请求受限，30 秒后可重试');
  await expect(page.getByRole('button', { name: '已在文献库', exact: true })).toBeDisabled();
  await page.getByLabel('选择可添加文献').check();
  await expect(page.getByTestId('discovery-add-selected')).toHaveText('加入文献库（2 篇）');
  await page.getByTestId('discovery-add-selected').click();
  await expect(page.getByTestId('discovery-receipt')).toContainText('已收录 1 篇');
  await expect(page.getByTestId('discovery-receipt')).toContainText('失败 1 篇');
  await expect(page.getByTestId('discovery-receipt')).toContainText('Paper second：添加失败（source_expired）');
  await expect(page.getByTestId('discovery-add-selected')).toHaveText('加入文献库（1 篇）');
  const captured = await page.evaluate(() => ({ search: window.searches[0], imported: window.imports[0] }));
  assert.equal(captured.search.projectId, 'fixture');
  assert.equal(captured.search.yearFrom, new Date().getFullYear() - 1);
  assert.deepEqual(captured.imported.entries.map(entry => entry.candidateId), ['first', 'second']);
  assert.equal(captured.imported.ingestionPolicy, 'fulltext_auto');
  await page.getByRole('button', { name: '查看文献库', exact: true }).click();
  assert.equal(await page.evaluate(() => window.openedLibrary), true);
});
