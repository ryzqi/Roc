import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let directory, app, page, api, active, windowId;
const fixtures=[],errors=[],reads=[];
const artifacts=join(process.cwd(),'.artifacts/research-optimization/artifact-inspector-ui');
const hash=value=>createHash('sha256').update(value).digest('hex');
before(async()=>{
  api=await loadResearchTestApi();
  directory=mkdtempSync(join(tmpdir(),'roc-artifact-inspector-ui-'));
  mkdirSync(artifacts,{recursive:true});
  await esbuild.build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ResearchGateApprovalCard} from './src/renderer/assistant/blocks/approval-cards';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{inspectArtifact:input=>window.inspectFromMain(input)}}};
    function Harness({link}) {
      const [request,setRequest]=useState(null);
      window.selectArtifact=value=>flushSync(()=>setRequest(value));
      const approval={kind:'approval',interruptId:'fixture-gate',actionRequests:[{name:'research_approve_gate',
        args:{stage:'reading',summary:'核对保存的阅读产物',artifactLinks:[link]}}],
        reviewConfigs:[{actionName:'research_approve_gate',allowedDecisions:['approve','reject']}]};
      return <main className="p-4"><ResearchGateApprovalCard approval={approval} onOpenArtifact={setRequest}
        onApprovalDecision={(id,decisions)=>window.decisions.push({id,decisions})}/>
        {request===null ? null : <ArtifactInspector key={JSON.stringify(request)} client={client} request={request}
          onClose={()=>setRequest(null)} onOpenTask={taskId=>{window.tasks.push(taskId);setRequest(null);}}/>}</main>;
    }
    let generation=0;
    window.mount=link=>{window.decisions=[];window.tasks=[];flushSync(()=>root.render(
      <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <Harness key={++generation} link={link}/></LazyMotion></MotionConfig>));};
  `,resolveDir:process.cwd(),loader:'tsx'},outfile:join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
  const assets=join(process.cwd(),'dist/renderer/assets');
  writeFileSync(join(directory,'app.css'),readdirSync(assets).filter(file=>file.endsWith('.css')).map(file=>readFileSync(join(assets,file),'utf8')).join('\n'));
  writeFileSync(join(directory,'index.html'),`<html data-theme="light"><link rel="stylesheet" href="app.css"><style>
    body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    main>section{width:min(420px,100%)}
    </style><div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('inspectFromMain',async input=>{
    const f=active;
    reads.push(input);
    api.parseIpcRequestArgs('roc:research:artifact-inspect',[input]);
    const result=await f.bridge.invoke('research.inspectArtifact',[input],windowId);
    if(f.defer) return new Promise(resolve=>{f.finish=()=>resolve(result);});
    return result;
  });
  await page.waitForFunction(()=>typeof mount==='function');
});
after(async()=>{
  try {await app?.close();} finally {fixtures.forEach(f=>f.close());api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});
async function scene({long=false}={}) {
  const f=createResearchFixture(api,'reading');fixtures.push(f);active=f;reads.length=0;
  const excerpt=long ? '原始来源长段落与定位说明。'.repeat(120) : 'An actual retained synthetic source excerpt.';
  f.db.prepare(`INSERT INTO research_evidence
    (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('inspector-evidence',f.project.id,'inspector-document','inspector-document:chunk:0',
    'file','synthetic-source','parse-v1','Original synthetic source','page:2',excerpt,hash(excerpt),'2026-11-04T00:00:00.000Z');
  const empty=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Empty real artifact',path:null});
  const completed=f.repository.runs.complete(f.run.id,f.project.id,{title:'真实保存的阅读产物',markdown:'# Saved result\n\nActual **persisted** markdown.',
    claims:[{subjectType:'claim',content:'A working hypothesis',status:'hypothesis',evidenceIds:['inspector-evidence']}],sections:[],verdict:'uncertain'});
  const artifactId=completed.outputArtifactIds[0];
  await api.createResearchHumanGate({repository:f.repository}).complete({projectId:f.project.id,expectedStage:'reading',action:'complete'});
  const snapshot=f.repository.inspectArtifact({projectId:f.project.id,artifactId,expectedVersion:null}).snapshot;
  const handlers=new Map();
  api.registerResearchArtifactInspectorCapability({pluginId:'fixture',capabilities:{register(pluginId,descriptor,handler){handlers.set(descriptor.name,handler);}}},f.repository);
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
  f.link={projectId:f.project.id,artifactId,expectedVersion:snapshot.version,title:snapshot.artifact.title,kind:snapshot.artifact.kind};
  f.empty=empty;f.snapshot=snapshot;
  await page.evaluate(link=>mount(link),f.link);
  return f;
}
async function openArtifact() {
  await page.getByTestId('assistant-gate-artifact').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-content').waitFor({state:'visible'});
  await page.waitForFunction(()=>{
    const panel=document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel&&getComputedStyle(panel).transform==='none'&&getComputedStyle(panel).opacity==='1';
  });
}
async function audit(label) {
  const code=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  const result=await page.evaluate(`(${code})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts,label+'-audit.json'),JSON.stringify(result,null,2));
  assert.equal(result.cut,0);
  // The shared full-height drawer touches these physical window edges. Only
  // its left shadow is meant to be visible; no other hidden shadow is allowed.
  assert.deepEqual(result.issues.filter(issue=>issue.level==='hidden').map(issue=>issue.side).sort(),['bottom','right','top']);
  assert.ok(result.issues.every(issue=>issue.el==='div.fixed.inset-0.flex > div.relative.z-10.ml-auto' && issue.gap===0));
  await page.screenshot({path:join(artifacts,label+'.png')});
}

test('assistant identity links inspect real saved content and source then return focus and actual task without approving',async()=>{
  const f=await scene(),before=f.db.prepare('SELECT total_changes()').pluck().get();
  assert.equal(reads.length,0);
  await openArtifact();
  assert.deepEqual(reads[0],{projectId:f.project.id,artifactId:f.link.artifactId,expectedVersion:f.link.expectedVersion});
  assert.match(await page.getByTestId('artifact-inspector-content').innerText(),/Actual persisted markdown/u);
  assert.match(await page.getByTestId('artifact-inspector-content').innerText(),/假设/u);
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/等待人工审核/u);
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  await page.getByText('An actual retained synthetic source excerpt.',{exact:true}).waitFor();
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  await audit('opened-source');
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.testid),'assistant-gate-artifact');
  await openArtifact();await page.getByTestId('artifact-inspector-task').click();
  await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>tasks),[f.snapshot.origin.taskId]);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(f.repository.getArtifact(f.link.artifactId).status,'draft');
});

test('source invalidation changes the actual snapshot and requires explicit new-version recapture',async()=>{
  const f=await scene();await openArtifact();
  f.repository.evidence.invalidateChunksOf('inspector-document');
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByText('工件或来源已变更。当前内容需要重新核对。',{exact:false}).waitFor();
  assert.equal(reads.at(-1).expectedVersion,f.link.expectedVersion);
  await page.getByTestId('artifact-inspector-recapture').click();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-inspector-recapture"]'));
  assert.notEqual(reads.at(-1).expectedVersion,f.link.expectedVersion);
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/旧定位已失效/u);
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  await page.getByText('An actual retained synthetic source excerpt.',{exact:true}).waitFor();
  assert.throws(()=>f.repository.evidence.getEvidence('inspector-evidence',f.project.id),/research_evidence_reference_superseded/u);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('real empty missing denied and damaged-source states do not become placeholder content or approval',async()=>{
  const f=await scene();
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-task').count(),0);
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:'missing',expectedVersion:null});
  await page.getByText('工件、项目或关联证据不存在。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-content').count(),0);
  const other=f.repository.createProject({title:'Other',description:'Isolation',workspacePath:'/tmp/inspector-other'});
  await page.evaluate(request=>selectArtifact(request),{projectId:other.id,artifactId:f.link.artifactId,expectedVersion:null});
  await page.getByText('工件或证据不属于当前项目。',{exact:true}).waitFor();
  f.db.prepare('UPDATE research_evidence SET excerpt=? WHERE id=?').run('Corrupted saved source','inspector-evidence');
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.link.artifactId,expectedVersion:null});
  await page.getByText('证据原文与保存的内容校验值不一致。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-content').count(),0);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('late real bridge response cannot replace another artifact selection',async()=>{
  const f=await scene();f.defer=true;
  await page.getByTestId('assistant-gate-artifact').click();
  await page.getByText('正在读取工件…',{exact:true}).waitFor();
  while(typeof f.finish!=='function') await new Promise(resolve=>setTimeout(resolve,5));
  const finish=f.finish;f.defer=false;
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();finish();
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/Empty real artifact/u);
  assert.doesNotMatch(await page.getByTestId('artifact-inspector-panel').innerText(),/Actual persisted markdown/u);
});

test('source drawer supports keyboard reading and fixed chrome at light dark 1100 1099 and 800 with reduced motion',async()=>{
  await scene({long:true});await openArtifact();
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  for(const theme of ['light','dark'])for(const width of [1100,1099,800]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByTestId('artifact-inspector-refresh').scrollIntoViewIfNeeded();
    await page.getByTestId('artifact-inspector-refresh').hover();await audit(theme+'-'+width);
    const layout=await page.evaluate(()=>{
      const panel=document.querySelector('[data-testid="artifact-inspector-panel"]');
      return {scroll:panel.scrollTop,overflow:panel.scrollWidth>panel.clientWidth,title:panel.querySelector('h2').getBoundingClientRect().top,
        small:[...panel.querySelectorAll('p,button,dd,summary')].some(element=>parseFloat(getComputedStyle(element).fontSize)<12)};
    });
    assert.equal(layout.scroll,0);assert.equal(layout.overflow,false);assert.ok(layout.title>=0);assert.equal(layout.small,false);
  }
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
});
