import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import DiscoverySearch from './src/renderer/literature/DiscoverySearch';
    import {useLiteratureImportActions} from './src/renderer/literature/use-literature-import-actions';
    const record=id=>({id,title:'Paper '+id,authors:['Author'],publishedYear:2026,openAccessUrl:null});
    const candidate=id=>({candidateId:id,identity:id,record:record(id),archived:false,
      matchedLibraryItemId:id==='known'?'existing':null,conflicts:[],identityConflicts:[],versionRelations:[],
      origins:[{source:'crossref',rank:1,externalId:id,record:record(id),review:{publicationType:null,copies:[],updates:[],retraction:{status:'unknown'}}}]});
    window.searches=[]; window.imports=[];
    const client={api:{research:{
      searchLiterature:async input=>{window.searches.push(input);if(window.holdSearch)await new Promise(resolve=>{window.finishSearch=resolve;});return {ok:true,data:{searchId:'search-one',status:'partial',total:3,
        candidates:['known','first','second'].map(candidate),warnings:[],truncated:false,
        sources:[{source:'crossref',status:'ok',returnedCount:3,errorCode:null,retryAfterMs:null},
          {source:'semantic_scholar',status:'rate_limited',returnedCount:0,errorCode:'rate_limit',retryAfterMs:30000}]}};},
      addLiterature:async input=>{window.imports.push(input);return {ok:true,data:{operationId:'import-one',status:'partial',
        counts:{created:1,linked:0,alreadyPresent:0,skippedArchived:0,failed:1,cancelled:0,notProcessed:0},
        items:[{entryKey:'first',inputPositions:[0],disposition:'created',errorCode:null},
          {entryKey:'second',inputPositions:[1],disposition:'failed',errorCode:'source_expired'}]}};}
    }}};
    const store={client,projectId:'fixture',items:[{id:'existing'}],reload(){}};
    function Harness(){const actions=useLiteratureImportActions({store});
      return <DiscoverySearch store={store} actions={actions} writable onOpenLibrary={()=>window.openedLibrary=true}/>;}
    createRoot(document.getElementById('root')).render(<Harness/>);
  `, style: 'html,body,#root{height:100%;margin:0}body{font-family:-apple-system,sans-serif}' });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
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
after(async () => {
  try { await app?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
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
