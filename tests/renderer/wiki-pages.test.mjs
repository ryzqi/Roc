import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
let directory,app,page,api,active,windowId;
const fixtures=[],errors=[],artifacts=join(process.cwd(),'.artifacts/knowledge-wiki');
before(async()=>{
  api=await loadResearchTestApi();directory=mkdtempSync(join(tmpdir(),'roc-wiki-pages-'));mkdirSync(artifacts,{recursive:true});
  await buildViteRenderer({directory,script:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {WikiWorkspace} from './src/renderer/literature/WikiWorkspace';
    const root=createRoot(document.getElementById('root'));
    const methods=['searchWiki','readWiki','createWiki','saveWiki','compileWiki','rollbackWiki','wikiHistory','wikiRevision'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    let generation=0;
    window.mount=(projectId,snapshot,writable=true)=>flushSync(()=>root.render(<WikiWorkspace key={++generation}
      client={client} projectId={projectId} snapshot={snapshot} writable={writable} claims={snapshot.claims}
      evidence={snapshot.sources.map(s=>s.evidence)} libraryItems={[]} onOpenClaim={()=>{}}
      onAskAssistant={prompt=>window.promptForAssistant=prompt}/>));
  `,style:'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{height:100vh;display:flex;flex-direction:column}'});
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:800}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});page=await app.firstWindow();page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('fromMain',async(method,input)=>active.bridge.invoke(`research.${method}`,[input],windowId));
  await page.waitForFunction(()=>typeof window.mount==='function');
});
after(async()=>{try{await app?.close();}finally{for(const f of fixtures){await f.repository.wiki.shutdown();f.close();}api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
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
  await page.getByRole('button',{name:'保存人工章节',exact:true}).click();await detail.getByText('人工维护 · 自动编译保留').waitFor();
  const topic=f.repository.wiki.search(f.project.id).find(p=>p.kind==='comparison');
  assert.equal(f.repository.wiki.read(f.project.id,topic.id).current.reason,'human');
  await detail.getByRole('button',{name:'交给助手综合',exact:true}).click();assert.match(await page.evaluate(()=>window.promptForAssistant),/research_wiki_draft/);
  f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);
  f.repository.wiki.wake();await f.repository.wiki.idle();await detail.getByRole('button',{name:'刷新页面',exact:true}).click();
  await detail.getByTestId('wiki-page-lint').getByText(/原始证据已失效/).waitFor();
  assert.match(await detail.getByTestId('wiki-section-body').innerText(),/人工维护的比较/);
  await detail.getByRole('button',{name:'修订历史',exact:true}).click();
  await page.getByTestId('wiki-history').getByRole('button',{name:'r1 · 来源编译',exact:true}).click();
  await page.getByTestId('wiki-history-content').getByText('Original exact synthetic evidence.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'恢复 r1 为新修订',exact:true}).click();
  await detail.getByText(/比较 · 草稿 r\d+ · 已编译 · 历史恢复/).waitFor();assert.match(await detail.getByTestId('wiki-page-lint').innerText(),/失效/);
  assert.equal(f.repository.wiki.read(f.project.id,topic.id).current.reason,'rollback');
  const auditSource=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  for(const theme of ['light','dark'])for(const width of [800,1100]){
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
  await page.evaluate(({projectId,snapshot})=>window.mount(projectId,snapshot,false),{projectId:f.project.id,snapshot:f.repository.evidence.wikiSnapshot(f.project.id)});
  assert.equal(await page.getByRole('button',{name:'新建主题页',exact:true}).isDisabled(),true);
  await page.getByTestId('wiki-page-row').click();assert.equal(await page.getByRole('button',{name:'编辑章节',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.mount(null,{claims:[],sources:[],relations:[],papers:[]}));await page.getByText('选择研究项目以维护持久 Wiki 页面。',{exact:true}).waitFor();
});
