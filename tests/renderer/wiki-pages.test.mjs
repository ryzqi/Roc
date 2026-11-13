import {after, afterEach, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
let directory,app,page,api,active,windowId;
const fixtures=[],errors=[],holds=[],artifacts=join(process.cwd(),'.artifacts/knowledge-wiki');
function deferred() {
  let release;
  const promise=new Promise(resolve=>{release=resolve;});
  const value={promise,release};holds.push(value);return value;
}
before(async()=>{
  api=await loadResearchTestApi();directory=mkdtempSync(join(tmpdir(),'roc-wiki-pages-'));mkdirSync(artifacts,{recursive:true});
  await buildViteRenderer({directory,script:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {WikiWorkspace} from './src/renderer/literature/WikiWorkspace';
    import {requestNavigation} from './src/renderer/app/navigation-guard';
    const root=createRoot(document.getElementById('root'));
    const methods=['searchWiki','readWiki','createWiki','saveWiki','compileWiki','rollbackWiki','wikiHistory','wikiRevision'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>{
      window.wikiCalls.push({method,input});return window.fromMain(method,input);
    }]))}};
    let generation=0;
    window.mount=(projectId,snapshot,writable=true)=>{window.wikiCalls=[];window.navigations=0;flushSync(()=>root.render(
      <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict><WikiWorkspace key={++generation}
      client={client} projectId={projectId} snapshot={snapshot} writable={writable} claims={snapshot.claims}
      evidence={snapshot.sources.map(s=>s.evidence)} libraryItems={[]} onOpenClaim={()=>{}}
      onAskAssistant={prompt=>window.promptForAssistant=prompt}/></LazyMotion></MotionConfig>));};
    window.navigateAway=()=>requestNavigation({page:'research',projectId:'another-project',view:'literature',
      tool:null,openFile:null,assistantOpen:false,newProject:false},()=>{window.navigations++;
        flushSync(()=>root.render(null));});
    window.hideWiki=hidden=>document.getElementById('root').hidden=hidden;
  `,style:'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{height:100vh;display:flex;flex-direction:column}'});
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:800}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});page=await app.firstWindow();page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('fromMain',async(method,input)=>{
    const f=active;
    if(f.holdMethod===method)await f.hold.promise;
    if(f.failMethod===method){f.failMethod=null;return {ok:false,error:{code:'synthetic_write_failure',message:'Wiki 写入失败注入'}};}
    return f.bridge.invoke(`research.${method}`,[input],windowId);
  });
  await page.waitForFunction(()=>typeof window.mount==='function');
});
afterEach(async context=>{
  for(const hold of holds)hold.release();
  if(page&&!page.isClosed()){
    await page.evaluate(()=>window.hideWiki(false));
    writeFileSync(join(artifacts,`${context.name.replace(/[^a-z0-9]+/gi,'-').slice(0,100)}.txt`),await page.locator('body').ariaSnapshot());
  }
});
after(async()=>{try{for(const hold of holds)hold.release();await app?.close();}finally{for(const f of fixtures){await f.repository.wiki.shutdown();f.close();}api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
async function scene() {
  const f=createResearchFixture(api,'reading');fixtures.push(f);active=f;
  f.repository.knowledge.upsertFromSource({id:'source',projectId:f.project.id,sourceType:'experiment',sourceId:'source',title:'Synthetic original source',
    content:'Original exact synthetic evidence.',chunks:[{content:'Original exact synthetic evidence.',locator:'results.csv:row:1'}],embeddingPolicy:'none'});
  f.evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'source:chunk:0'});
  const registry=new api.CapabilityRegistry();for(const c of api.researchWikiCapabilities)registry.declare('research',c);
  api.registerResearchWikiCapabilities({pluginId:'research',capabilities:registry},f.repository.wiki);
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(...args)=>registry.invoke(...args)});
  f.repository.wiki.start();await f.repository.wiki.idle();
  await page.evaluate(({projectId,snapshot})=>window.mount(projectId,snapshot),{projectId:f.project.id,snapshot:f.repository.evidence.wikiSnapshot(f.project.id)});
  await page.getByTestId('wiki-page-row').waitFor();return f;
}
test('real Electron/IPC: capture → create theme → edit human section → invalidate → compile → inspect history and rollback',async()=>{
  const f=await scene();
  await page.getByRole('button',{name:'新建主题页',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByLabel('页面标题',{exact:true}).fill('跨文献比较草稿');await page.getByLabel('页面类型',{exact:true}).selectOption('comparison');
  await page.getByTestId('wiki-create').getByRole('checkbox').first().check();await page.getByRole('button',{name:'创建草稿',exact:true}).click();
  const detail=page.getByTestId('wiki-page-detail');await detail.getByText('跨文献比较草稿',{exact:true}).waitFor();
  await detail.getByRole('button',{name:'刷新页面',exact:true}).click();await detail.getByTestId('wiki-section-body').waitFor();
  await detail.getByText(/原始证据：Synthetic original source/).click();
  await detail.locator('blockquote').waitFor({state:'visible'});
  assert.match(await detail.locator('blockquote').innerText(),/Original exact synthetic evidence/);
  await detail.getByRole('button',{name:'编辑章节',exact:true}).click();
  await page.getByLabel('章节正文',{exact:true}).fill('人工维护的比较，仍需科学审核。');
  assert.equal(await page.getByRole('button',{name:'主张与证据',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'保存人工章节',exact:true}).click();await detail.getByText('人工维护',{exact:true}).waitFor();
  await detail.getByText('自动编译保留',{exact:true}).waitFor();
  const topic=f.repository.wiki.search(f.project.id).find(p=>p.kind==='comparison');
  assert.equal(f.repository.wiki.read(f.project.id,topic.id).current.reason,'human');
  await detail.getByRole('button',{name:'交给助手综合',exact:true}).click();assert.match(await page.evaluate(()=>window.promptForAssistant),/research_wiki_draft/);
  f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);
  f.repository.wiki.wake();await f.repository.wiki.idle();await detail.getByRole('button',{name:'刷新页面',exact:true}).click();
  await detail.getByTestId('wiki-page-lint').getByText(/原始证据已失效/).waitFor();
  assert.match(await detail.getByTestId('wiki-section-body').innerText(),/人工维护的比较/);
  await detail.getByRole('button',{name:'修订历史',exact:true}).click();
  const revision = page.getByTestId('wiki-history').getByRole('button',{name:'r1 来源编译',exact:true});
  await revision.click();
  assert.equal(await revision.getAttribute('aria-pressed'),'true');
  await page.getByTestId('wiki-history-content').getByText('Original exact synthetic evidence.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'恢复 r1 为新修订',exact:true}).click();
  const status = detail.getByTestId('wiki-page-status');
  await status.getByText('历史恢复',{exact:true}).waitFor();
  assert.match(await status.innerText(),/比较\s+草稿 r\d+\s+已编译\s+历史恢复/);
  assert.match(await detail.getByTestId('wiki-page-lint').innerText(),/失效/);
  assert.equal(f.repository.wiki.read(f.project.id,topic.id).current.reason,'rollback');
  const auditSource=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  for(const theme of ['light','dark'])for(const width of [380,560,800,1100]){
    await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const audit=await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);writeFileSync(join(artifacts,`pages-${theme}-${width}.json`),JSON.stringify(audit));
    assert.equal(audit.cut,0);assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(artifacts,`pages-${theme}-${width}.png`)});
  }
});
test('stale edits retain typed text and expose conflict; read-only and no-project views cannot mutate',async()=>{
  const f=await scene();await page.getByTestId('wiki-page-row').click();const detail=page.getByTestId('wiki-page-detail');
  await detail.getByRole('button',{name:'编辑章节',exact:true}).click();await page.getByLabel('章节正文',{exact:true}).fill('Unsaved human work');
  f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);
  await page.getByRole('button',{name:'保存人工章节',exact:true}).click();
  await page.getByRole('alert').getByText(/依据已改变|页面已更新/).waitFor();assert.equal(await page.getByLabel('章节正文',{exact:true}).inputValue(),'Unsaved human work');
  await page.getByRole('button',{name:'取消编辑',exact:true}).click();
  await page.getByTestId('literature-editor-discard').getByRole('button',{name:'放弃录入并继续',exact:true}).click();
  await page.getByTestId('literature-editor-discard').waitFor({state:'detached'});
  await page.evaluate(({projectId,snapshot})=>window.mount(projectId,snapshot,false),{projectId:f.project.id,snapshot:f.repository.evidence.wikiSnapshot(f.project.id)});
  assert.equal(await page.getByRole('button',{name:'新建主题页',exact:true}).isDisabled(),true);
  await page.getByTestId('wiki-page-row').click();assert.equal(await page.getByRole('button',{name:'编辑章节',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.mount(null,{claims:[],sources:[],relations:[],papers:[]}));await page.getByText('选择研究项目以维护持久 Wiki 页面。',{exact:true}).waitFor();
});

async function openEditor(kind) {
  const f=await scene();
  if(kind==='create'){
    await page.getByRole('button',{name:'新建主题页',exact:true}).click();
    await page.getByLabel('页面标题',{exact:true}).fill('尚未提交的主题');
    await page.getByTestId('wiki-create').getByRole('checkbox').first().check();
    return {fixture:f, form:'wiki-create',field:'页面标题',value:'尚未提交的主题',method:'createWiki',cancel:'取消'};
  }
  await page.getByTestId('wiki-page-row').click();
  await page.getByRole('button',{name:'编辑章节',exact:true}).click();
  await page.getByLabel('章节正文',{exact:true}).fill('尚未保存的人工章节');
  return {fixture:f,form:'wiki-section-editor',field:'章节正文',value:'尚未保存的人工章节',method:'saveWiki',cancel:'取消编辑'};
}
async function unloadPrevented() {
  return page.evaluate(()=>{
    const event=new Event('beforeunload',{cancelable:true});
    window.dispatchEvent(event);return event.defaultPrevented;
  });
}
const discard=()=>page.getByTestId('literature-editor-discard');
for(const kind of ['create','section']){
  test(`Wiki ${kind} draft protects explicit cancel, hidden canvas and native unload`,async()=>{
    const editor=await openEditor(kind);
    assert.equal(await unloadPrevented(),true);
    await page.evaluate(()=>window.hideWiki(true));
    assert.equal(await unloadPrevented(),true);
    await page.evaluate(()=>window.hideWiki(false));
    assert.equal(await page.getByLabel(editor.field,{exact:true}).inputValue(),editor.value);
    await page.getByRole('button',{name:editor.cancel,exact:true}).click();
    await discard().waitFor();
    await discard().getByRole('button',{name:'继续编辑',exact:true}).click();
    await discard().waitFor({state:'detached'});
    assert.equal(await page.getByLabel(editor.field,{exact:true}).inputValue(),editor.value);
    await page.getByRole('button',{name:editor.cancel,exact:true}).click();
    await discard().getByRole('button',{name:'放弃录入并继续',exact:true}).click();
    await page.getByTestId(editor.form).waitFor({state:'detached'});
    await discard().waitFor({state:'detached'});
    assert.equal(await unloadPrevented(),false);
    assert.equal(await page.evaluate(method=>window.wikiCalls.filter(call=>call.method===method).length,editor.method),0);
  });
  test(`Wiki ${kind} project navigation waits for a decision and composes with other vetoes`,async()=>{
    const editor=await openEditor(kind);
    await page.evaluate(()=>window.navigateAway());
    assert.equal(await page.evaluate(()=>window.navigations),0);
    await discard().getByRole('button',{name:'继续编辑',exact:true}).click();
    await discard().waitFor({state:'detached'});
    assert.equal(await page.getByLabel(editor.field,{exact:true}).inputValue(),editor.value);
    await page.evaluate(()=>{
      window.addEventListener('roc:before-navigate',event=>event.preventDefault(),{once:true});
      window.navigateAway();
    });
    await discard().getByRole('button',{name:'放弃录入并继续',exact:true}).click();
    await discard().waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.navigations),0);
    assert.equal(await page.getByLabel(editor.field,{exact:true}).inputValue(),kind==='create'?'':'Original exact synthetic evidence.');
    await page.evaluate(()=>window.navigateAway());
    await page.getByTestId('wiki-pages').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.navigations),1);
  });
  test(`Wiki ${kind} same-event submissions run once and veto navigation until the receipt`,async()=>{
    const editor=await openEditor(kind), f=editor.fixture;
    f.holdMethod=editor.method;f.hold=deferred();
    const state=await page.evaluate(({form,method})=>{
      const element=document.querySelector('[data-testid="'+form+'"]');
      element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);
      window.navigateAway();
      return {calls:window.wikiCalls.filter(call=>call.method===method).length,
        unload:unload.defaultPrevented,navigations:window.navigations};
    },{form:editor.form,method:editor.method});
    assert.deepEqual(state,{calls:1,unload:true,navigations:0});
    assert.equal(await page.getByLabel(editor.field,{exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:editor.cancel,exact:true}).isDisabled(),true);
    f.holdMethod=null;f.hold.release();
    await page.getByTestId(editor.form).waitFor({state:'detached'});
    assert.equal(await unloadPrevented(),false);
  });
  test(`Wiki ${kind} failure keeps the exact draft and supports retry`,async()=>{
    const editor=await openEditor(kind),f=editor.fixture;
    f.failMethod=editor.method;
    await page.getByTestId(editor.form).getByRole('button',{name:kind==='create'?'创建草稿':'保存人工章节',exact:true}).click();
    await page.getByRole('alert').getByText('Wiki 写入失败注入',{exact:true}).waitFor();
    assert.equal(await page.getByLabel(editor.field,{exact:true}).inputValue(),editor.value);
    assert.equal(await page.getByLabel(editor.field,{exact:true}).isDisabled(),false);
    assert.equal(await unloadPrevented(),true);
    await page.getByTestId(editor.form).getByRole('button',{name:kind==='create'?'创建草稿':'保存人工章节',exact:true}).click();
    await page.getByTestId(editor.form).waitFor({state:'detached'});
    assert.equal(await unloadPrevented(),false);
  });
}
for(const kind of ['compile','history']){
  test(`Wiki ${kind} same-event actions run once and keep their receipt in the current project`,async()=>{
    let f;
    if(kind==='history'){
      const editor=await openEditor('section');f=editor.fixture;
      await page.getByRole('button',{name:'保存人工章节',exact:true}).click();
      await page.getByTestId(editor.form).waitFor({state:'detached'});
      await page.getByRole('button',{name:'修订历史',exact:true}).click();
      await page.getByRole('button',{name:'r1 来源编译',exact:true}).click();
      await page.getByTestId('wiki-history-content').waitFor();
    }else{
      f=await scene();await page.getByTestId('wiki-page-row').click();
      await page.getByRole('button',{name:'重新编译',exact:true}).waitFor();
    }
    const method=kind==='compile'?'compileWiki':'rollbackWiki';
    f.holdMethod=method;f.hold=deferred();
    const state=await page.evaluate(({kind,method})=>{
      const control=[...document.querySelectorAll('[data-testid="wiki-page-detail"] button')].find(button=>
        kind==='compile'?button.textContent==='重新编译':button.textContent==='恢复 r1 为新修订');
      control.click();control.click();
      const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);
      window.navigateAway();
      return {calls:window.wikiCalls.filter(call=>call.method===method).length,
        unload:unload.defaultPrevented,navigations:window.navigations};
    },{kind,method});
    assert.deepEqual(state,{calls:1,unload:true,navigations:0});
    assert.equal(await page.getByRole('button',{name:'主张与证据',exact:true}).isDisabled(),true);
    f.holdMethod=null;f.hold.release();
    await page.waitForFunction(()=>document.querySelector('[data-testid="wiki-page-detail"]')?.getAttribute('aria-busy')==='false');
    assert.equal(await unloadPrevented(),false);
  });
}
