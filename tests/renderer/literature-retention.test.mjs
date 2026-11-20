// Real Electron and literature store; only IPC is replaced.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

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
      const root = createRoot(document.getElementById('root'));
      const client = {api: {research: {
        listLibrary: async ({query}) => { window.libraryRequests = (window.libraryRequests ?? 0) + 1; return ({ok: true, data: Array.from({length:200}, (_,n) =>
          ({id:query+':'+n, title:query, abstract:'x'.repeat(4096)}))}); },
        wikiSnapshot: async () => ({ok:true, data:{sources:[]}}),
        onLibraryChanged: () => () => {}
      }}};
      function CacheCapture() {window.auditCache = useSWRConfig().cache; return null;}
      function Store({projectId}) {window.auditStore = useLiteratureStore(client, projectId); return null;}
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
    assert.deepEqual(errors,[]);

  } finally {
    try {await app?.close();} finally {rmSync(dir,{recursive:true,force:true});}
  }
});
