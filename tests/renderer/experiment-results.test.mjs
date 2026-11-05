import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,writeFile,readFile,symlink,rm,chmod} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi,createResearchFixture} from '../unit/fixtures/research-test-kit.mjs';

let api,root,app,page,f,service,inputs,results,first,repeat,scaled,windowId,bridge,active;
const calls=[],errors=[],audits=[],artifacts=resolve('.artifacts/research-optimization/xexp-a2-ui');
const routes={
  inspectProductionReview:['roc:research:production-review-inspect','research.inspectProductionReview'],
  readProductionReviewFile:['roc:research:production-review-read','research.readProductionReviewFile'],
  reviewExperimentResult:['roc:research:experiment-result-review','research.reviewExperimentResult'],
  getExperimentResult:['roc:research:experiment-result-get','research.getExperimentResult'],
  listExperimentResults:['roc:research:experiment-result-list','research.listExperimentResults'],
  compareExperimentResults:['roc:research:experiment-result-compare','research.compareExperimentResults'],
  captureExperimentResultEvidence:['roc:research:experiment-result-evidence-capture','research.captureExperimentResultEvidence'],
  getExperimentResultEvidence:['roc:research:experiment-result-evidence-get','research.getExperimentResultEvidence'],
  readExperimentFile:['roc:research:experiment-read','research.readExperimentFile']
};
const source=`import json, os, statistics
import roc_experiment as roc
with open(os.path.join(roc.input_dir, "data.txt")) as data:
    values = [float(value) * float(roc.parameters["scale"]) for value in data.read().split()]
metric = {"id": "mean", "value": statistics.mean(values), "unit": "ms", "sampleSize": len(values),
    "uncertainty": {"kind": "recorded", "type": "standard_deviation", "value": statistics.stdev(values)},
    "confidenceInterval": {"kind": "unavailable", "reason": "未估计区间"},
    "effect": {"kind": "unavailable", "reason": "未设置对照组"}}
with open(os.path.join(roc.output_dir, "metrics.json"), "w") as output:
    json.dump({"schemaVersion": 1, "metrics": [metric]}, output)
with open(os.path.join(roc.output_dir, "wrong.json"), "w") as output:
    json.dump({"incomplete": True}, output)
`;
const method={name:'算术均值和样本标准差',rationale:'保留全部观测',assumptions:'独立合成样本',limitations:'未进行推断统计'};
const definition={id:'mean',label:'合成延迟均值',definition:'全部 data.txt 观测值乘以 scale 后的算术均值',unit:'ms',direction:'lower'};
before(async()=>{
  api=await loadResearchTestApi();
  root=await realpath(await mkdtemp('/private/tmp/roc-result-ui-'));
  const workspace=join(root,'workspace'),venv=join(root,'venv'),directory=join(root,'ui');
  for(const path of [workspace,join(venv,'bin'),join(venv,'lib/python3.14/site-packages'),directory,artifacts])await mkdir(path,{recursive:true});
  const python=JSON.parse(execFileSync('python3',['-I','-S','-c',
    'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'],{encoding:'utf8'}));
  assert.match(python.version,/^3\.14\.\d+$/u);
  const executable=join(venv,'bin/python3');
  await symlink(python.executable,executable);
  await writeFile(join(venv,'pyvenv.cfg'),`home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  await writeFile(join(workspace,'roc-python.lock.json'),JSON.stringify({
    schemaVersion:1,python:{implementation:'cpython',version:python.version,platform:'darwin',architecture:'arm64'},distributions:[]
  }));
  await writeFile(join(workspace,'analysis.py'),source);await writeFile(join(workspace,'data.txt'),'-3 -2 -1\n');
  f=createResearchFixture(api,'experiment',workspace);
  const pythonService=new api.ResearchPythonEnvironmentService(f.repository,async()=>executable);
  const selection=await api.withResearchHumanContext({capability:'research.pythonEnvironments.select',projectId:f.project.id,windowId:72},
    ()=>pythonService.select({projectId:f.project.id,requestId:'environment'}));
  service=new api.ResearchExperimentService(f.repository,new api.ResearchExperimentEnvironmentService({
    nativeRuntime:async()=>assert.fail('no native tools'),typescriptRuntime:async()=>assert.fail('no TypeScript')
  },pythonService),root,{error:(...args)=>errors.push(JSON.stringify(args))});
  const runtime={kind:'python',selectionId:selection.snapshot.id,expectedHash:selection.snapshotHash};
  const environment=await service.inspect(f.project.id,runtime);
  async function execute(id,scale) {
    const started=await service.start({projectId:f.project.id,ownerRunId:f.run.id,requestId:id,label:id,
      engine:'python',sourceVersion:1,source:{kind:'file',path:'analysis.py'},inputPaths:['data.txt'],parameters:{scale},
      seed:73,arguments:[],runtime,expectedEnvironmentHash:environment.hash,timeoutMs:5000,network:'disabled'});
    const deadline=Date.now()+20000;
    let run;
    do {
      run=f.repository.experiments.get(f.project.id,started.id);
      if(!['preparing','running'].includes(run.status))break;
      await new Promise(done=>setTimeout(done,20));
    }while(Date.now()<deadline);
    assert.equal(run.status,'completed',run.error);
    return service.publish(f.project.id,run.id);
  }
  first=await execute('first','1');repeat=await execute('repeat','1');scaled=await execute('scaled','2');
  f.repository.runs.complete(f.run.id,f.project.id,{title:'真实合成指标',markdown:'三个受控运行保留原始指标输出',claims:[],sections:[],verdict:'uncertain'});
  f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:'experiment',action:'complete'});
  inputs=new api.ResearchProductionInputService(f.repository,service,{verify:async()=>assert.fail('no figure'),read:async()=>assert.fail('no figure')},
    {inspect:async()=>assert.fail('no export'),read:async()=>assert.fail('no export')});
  results=new api.ResearchExperimentResultService(f.repository,service);
  const handlers=new Map(),context={pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}};
  api.registerResearchProductionInputCapabilities(context,inputs);
  api.registerResearchExperimentResultCapabilities(context,f.repository.experimentResults,results);
  api.registerResearchExperimentCapabilities(context,f.repository.experiments,service);
  bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
  await buildViteRenderer({directory,script:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {ArtifactProductionView} from './src/renderer/artifacts/ArtifactProductionView';
    import {ArtifactEvidenceSource} from './src/renderer/artifacts/ArtifactEvidenceSource';
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    const element=createRoot(document.getElementById('root'));let generation=0;
    window.mount=(request,writable=true)=>flushSync(()=>element.render(<main className="p-4">
      <ArtifactProductionView key={++generation} client={client} request={request} writable={writable} initialLocation={null} onLocationChange={()=>{}}/>
    </main>));
    window.clear=()=>flushSync(()=>element.render(null));
    window.mountEvidence=source=>flushSync(()=>element.render(<main className="p-4">
      <ArtifactEvidenceSource key={++generation} client={client} source={source} canDecide={false} onChanged={()=>{}}/>
    </main>));
  `,style:'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{max-width:560px}'});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(root,'userData'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:760,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain',async(method,input)=>{
    calls.push({method,input});api.parseIpcRequestArgs(routes[method][0],[input]);
    const current=active,result=await bridge.invoke(routes[method][1],[input],windowId);
    if(current.loseReply===method) {
      delete current.loseReply;
      assert.equal(result.ok,true);
      return {ok:false,error:{code:'fixture_reply_lost',category:'degraded',message:'测试连接中断，审核已写入但回执未送达。',retryable:true}};
    }
    if(current.defer===method)return new Promise(done=>{current.finish=()=>done(result);});
    return result;
  });
  await page.waitForFunction(()=>typeof mount==='function');
});
after(async()=>{
  try {await app?.close();await inputs?.shutdown();await service?.shutdown();f?.close();api?.dispose();}
  finally {if(root)await rm(root,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});
async function scene(run=first,writable=true) {
  active={};calls.length=0;
  const request={projectId:f.project.id,artifactId:run.artifactId,
    expectedVersion:f.repository.inspectArtifact({projectId:f.project.id,artifactId:run.artifactId,expectedVersion:null}).snapshot.version};
  await page.evaluate(({request,writable})=>mount(request,writable),{request,writable});
  await page.getByTestId('artifact-experiment-results').waitFor();
}
async function review(run,id) {
  const output=run.files.find(file=>file.area==='output'&&file.path==='metrics.json');
  return api.withResearchHumanContext({capability:'research.experimentResults.review',projectId:f.project.id,windowId},
    ()=>results.review({projectId:f.project.id,requestId:id,runId:run.id,expectedInputHash:run.inputHash,
      resultPath:output.path,expectedResultHash:output.sha256,definitions:[definition],method}));
}
async function openResult(receipt) {
  await page.getByTestId('artifact-experiment-result-list').click();
  const button=page.getByTestId('artifact-experiment-result-select').filter({hasText:receipt.snapshot.id});
  await button.waitFor();await button.focus();await page.keyboard.press('Enter');
  await page.getByText('已复核实际运行、输出与审核回执。',{exact:true}).waitFor();
}
async function compareRun(run,receipt) {
  await page.getByLabel('对照运行 ID',{exact:true}).fill(run.id);
  await page.getByTestId('artifact-experiment-comparison-list').focus();await page.keyboard.press('Enter');
  await page.getByLabel('对照结果回执').selectOption(receipt.snapshot.id);
  await page.getByTestId('artifact-experiment-compare').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-experiment-comparison-result').waitFor();
}
async function fillReview() {
  await page.getByLabel('mean指标名称',{exact:true}).fill(definition.label);
  await page.getByLabel('mean指标定义',{exact:true}).fill(definition.definition);
  await page.getByLabel('mean指标方向',{exact:true}).selectOption('lower');
  for(const [label,value] of [['统计方法',method.name],['方法选择理由',method.rationale],['方法假设',method.assumptions],['分析限制',method.limitations]])
    await page.getByLabel(label,{exact:true}).fill(value);
}
test('keyboard review freezes actual negative metrics and main-window method receipt without implicit reads or inferred statistics',async()=>{
  await scene();
  assert.deepEqual(calls.map(value=>value.method),['inspectProductionReview']);
  await page.getByTestId('artifact-experiment-result-review-open').focus();await page.keyboard.press('Enter');
  assert.deepEqual(calls.map(value=>value.method),['inspectProductionReview']);
  await page.getByLabel('指标输出文件').selectOption('metrics.json');
  await page.getByTestId('artifact-experiment-result-form').waitFor();
  assert.equal(await page.getByTestId('artifact-experiment-result-save').isDisabled(),true);
  assert.match(await page.getByTestId('artifact-experiment-result-form').innerText(),/-2 ms/u);
  await fillReview();
  await page.getByTestId('artifact-experiment-result-save').focus();await page.keyboard.press('Enter');
  await page.getByText('已复核实际运行、输出与审核回执。',{exact:true}).waitFor();
  const receipt=f.repository.experimentResults.list({projectId:f.project.id,runId:first.id,offset:0,limit:20}).items[0];
  assert.equal(receipt.snapshot.actor.id,`window:${windowId}`);
  assert.deepEqual(receipt.snapshot.request.method,method);assert.deepEqual(receipt.snapshot.request.definitions,[definition]);
  assert.equal(receipt.snapshot.result.metrics[0].value,-2);assert.equal(receipt.snapshot.result.metrics[0].sampleSize,3);
  const text=await page.getByTestId('artifact-experiment-result-receipt').innerText();
  assert.match(text,/标准差 1 ms/u);assert.match(text,/未估计：未估计区间/u);assert.match(text,/未设置对照组/u);
  assert.match(text,new RegExp(first.id,'u'));assert.match(text,new RegExp(receipt.snapshot.execution.source.sha256,'u'));
  assert.equal(calls.filter(value=>value.method==='reviewExperimentResult').length,1);
  assert.equal(f.repository.getArtifact(first.artifactId).status,'draft');
});
test('actual repeat is comparable, changed parameters are explicit and both signed negative estimates remain visible',async()=>{
  const a=await review(first,'comparison-left'),b=await review(repeat,'comparison-repeat'),c=await review(scaled,'comparison-scaled');
  await scene();await openResult(a);await compareRun(repeat,b);
  assert.match(await page.getByTestId('artifact-experiment-comparison-result').innerText(),/冻结合同可比/u);
  await compareRun(scaled,c);
  const text=await page.getByTestId('artifact-experiment-comparison-result').innerText();
  assert.match(text,/冻结合同不可比/u);assert.match(text,/参数或命令参数不同/u);
  assert.match(text,/-2 ms/u);assert.match(text,/-4 ms/u);
  const request=calls.filter(value=>value.method==='compareExperimentResults').at(-1).input;
  assert.deepEqual(request,{projectId:f.project.id,left:{resultId:a.snapshot.id,expectedHash:a.snapshotHash},right:{resultId:c.snapshot.id,expectedHash:c.snapshotHash}});
  const auditSource=await readFile(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,820));
    await page.getByTestId('artifact-experiment-compare').hover();
    const audit=await page.evaluate(`(${auditSource})({root:'main',viewport:false})`);audits.push({theme,audit});
    assert.equal(audit.cut,0);assert.equal(audit.hidden,0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(artifacts,`${theme}-comparison.png`),fullPage:true});
  }
  await writeFile(join(artifacts,'receipt.json'),JSON.stringify({actualPython:true,actualRenderer:true,mainAdapter:true,preloadFixture:false,request,a,b,c,audits},null,2));
});
test('invalid actual output cannot open a success form; read-only scope cannot write an audit',async()=>{
  await scene();await page.getByTestId('artifact-experiment-result-review-open').click();
  await page.getByLabel('指标输出文件').selectOption('wrong.json');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('artifact-experiment-result-form').count(),0);
  assert.equal(calls.some(value=>value.method==='reviewExperimentResult'),false);
  await scene(first,false);assert.equal(await page.getByTestId('artifact-experiment-result-review-open').isDisabled(),true);
  assert.equal(calls.some(value=>value.method==='reviewExperimentResult'),false);
});
test('a changed source refuses exact saved result and compare without showing historical data as current proof',async()=>{
  const a=await review(first,'drift-left'),c=await review(scaled,'drift-right');
  await scene();await openResult(a);
  const path=join(f.repository.experiments.root(f.project.id,scaled.id),'input/analysis.py'),original=await readFile(path);
  await chmod(path,0o600);await writeFile(path,Buffer.concat([original,Buffer.from('\n# host change\n')]));
  try {
    await page.getByLabel('对照运行 ID',{exact:true}).fill(scaled.id);
    await page.getByTestId('artifact-experiment-comparison-list').click();
    await page.getByLabel('对照结果回执').selectOption(c.snapshot.id);
    await page.getByTestId('artifact-experiment-compare').click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByTestId('artifact-experiment-comparison-result').count(),0);
    assert.match(await page.getByRole('alert').innerText(),/实验文件与保存的内容校验值不一致。/u);
    const failure=await bridge.invoke('research.compareExperimentResults',[{
      projectId:f.project.id,left:{resultId:a.snapshot.id,expectedHash:a.snapshotHash},
      right:{resultId:c.snapshot.id,expectedHash:c.snapshotHash}
    }],windowId);
    assert.equal(failure.ok,false);
    assert.equal(failure.error.code,'research_experiment_snapshot_changed');
  }finally{await writeFile(path,original);await chmod(path,0o400);}
});
test('late history and verification responses cannot enter a newly selected run',async()=>{
  const a=await review(first,'late-left');
  for(const method of ['listExperimentResults','getExperimentResult']) {
    await scene();
    if(method==='getExperimentResult') {
      await page.getByTestId('artifact-experiment-result-list').click();
      await page.getByTestId('artifact-experiment-result-select').filter({hasText:a.snapshot.id}).waitFor();
    }
    active.defer=method;const held=active;
    if(method==='listExperimentResults')await page.getByTestId('artifact-experiment-result-list').click();
    else await page.getByTestId('artifact-experiment-result-select').filter({hasText:a.snapshot.id}).click();
    while(typeof held.finish!=='function')await new Promise(done=>setTimeout(done,10));
    await scene(repeat);held.finish();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-experiment-result-receipt"]'));
    assert.equal(await page.getByTestId('artifact-experiment-result-select').count(),0);
    assert.equal(await page.getByTestId('artifact-experiment-comparison').count(),0);
  }
});
test('reply-loss retry keeps the exact manual request and stores one receipt; pending writes disable the form',async()=>{
  await scene();await page.getByTestId('artifact-experiment-result-review-open').click();
  await page.getByLabel('指标输出文件').selectOption('metrics.json');
  await page.getByTestId('artifact-experiment-result-form').waitFor();await fillReview();
  const count=f.repository.experimentResults.list({projectId:f.project.id,runId:first.id,offset:0,limit:20}).total;
  active.loseReply='reviewExperimentResult';
  await page.getByTestId('artifact-experiment-result-save').click();
  await page.getByRole('alert').filter({hasText:'测试连接中断'}).waitFor();
  assert.equal(f.repository.experimentResults.list({projectId:f.project.id,runId:first.id,offset:0,limit:20}).total,count+1);
  active.defer='reviewExperimentResult';const held=active;
  await page.getByTestId('artifact-experiment-result-save').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-experiment-result-form"] fieldset').disabled);
  while(typeof held.finish!=='function')await new Promise(done=>setTimeout(done,10));
  assert.deepEqual(calls.filter(value=>value.method==='reviewExperimentResult').map(value=>value.input)[0],
    calls.filter(value=>value.method==='reviewExperimentResult').map(value=>value.input)[1]);
  held.finish();await page.getByText('已复核实际运行、输出与审核回执。',{exact:true}).waitFor();
  assert.equal(f.repository.experimentResults.list({projectId:f.project.id,runId:first.id,offset:0,limit:20}).total,count+1);
});
test('paged history loads exact later receipts and a late comparison cannot restore cleared selection',async()=>{
  const earliest=await review(repeat,'pagination-earliest');
  for(let index=0;index<20;index++)await review(repeat,`pagination-${index}`);
  await scene(repeat);await page.getByTestId('artifact-experiment-result-list').click();
  await page.getByTestId('artifact-experiment-result-select').first().waitFor();
  assert.equal(await page.getByTestId('artifact-experiment-result-select').count(),20);
  assert.equal(await page.getByTestId('artifact-experiment-result-select').filter({hasText:earliest.snapshot.id}).count(),0);
  await page.getByRole('button',{name:'下一页指标回执',exact:true}).click();
  await page.getByTestId('artifact-experiment-result-select').filter({hasText:earliest.snapshot.id}).click();
  await page.getByText('已复核实际运行、输出与审核回执。',{exact:true}).waitFor();
  const other=await review(scaled,'pagination-right');
  await page.getByLabel('对照运行 ID',{exact:true}).fill(scaled.id);
  await page.getByTestId('artifact-experiment-comparison-list').click();
  await page.getByLabel('对照结果回执').selectOption(other.snapshot.id);
  active.defer='compareExperimentResults';const held=active;
  await page.getByTestId('artifact-experiment-compare').click();
  while(typeof held.finish!=='function')await new Promise(done=>setTimeout(done,10));
  await page.getByLabel('对照运行 ID',{exact:true}).fill(first.id);
  held.finish();
  assert.equal(await page.getByTestId('artifact-experiment-comparison-result').count(),0);
  assert.equal(await page.getByTestId('artifact-experiment-compare').isDisabled(),true);
});

test('keyboard metric capture survives reply loss and opens the exact result and actual output from an existing evidence consumer',async()=>{
  const receipt=await review(first,'trace-ui');
  await scene();await openResult(receipt);
  assert.equal(calls.filter(value=>value.method==='captureExperimentResultEvidence').length,0);
  const capture=page.getByTestId('artifact-experiment-metric-evidence-save');
  assert.equal(await capture.isDisabled(),true);
  await page.getByLabel('证据指标',{exact:true}).selectOption('mean');
  const before=f.repository.evidence.list(f.project.id).length;
  active.loseReply='captureExperimentResultEvidence';
  await capture.focus();await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({hasText:'测试连接中断'}).waitFor();
  assert.equal(f.repository.evidence.list(f.project.id).length,before+1);
  active.defer='captureExperimentResultEvidence';const held=active;
  await capture.click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-experiment-metric-evidence"] fieldset').disabled);
  while(typeof held.finish!=='function')await new Promise(done=>setTimeout(done,10));
  held.finish();
  await page.getByText('指标证据已保存。',{exact:true}).waitFor();
  const evidence=f.repository.evidence.list(f.project.id)[0],source=f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
  assert.equal(f.repository.evidence.list(f.project.id).length,before+1);
  assert.equal(JSON.parse(evidence.excerpt).source.resultId,receipt.snapshot.id);
  assert.match(await page.getByTestId('artifact-experiment-metric-evidence-saved').innerText(),new RegExp(evidence.id));
  const requests=calls.filter(value=>value.method==='captureExperimentResultEvidence').map(value=>value.input);
  assert.deepEqual(requests[0],requests[1]);
  active={};calls.length=0;
  await page.evaluate(source=>mountEvidence(source),source);
  assert.equal(calls.length,0);
  await page.locator('details > summary').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('details'),'::details-content').contentVisibility==='visible');
  await page.getByTestId(`artifact-experiment-evidence-toggle-${evidence.id}`).waitFor({state:'visible'});
  await page.getByTestId(`artifact-experiment-evidence-toggle-${evidence.id}`).focus();
  assert.equal(await page.getByTestId(`artifact-experiment-evidence-toggle-${evidence.id}`).evaluate(element=>element===document.activeElement),true);
  await page.keyboard.press('Enter');
  try {
    await page.getByText('已复核指标 mean 的固定结果来源。',{exact:true}).waitFor();
  } catch(error) {
    const output=resolve('.artifacts/research-optimization/xexp-a3-ui');
    await mkdir(output,{recursive:true});
    await writeFile(join(output,'failure.json'),JSON.stringify({calls,errors,dom:await page.evaluate(()=>({
      html:document.querySelector('main').innerHTML,text:document.querySelector('main').innerText,
      focused:document.activeElement.outerHTML,details:[...document.querySelectorAll('details')].map(element=>({
        open:element.open,style:getComputedStyle(element,'::details-content').contentVisibility
      }))
    }))},null,2));
    await page.screenshot({path:join(output,'failure.png'),fullPage:true});
    throw error;
  }
  assert.match(await page.getByTestId('artifact-experiment-result-receipt').innerText(),new RegExp(receipt.snapshotHash));
  await page.getByTestId('artifact-experiment-evidence-output-toggle').focus();await page.keyboard.press('Enter');
  const actual=page.getByTestId('artifact-experiment-evidence-output');
  await actual.waitFor();
  assert.equal(JSON.parse(await actual.innerText()).metrics[0].value,-2);
  assert.deepEqual(calls.map(value=>value.method),['getExperimentResultEvidence','readExperimentFile']);
  const auditSource=await readFile(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
  const outputDirectory=resolve('.artifacts/research-optimization/xexp-a3-ui');await mkdir(outputDirectory,{recursive:true});
  const receipts=[];
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.setViewportSize({width:650,height:900});
    const audit=await page.evaluate(`(${auditSource})({root:'main',viewport:false})`);
    assert.equal(audit.cut,0);assert.equal(audit.hidden,0);
    await page.screenshot({path:join(outputDirectory,`${theme}-source.png`),fullPage:true});
    receipts.push({theme,audit});
  }
  await writeFile(join(outputDirectory,'receipt.json'),JSON.stringify({evidence,receipt,receipts},null,2));
});

test('archived metric capture is disabled and a late evidence read cannot restore a cleared source',async()=>{
  const receipt=await review(repeat,'trace-late');
  await scene(repeat,false);await openResult(receipt);
  assert.equal(await page.getByLabel('证据指标',{exact:true}).isDisabled(),true);
  const evidence=await api.withResearchHumanContext({capability:'research.experimentResults.captureEvidence',projectId:f.project.id,windowId},
    ()=>results.captureEvidence({projectId:f.project.id,resultId:receipt.snapshot.id,expectedHash:receipt.snapshotHash,metricId:'mean'}));
  active={defer:'getExperimentResultEvidence'};const held=active;
  await page.evaluate(source=>mountEvidence(source),f.repository.evidence.inspectEvidence(evidence.id,f.project.id));
  await page.locator('details > summary').click();
  await page.getByTestId(`artifact-experiment-evidence-toggle-${evidence.id}`).click();
  while(typeof held.finish!=='function')await new Promise(done=>setTimeout(done,10));
  await page.evaluate(()=>clear());held.finish();
  assert.equal(await page.getByTestId('artifact-experiment-result-receipt').count(),0);
});
