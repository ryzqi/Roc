import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
const clipSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-page-ui-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],style:'body{overflow:auto}',script:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {PageUiGallery} from ${JSON.stringify(join(process.cwd(),'tests/renderer/fixtures/page-ui-gallery.tsx'))};
    import './src/renderer/styles/index.css';
    window.actions=[];
    createRoot(document.getElementById('root')).render(<PageUiGallery onAction={action=>window.actions.push(action)}/>);
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:1100}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('page-gallery').waitFor();
});
after(async()=>{
  try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});

test('page composition preserves headings, native row actions and existing information states',async()=>{
  await expect(page.getByRole('heading',{level:1})).toHaveText('科学证据与可重复研究');
  await expect(page.getByRole('region',{name:'近期文献'})).toContainText('实验条件与开放数据');
  await expect(page.getByRole('region',{name:'当前任务'}).getByRole('status')).toContainText('正在读取任务');
  await expect(page.getByRole('region',{name:'读取失败'}).getByRole('alert')).toContainText('文献来源暂时无法读取');
  await expect(page.getByRole('region',{name:'工作目录'}).getByRole('note')).toContainText('工作目录未绑定');
  const row=page.getByTestId('page-row');
  await expect(page.getByTestId('page-row-current')).toHaveAttribute('aria-current','true');
  await row.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(()=>window.actions),['open','open']);
  await expect(page.getByTestId('page-row-disabled')).toBeDisabled();
  await page.getByTestId('page-row-disabled').click({force:true});
  assert.deepEqual(await page.evaluate(()=>window.actions),['open','open']);
  await page.getByRole('button',{name:'重试',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.actions.at(-1)),'retry');
});

test('page patterns retain focus and long text at desktop and narrow container sizes',async()=>{
  for(const theme of ['light','dark'])for(const density of ['compact','comfortable']) {
    await page.evaluate(({theme,density})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.density=density;},{theme,density});
    for(const width of [1184,1280,1440]) {
      await page.setViewportSize({width,height:1100});
      const row=page.getByTestId('page-row');await row.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
      await expect(row).toBeFocused();
      assert.equal(await row.evaluate(element=>getComputedStyle(element).outlineWidth),'2px');
      assert.equal(await page.getByTestId('page-gallery').evaluate(element=>element.scrollWidth>element.clientWidth),false);
      assert.equal((await page.evaluate(source=>(0,eval)(source)({viewport:true}),clipSource)).cut,0);
      if(process.env.ROC_UI_AUDIT_DIR) {
        await mkdir(process.env.ROC_UI_AUDIT_DIR,{recursive:true});
        await page.screenshot({path:join(process.env.ROC_UI_AUDIT_DIR,`page-ui-${theme}-${density}-${width}.png`)});
      }
    }
  }
  await page.getByTestId('page-gallery').evaluate(element=>{
    element.style.width='320px';
    element.querySelector('h1').textContent='研究'.repeat(500);
  });
  assert.equal(await page.getByTestId('page-gallery').evaluate(element=>element.scrollWidth>element.clientWidth),false);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.getByTestId('page-row')).toHaveAttribute('type','button');
});
