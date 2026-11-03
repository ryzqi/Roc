import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from '../unit/fixtures/research-production-test-kit.mjs';

let api,directory,app,page,active,windowId;
const fixtures=[],errors=[],calls=[];
const artifacts=join(process.cwd(),'.artifacts/research-optimization/artifact-production-ui');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const methodNames={inspectArtifact:['roc:research:artifact-inspect','research.inspectArtifact'],
  inspectProductionReview:['roc:research:production-review-inspect','research.inspectProductionReview'],
  readProductionReviewFile:['roc:research:production-review-read','research.readProductionReviewFile'],
  getGateReviewContext:['roc:research:gate-review','research.getGateReviewContext']};
before(async()=>{
  api=await loadResearchTestApi();
  directory=mkdtempSync(join(tmpdir(),'roc-artifact-production-ui-'));mkdirSync(artifacts,{recursive:true});
  await esbuild.build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    import {ArtifactProductionView} from './src/renderer/artifacts/ArtifactProductionView';
    const client={api:{research:Object.fromEntries(['inspectArtifact','inspectProductionReview','readProductionReviewFile','getGateReviewContext']
      .map(method=>[method,input=>window.callMain(method,input)]))}};
    const root=createRoot(document.getElementById('root'));
    function Harness({request,inspector}) {
      const [readingLocations]=useState(()=>new Map());
      const [open,setOpen]=useState(true);
      window.reopen=()=>flushSync(()=>setOpen(true));
      return <main className="p-4"><button data-testid="artifact-reopen" onClick={()=>setOpen(true)}>重新打开工件</button>
        {!open?null:inspector?<ArtifactInspector client={client} request={request} readingLocations={readingLocations}
          onClose={()=>setOpen(false)} onOpenTask={()=>{}} onReviewContext={()=>{}}/>:
          <ArtifactProductionView client={client} request={request} initialLocation={null} onLocationChange={()=>{}}/>}
      </main>;
    }
    let generation=0;
    window.mount=(request,inspector=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} request={request} inspector={inspector}/>
    </LazyMotion></MotionConfig>));
  `,resolveDir:process.cwd(),loader:'tsx'},outfile:join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
  const assets=join(process.cwd(),'dist/renderer/assets');
  writeFileSync(join(directory,'app.css'),readdirSync(assets).filter(file=>file.endsWith('.css')).map(file=>readFileSync(join(assets,file),'utf8')).join('\n'));
  writeFileSync(join(directory,'index.html'),`<html data-theme="light"><link rel="stylesheet" href="app.css"><style>
    body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{max-width:560px}
    </style><div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain',async(method,input)=>{
    const f=active;calls.push({method,input});
    api.parseIpcRequestArgs(methodNames[method][0],[input]);
    let result;
    if(f.synthetic) {
      assert.equal(input.projectId,f.input.artifact.projectId);
      assert.equal(input.artifactId,f.input.artifact.id);
      assert.equal(input.expectedVersion,f.request.expectedVersion);
      if(method==='inspectProductionReview') result=f.inspectError??{ok:true,data:f.input};
      else {
        assert.equal(method,'readProductionReviewFile');
        const file=f.input.files.find(file=>file.area===input.area&&file.path===input.path);
        assert.equal(input.expectedFileHash,file.sha256);
        result=f.readError??{ok:true,data:api.researchProductionInputContentSchema.parse({file,content:f.contents[file.path],encoding:'utf8'})};
      }
    }else result=await f.bridge.invoke(methodNames[method][1],[input],windowId);
    if(f.deferInspection&&method==='inspectProductionReview')return new Promise(resolve=>{f.finishInspection=()=>resolve(result);});
    if(f.defer&&method==='readProductionReviewFile')return new Promise(resolve=>{f.finish=()=>resolve(result);});
    return result;
  });
  await page.waitForFunction(()=>typeof mount==='function');
});
after(async()=>{
  try{await app?.close();}finally{
    for(const f of fixtures){await f.inputs.shutdown();await f.dispose();}
    api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});
  }
  assert.deepEqual(errors,[]);
});
async function realScene({long=false}={}) {
  const f=await createPublishedFigureFixture(api);fixtures.push(f);active=f;calls.length=0;
  f.inputs=new api.ResearchProductionInputService(f.repository,{
    verifyPublication:async()=>assert.fail('figure cannot verify experiment'),read:async()=>assert.fail('figure cannot read experiment')
  },f.figureService,{inspect:async()=>assert.fail('figure cannot verify export'),read:async()=>assert.fail('figure cannot read export')});
  const handlers=new Map(),context={pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}};
  api.registerResearchArtifactInspectorCapability(context,f.repository);
  api.registerResearchProductionInputCapabilities(context,f.inputs);
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
  if(long)f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown',?) WHERE artifact_id=?")
    .run('# Long saved body\n\n'+'Persisted synthetic measurement explanation.\n\n'.repeat(120),f.artifactId);
  f.request={projectId:f.project.id,artifactId:f.artifactId,
    expectedVersion:f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifactId,expectedVersion:null}).snapshot.version};
  await page.evaluate(request=>mount(request),f.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
async function openProduction() {
  await page.getByTestId('artifact-inspector-production').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-production-figure').waitFor();
}
const file=path=>page.getByTestId('artifact-production-file').and(page.locator(`[data-path="${path}"]`));
async function readPng() {
  await file('figure.png').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-production-image"]')?.naturalWidth>0);
}

test('real draft figure uses explicit production and file reads, actual PNG dimensions and source hashes without approving',async()=>{
  const f=await realScene(),before=f.db.prepare('SELECT total_changes()').pluck().get();
  assert.deepEqual(calls.map(call=>call.method),['inspectArtifact']);
  await openProduction();
  assert.match(await page.getByTestId('artifact-production-figure').innerText(),/3 × 2 in\s*72 DPI/u);
  assert.match(await page.getByTestId('artifact-production-figure').innerText(),/216 × 144 px/u);
  assert.match(await page.getByTestId('artifact-production').innerText(),/仍等待人工决定/u);
  assert.equal(await page.getByTestId('artifact-production-content').count(),0);
  await readPng();
  const image=await page.getByTestId('artifact-production-image').evaluate(element=>({width:element.naturalWidth,height:element.naturalHeight,src:element.src}));
  assert.equal(image.width,216);assert.equal(image.height,144);
  const png=f.productionRun.files.find(file=>file.area==='output'&&file.path==='figure.png');
  assert.equal(hash(Buffer.from(image.src.split(',')[1],'base64')),png.sha256);
  assert.deepEqual(calls.at(-1).input,{...f.request,area:'output',path:'figure.png',expectedFileHash:png.sha256});
  assert.equal(await file('figure.pdf').isDisabled(),true);
  assert.match(await page.getByTestId('artifact-production').innerText(),/PDF 定位预览入口尚未接入/u);
  await page.getByTestId('artifact-production-area-input').click();
  assert.equal(await page.getByTestId('artifact-production-image').count(),0);
  await file('measurements.csv').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-production-text').waitFor();
  assert.match(await page.getByTestId('artifact-production-text').innerText(),/group,value/u);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
});

test('a source change refuses the old file version; refreshing the actual artifact clears old content and binds new reads',async()=>{
  const f=await realScene();await openProduction();await readPng();
  f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Revised body for same saved figure') WHERE artifact_id=?").run(f.artifactId);
  await file('figure.svg').click();
  await page.getByText('生产工件版本已变化，请刷新工件重新核对。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-production-image').count(),0);
  assert.equal(await page.getByTestId('artifact-production-content').count(),0);
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByText('Revised body for same saved figure',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-production').count(),0);
  await page.getByTestId('artifact-inspector-production').click();
  await page.getByTestId('artifact-production-figure').waitFor();
  assert.equal(await page.getByTestId('artifact-production-content').count(),0);
  await readPng();
  assert.notEqual(calls.at(-1).input.expectedVersion,f.request.expectedVersion);
  assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
});

test('late actual file responses cannot replace another file or project; SVG stays escaped text',async()=>{
  const f=await realScene();await openProduction();f.defer=true;
  await file('figure.png').click();
  while(typeof f.finish!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const finish=f.finish;f.defer=false;
  await file('figure.svg').click();await page.getByTestId('artifact-production-text').waitFor();finish();
  assert.match(await page.getByTestId('artifact-production-text').innerText(),/<svg/u);
  assert.equal(await page.getByTestId('artifact-production-image').count(),0);
  f.defer=true;delete f.finish;await file('figure.png').click();
  while(typeof f.finish!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const last=f.finish;await realScene();last();
  assert.equal(await page.getByTestId('artifact-production').count(),0);
  assert.equal(await page.getByTestId('artifact-production-image').count(),0);
});

// Typed synthetic source responses isolate experiment/export presentation and request scoping.
// Actual execution, source validation and bytes for all three kinds are covered by native P0.
function syntheticSource(kind,{long=false}={}) {
  const now='2026-11-04T00:00:00.000Z',projectId=`synthetic-${kind}-project`,artifactId=`synthetic-${kind}-artifact`;
  const content=kind==='experiment'?(long?'group,value\n'+'synthetic,2\n'.repeat(2000):'group,value\nsynthetic,2\n'):
    '\\documentclass{article}\n\\begin{document}Synthetic exported source.\\end{document}';
  const path=kind==='experiment'?'results.csv':'paper.tex';
  const area=kind==='experiment'?'output':'bundle',selected={area,path,sha256:hash(content),size:Buffer.byteLength(content)};
  const artifact={id:artifactId,projectId,stage:kind,kind:kind==='experiment'?'experiment_run':'export_package',
    title:`Synthetic ${kind}`,path:'/tmp/synthetic/manifest.json',status:'draft',createdAt:now,updatedAt:now};
  let source,files=[selected];
  if(kind==='experiment') source={kind,execution:{id:'synthetic-experiment',projectId,
    request:{projectId,requestId:'synthetic-request',engine:'typescript',runtime:{kind:'bundled-node'},sourceVersion:1,
      label:'Synthetic experiment',sourcePath:'experiment.mts',inputPaths:[],parameters:{seed:'42'},timeoutMs:1000,network:'disabled'},
    ownerRunId:null,workspacePath:'/tmp/synthetic',workspaceRoot:'/tmp/synthetic',status:'completed',environment:null,
    files:[selected],inputHash:hash('synthetic input'),exitCode:0,error:null,artifactId,createdAt:now,startedAt:now,endedAt:now}};
  else {
    const manuscriptId='synthetic-manuscript';
    const sources={project:{id:projectId,title:'Synthetic export',description:'Renderer-only fixture',workspacePath:null},
      manuscriptArtifact:{...artifact,id:manuscriptId,kind:'manuscript',stage:'writing',status:'approved'},
      manuscript:{artifactId:manuscriptId,projectId,sections:[],latex:content,contentHash:hash(content),claimsHash:hash('[]'),updatedAt:now},
      claims:[],evidence:[],figures:[],bibliography:[],libraryRevisions:[],citationKeys:{},provenance:[],modelRuns:[],experiments:[],
      evidenceMetadata:{},review:{projectId,originArtifactId:manuscriptId,manuscriptArtifactId:manuscriptId,revisionRound:0,
        status:'accepted',reportArtifactIds:['synthetic-report'],updatedAt:now},template:null};
    const pdf={path:'paper.pdf',sha256:hash('synthetic-pdf'),size:13},archive={path:'export.zip',sha256:hash('synthetic-zip'),size:13};
    files=[selected,{...pdf,area:'bundle'},{...archive,area:'bundle'}];
    source={kind,execution:{id:'synthetic-export',projectId,request:{projectId,requestId:'synthetic-request',title:'Synthetic export',
      manuscriptArtifactId:manuscriptId,figureIds:[],template:{kind:'default',language:'zh'}},ownerRunId:null,status:'ready',
      sources,sourceHash:hash(JSON.stringify(sources)),toolchainHash:hash('synthetic-toolchain'),files:files.map(({area,...file})=>file),
      archive,artifactId,approval:'draft',replacesExportId:null,error:null,createdAt:now,endedAt:now}};
  }
  const input=api.researchProductionInputSchema.parse({artifact,source,files});
  return {synthetic:true,input,contents:{[path]:content},request:{projectId,artifactId,expectedVersion:hash(JSON.stringify(input))}};
}
async function syntheticScene(kind,options) {
  active=syntheticSource(kind,options);calls.length=0;
  await page.evaluate(request=>mount(request,false),active.request);
  await page.getByTestId(`artifact-production-${kind}`).waitFor();
  return active;
}

test('typed experiment source displays exact runtime absence, parameters and long CSV with native keyboard scrolling',async()=>{
  const f=await syntheticScene('experiment',{long:true});
  assert.match(await page.getByTestId('artifact-production-experiment').innerText(),/未记录/u);
  await file('results.csv').focus();await page.keyboard.press('Enter');await page.getByTestId('artifact-production-text').waitFor();
  const text=page.getByTestId('artifact-production-text');await text.focus();await page.keyboard.press('End');
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-production-text"]').scrollTop>0);
  assert.deepEqual(calls.at(-1).input,{...f.request,area:'output',path:'results.csv',expectedFileHash:f.input.files[0].sha256});
  assert.equal(await text.evaluate(element=>element.scrollWidth>element.clientWidth),false);
});

test('typed export source displays captured package identity, reads exact source and keeps unsupported PDF/ZIP actions disabled',async()=>{
  const f=await syntheticScene('export');
  assert.match(await page.getByTestId('artifact-production-export').innerText(),/1 份审稿报告/u);
  assert.match(await page.getByTestId('artifact-production-export').innerText(),new RegExp(f.input.source.execution.archive.sha256));
  assert.equal(await file('paper.pdf').isDisabled(),true);assert.equal(await file('export.zip').isDisabled(),true);
  await file('paper.tex').focus();await page.keyboard.press('Enter');await page.getByTestId('artifact-production-text').waitFor();
  assert.match(await page.getByTestId('artifact-production-text').innerText(),/Synthetic exported source/u);
  assert.deepEqual(calls.at(-1).input,{...f.request,area:'bundle',path:'paper.tex',expectedFileHash:f.input.files[0].sha256});
});

test('production errors keep failed content empty and require explicit retry; over-limit files cannot trigger reads',async()=>{
  const f=syntheticSource('experiment');active=f;calls.length=0;
  f.input.files.push({area:'output',path:'large.csv',sha256:hash('large'),size:4*1024*1024+1});
  f.inspectError={ok:false,error:{message:'保存的生产清单不存在。'}};
  await page.evaluate(request=>mount(request,false),f.request);
  await page.getByText('保存的生产清单不存在。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-production-experiment').count(),0);
  assert.equal(calls.length,1);delete f.inspectError;
  await page.getByRole('button',{name:'重试文件核对',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-production-experiment').waitFor();
  assert.equal(await file('large.csv').isDisabled(),true);
  assert.match(await page.getByTestId('artifact-production').innerText(),/超过 4 MiB 预览上限/u);
  assert.equal(calls.some(call=>call.method==='readProductionReviewFile'),false);
  f.readError={ok:false,error:{message:'选定文件已变化。'}};
  await file('results.csv').click();await page.getByText('选定文件已变化。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-production-content').count(),0);
  delete f.readError;await page.getByTestId('artifact-production-retry').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-production-text').waitFor();
  assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(calls.filter(call=>call.method==='readProductionReviewFile').length,2);
  assert.deepEqual(calls.at(-1).input,calls.at(-2).input);
});

test('same-version actual production reading rechecks selected bytes and restores file area focus and scroll after Escape',async()=>{
  const f=await realScene({long:true});await openProduction();
  await page.getByTestId('artifact-production-area-input').click();
  await file('measurements.csv').click();await page.getByTestId('artifact-production-text').waitFor();
  await page.getByTestId('artifact-production-text').focus();
  const before=await page.getByTestId('artifact-inspector-panel').evaluate(panel=>{
    const body=panel.querySelector('[data-reading-key="refresh"]').parentElement.parentElement.parentElement;
    return {top:body.scrollTop,focus:document.activeElement.dataset.readingKey,text:document.querySelector('[data-testid="artifact-production-text"]').textContent,
      width:body.clientWidth,scrollWidth:body.scrollWidth,overflow:[...body.querySelectorAll('*')].filter(element=>element.scrollWidth>element.clientWidth+2)
        .map(element=>({tag:element.tagName,class:element.className,width:element.clientWidth,scrollWidth:element.scrollWidth}))};
  });
  writeFileSync(join(artifacts,'reading-layout.json'),JSON.stringify(before,null,2));
  assert.equal(before.scrollWidth,before.width);
  assert.ok(before.top>900);
  const readCount=calls.filter(call=>call.method==='readProductionReviewFile').length;
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector').waitFor({state:'detached'});
  await page.getByTestId('artifact-reopen').click();await page.getByTestId('artifact-production-text').waitFor();
  await page.waitForFunction(top=>{
    const body=document.querySelector('[data-reading-key="refresh"]').parentElement.parentElement.parentElement;
    return Math.abs(body.scrollTop-top)<2&&document.activeElement.dataset.readingKey==='production-text';
  },before.top);
  assert.equal(calls.filter(call=>call.method==='readProductionReviewFile').length,readCount+1);
  assert.deepEqual(calls.at(-1).input,{...f.request,area:'input',path:'measurements.csv',expectedFileHash:f.productionRun.files.find(file=>file.path==='measurements.csv').sha256});
  assert.equal(await page.getByTestId('artifact-production-area-input').getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByTestId('artifact-production-text').textContent(),before.text);
  await page.getByTestId('artifact-inspector-panel').screenshot({path:join(artifacts,'restored-reading.png'),scale:'css'});
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector').waitFor({state:'detached'});
  f.defer=true;delete f.finish;
  await page.getByTestId('artifact-reopen').click();
  while(typeof f.finish!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  await page.getByTestId('artifact-inspector-content').click({position:{x:10,y:10}});
  const manual=await page.getByTestId('artifact-inspector-content').evaluate(element=>element.parentElement.parentElement.scrollTop);
  f.finish();f.defer=false;await page.getByTestId('artifact-production-text').waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-content').evaluate(element=>element.parentElement.parentElement.scrollTop),manual);
  assert.equal(calls.filter(call=>call.method==='readProductionReviewFile').length,readCount+2);
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector').waitFor({state:'detached'});
  f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','New body invalidates saved location') WHERE artifact_id=?").run(f.artifactId);
  await page.getByTestId('artifact-reopen').click();await page.getByTestId('artifact-inspector-content').waitFor();
  assert.equal(await page.getByTestId('artifact-production').count(),0);
  assert.equal(calls.filter(call=>call.method==='readProductionReviewFile').length,readCount+2);
  f.deferInspection=true;
  await page.getByTestId('artifact-inspector-production').click();
  while(typeof f.finishInspection!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector').waitFor({state:'detached'});
  f.deferInspection=false;f.finishInspection();
  await page.getByTestId('artifact-reopen').click();await page.getByTestId('artifact-production-figure').waitFor();
  assert.equal(await page.getByTestId('artifact-production-content').count(),0);
  assert.equal(calls.filter(call=>call.method==='readProductionReviewFile').length,readCount+2);
});

test('actual production drawer remains readable in light dark 1100 1099 and 800, with fixed chrome and reduced motion',async()=>{
  await realScene();await openProduction();await readPng();await page.emulateMedia({reducedMotion:'reduce'});
  const audits=[];
  for(const theme of ['light','dark'])for(const width of [1100,1099,800]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByTestId('artifact-production-content').scrollIntoViewIfNeeded();
    const layout=await page.getByTestId('artifact-inspector-panel').evaluate(panel=>({scroll:panel.scrollTop,
      overflow:panel.scrollWidth>panel.clientWidth,title:panel.querySelector('h2').getBoundingClientRect().top}));
    assert.equal(layout.scroll,0);assert.equal(layout.overflow,false);assert.ok(layout.title>=0&&layout.title<100);
    const script=readFileSync(join(process.cwd(),'.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
    const audit=await page.evaluate(`(${script})({root:'[data-testid="artifact-inspector"]',viewport:true})`);
    assert.equal(audit.cut,0);
    assert.deepEqual(audit.issues.filter(issue=>issue.level==='hidden').map(issue=>issue.side).sort(),['bottom','right','top']);
    audits.push({theme,width,audit});await page.screenshot({path:join(artifacts,`${theme}-${width}.png`)});
  }
  writeFileSync(join(artifacts,'shadow-audit.json'),JSON.stringify(audits,null,2));
});
