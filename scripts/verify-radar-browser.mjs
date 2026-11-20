import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createSmokePaths,seedSmokeWorkspace} from '../tests/smoke/lib/fixtures.mjs';
import {resolveSmokeTarget} from '../tests/smoke/lib/smoke-target.mjs';
import {navigate} from './lib/gate-harness.mjs';

const paths=await createSmokePaths();seedSmokeWorkspace(paths.workspaceRoot,paths.remoteRoot);
const dir=resolve('.artifacts/reading-radar');mkdirSync(dir,{recursive:true});
const target=resolveSmokeTarget({env:{...process.env,ROC_SMOKE_TARGET:'dist'}});
const app=await electron.launch({executablePath:target.executablePath,args:target.launchArgs,env:{...process.env,ROC_SMOKE:'1',ROC_DATA_ROOT:paths.dataRoot}});
const results=[],errors=[];let page;
const check=(name,detail)=>{results.push({name,detail});console.log(`PASS ${name}`);};
const nativeState=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children
  .filter(view=>view.webContents&&view.webContents!==BrowserWindow.getAllWindows()[0].webContents)
  .map(view=>({url:view.webContents.getURL(),visible:view.getVisible(),bounds:view.getBounds(),id:view.webContents.id})));
try{
 page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 await page.waitForSelector('[data-testid="roc-app"]');
 const project=await page.evaluate(async workspacePath=>{const result=await window.roc.research.createProject({title:'Radar acceptance',description:'Native fixture',workspacePath});if(!result.ok)throw new Error(result.error.message);return result.data;},paths.workspaceRoot);
 // Synthetic HTTPS responses in the isolated radar partition; actual native view and IPC.
 await app.evaluate(({session,BrowserWindow})=>{
   session.fromPartition(`radar-${BrowserWindow.getAllWindows()[0].id}`).protocol.handle('https',request=>new Response(`<!doctype html><html><head><title>Radar fixture</title></head><body><h1>${new URL(request.url).hostname}</h1><article class="paper"><h2>Native discovery fixture</h2><a href="https://arxiv.org/abs/2611.00001">Paper</a><a href="https://doi.org/10.1234/fixture">DOI</a></article>${new URL(request.url).hostname==='modelscope.cn'?'<a href="/papers/2611.00002" data-autolog="c4=123%2FNative%20card%20title"><div>Native card title</div><div>Fixture abstract and tags must not become the title.</div></a>':''}</body></html>`,{headers:{'content-type':'text/html'}}));
 });
 await navigate(page,`page=research&project=${project.id}&view=literature`);
 await page.getByRole('tab',{name:'学术雷达',exact:true}).click();
 await page.getByRole('tab',{name:'Cool Papers',exact:true}).click();
 await expect.poll(nativeState).toMatchObject([{url:'https://papers.cool/arxiv/cs.AI',visible:true}]);
 const isolated=await app.evaluate(async({webContents})=>{
   const contents=webContents.getAllWebContents().find(contents=>contents.getURL().startsWith('https://papers.cool'));
   return contents.executeJavaScript('({node:typeof require,bridge:typeof window.roc,title:document.title})');
 });
 assert.deepEqual(isolated,{node:'undefined',bridge:'undefined',title:'Radar fixture'});check('isolated native Cool Papers view',isolated);
 const originalId=(await nativeState())[0].id;
 await page.evaluate(()=>history.replaceState(history.state,'',`${location.pathname}${location.search}${location.hash}`));
 assert.equal((await nativeState())[0]?.id,originalId,'same-document shell navigation keeps native view');
 await page.keyboard.press('Meta+k');await expect(page.getByRole('dialog')).toBeVisible();
 await expect.poll(nativeState).toMatchObject([{visible:false}]);
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(nativeState).toMatchObject([{visible:true}]);check('command palette hides native view and restores it');
 await page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Native discovery fixture'})).toHaveCount(2);
 await expect.poll(nativeState).toMatchObject([{visible:false}]);
 check('native page extraction retains arXiv and DOI identities');
 await page.getByRole('button',{name:'返回浏览',exact:true}).click();await expect.poll(nativeState).toMatchObject([{visible:true}]);
 await page.getByRole('tab',{name:'魔搭论文',exact:true}).click();await expect.poll(nativeState).toMatchObject([{url:'https://modelscope.cn/papers',visible:true}]);
 assert.notEqual((await nativeState())[0].id,originalId);check('source switching closes former web contents');
 await page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Native card title',exact:true})).toHaveCount(1);
 await page.getByRole('button',{name:'返回浏览',exact:true}).click();await expect.poll(nativeState).toMatchObject([{visible:true}]);
 check('ModelScope card title excludes abstract and tags');
 const auditSource=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
 // Exercise shell breakpoints below the production window's native minimum.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setMinimumSize(800,640));
 for(const width of [800,1000,1099,1100]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
   await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(width);
   while(await page.getByRole('dialog').count()){
     await expect.poll(nativeState).toMatchObject([{visible:false}]);
     await page.keyboard.press('Escape');
     await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
   }
   for(const theme of ['light','dark']){
     await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle('dark',theme==='dark');},theme);
     await page.getByRole('button',{name:'刷新网页',exact:true}).hover();
     await expect.poll(async()=>{
       const rect=await page.getByLabel('魔搭论文浏览区').boundingBox(),view=(await nativeState())[0];
       return rect&&view&&Math.abs(view.bounds.x-rect.x)<2&&Math.abs(view.bounds.width-rect.width)<2;
     }).toBe(true);
     const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
     assert.equal(audit.cut,0);results.push({width,theme,state:'native-hover',audit});
     await page.screenshot({path:resolve(dir,`native-${theme}-${width}.png`)});
     const nativePng=await app.evaluate(async({BrowserWindow})=>{
       const window=BrowserWindow.getAllWindows()[0];
       const view=window.contentView.children.find(view=>view.webContents&&view.webContents!==window.webContents);
       return (await view.webContents.capturePage()).toPNG().toString('base64');
     });
     writeFileSync(resolve(dir,`native-content-${theme}-${width}.png`),Buffer.from(nativePng,'base64'));
   }
 }
 await page.getByRole('tab',{name:'RSS 订阅',exact:true}).click();await expect.poll(nativeState).toMatchObject([{visible:false}]);
 await page.getByLabel('订阅名称',{exact:true}).fill('Failed feed');await page.getByLabel('RSS 地址',{exact:true}).fill('https://127.0.0.1/feed');
 await page.getByRole('button',{name:'添加订阅',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'公开互联网'})).toBeVisible();
 await page.getByText('管理订阅',{exact:true}).click();
 await page.getByRole('button',{name:'置顶',exact:true}).click();
 await expect(page.getByRole('button',{name:'取消置顶',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'移除',exact:true}).click();
 await expect(page.getByRole('button',{name:'恢复',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'恢复',exact:true}).click();
 await expect(page.getByRole('button',{name:'移除',exact:true})).toBeEnabled();
 const feeds=await page.evaluate(async projectId=>(await window.roc.research.listRadarFeeds({projectId})).data,project.id);
 assert.equal(feeds.length,1);assert.equal(feeds[0].pinned,true);assert.equal(feeds[0].archived,false);assert.match(feeds[0].error,/公开互联网/);
 const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);assert.equal(audit.cut,0);
 check('RSS error persistence, pin, remove and restore through real IPC',{feeds,audit});
 await page.screenshot({path:resolve(dir,'rss-management.png')});
 assert.deepEqual(errors,[]);check('no renderer exceptions');
}catch(error){if(page)await page.screenshot({path:resolve(dir,'native-failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;results.push({error:String(error),errors});}
finally{writeFileSync(resolve(dir,'native-results.json'),JSON.stringify(results,null,2));await app.close();}
