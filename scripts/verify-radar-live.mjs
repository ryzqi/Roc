// Opt-in public-site acceptance through Roc's actual native browser and IPC.
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createSmokePaths,seedSmokeWorkspace} from '../tests/smoke/lib/fixtures.mjs';
import {resolveSmokeTarget} from '../tests/smoke/lib/smoke-target.mjs';
import {navigate} from './lib/gate-harness.mjs';
const paths=await createSmokePaths();seedSmokeWorkspace(paths.workspaceRoot,paths.remoteRoot);
const target=resolveSmokeTarget({env:{...process.env,ROC_SMOKE_TARGET:'dist'}});
const app=await electron.launch({executablePath:target.executablePath,args:target.launchArgs,env:{...process.env,ROC_SMOKE:'1',ROC_DATA_ROOT:paths.dataRoot}});
const results=[];mkdirSync('.artifacts/reading-radar',{recursive:true});
try{
 const page=await app.firstWindow();await page.waitForSelector('[data-testid="roc-app"]');
 const project=await page.evaluate(async workspacePath=>{const result=await window.roc.research.createProject({title:'Live radar acceptance',description:'Public sources',workspacePath});if(!result.ok)throw new Error(result.error.message);return result.data;},paths.workspaceRoot);
 await navigate(page,`page=research&project=${project.id}&view=literature`);
 await page.getByRole('tab',{name:'学术雷达',exact:true}).click();
 for(const [source,label,origin] of [['cool','Cool Papers','https://papers.cool'],['modelscope','魔搭论文','https://modelscope.cn']]){
  try{
   await page.getByRole('tab',{name:label,exact:true}).click();
   await expect.poll(()=>app.evaluate(({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return !!contents&&!contents.isLoading();
   },origin),{timeout:45000}).toBe(true);
   await expect.poll(()=>app.evaluate(async({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return contents?contents.executeJavaScript('document.links.length'):0;
   },origin),{timeout:15000}).toBeGreaterThan(0);
   const detail=await app.evaluate(async({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return contents.executeJavaScript('({title:document.title,text:document.body.innerText.slice(0,500),links:document.links.length,node:typeof require,bridge:typeof window.roc})');
   },origin);
   assert.equal(detail.node,'undefined');assert.equal(detail.bridge,'undefined');assert.ok(detail.links>0);
   detail.paperMarkup=await app.evaluate(async({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return contents.executeJavaScript('Array.from(document.links).find(link=>/\\/(?:papers|arxiv)\\/\\d{4}\\.\\d{4,5}/.test(link.href))?.outerHTML.slice(0,10000)');
   },origin);
   await page.getByRole('button',{name:'读取当前页论文 / 入库',exact:true}).click();
   await expect.poll(()=>page.getByTestId('radar-browser').getByRole('heading').count(),{timeout:30000}).toBeGreaterThan(0);
   detail.extractedTitles=await page.getByTestId('radar-browser').getByRole('heading').allTextContents();
   const png=await app.evaluate(async({webContents},origin)=>(await webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin)).capturePage()).toPNG().toString('base64'),origin);
   writeFileSync(`.artifacts/reading-radar/live-${source}.png`,Buffer.from(png,'base64'));
   results.push({source,ok:true,detail});console.log(`PASS ${source}`,JSON.stringify({title:detail.title,links:detail.links,extracted:detail.extractedTitles.length,firstTitle:detail.extractedTitles[0],node:detail.node,bridge:detail.bridge}));
  }catch(error){
   const detail=await app.evaluate(async({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return contents?contents.executeJavaScript('({url:location.href,title:document.title,text:document.body?.innerText.slice(0,1500),links:document.links.length,readyState:document.readyState})'):null;
   },origin).catch(()=>null);
   const png=await app.evaluate(async({webContents},origin)=>{
    const contents=webContents.getAllWebContents().find(value=>value.getURL().startsWith(origin));
    return contents?(await contents.capturePage()).toPNG().toString('base64'):null;
   },origin).catch(()=>null);
   if(png)writeFileSync(`.artifacts/reading-radar/live-${source}-failure.png`,Buffer.from(png,'base64'));
   results.push({source,ok:false,error:String(error),detail});console.log(`FAIL ${source}`,String(error),JSON.stringify(detail));process.exitCode=1;
  }
 }
}finally{writeFileSync('.artifacts/reading-radar/live-native.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));await app.close();}
