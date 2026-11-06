import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import electronPath from 'electron';
import {_electron,expect} from '@playwright/test';
import {createResearchFixture,loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {zenodoProviderFixture} from '../fixtures/zenodo-provider.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
let api,directory,app,page,active;
const fixtures=[],errors=[],calls=[];
const artifacts=join(process.cwd(),'.artifacts/research-optimization/zenodo-ui');
const methods=['getZenodoInputs','prepareZenodo','getZenodoPreparation','getZenodoPreparations','saveZenodoCredential','clearZenodoCredential','getZenodoCredentialStatus','startZenodoOperation','getZenodoOperation','getZenodoOperations','refreshZenodoOperation','resumeZenodoOperation','approveZenodoPublication','publishZenodo','cancelZenodoOperation','getZenodoOperationForPreparation','getExport','listExports','listFigures','listTemplates'];
before(async()=>{
  api=await loadResearchTestApi();directory=mkdtempSync(join(tmpdir(),'roc-zenodo-ui-'));mkdirSync(artifacts,{recursive:true});
  await buildViteRenderer({directory,script:`
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {ZenodoPanel} from './src/renderer/artifacts/ZenodoPanel';
    import {ArtifactExportReview} from './src/renderer/artifacts/ArtifactExportReview';
    const root=createRoot(document.getElementById('root'));
    const methods=${JSON.stringify(methods)};
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    function Harness({record,surface}){const [writable,setWritable]=useState(true),[dirty,setDirty]=useState(false),[pending,setPending]=useState(false);
      window.setWritable=value=>flushSync(()=>setWritable(value));
      return <main data-testid="fixture-container"><button disabled={dirty||pending}>关闭工件</button>{surface==='export'?<ArtifactExportReview client={client} snapshot={{artifact:{projectId:record.projectId,id:'artifact'},version:'fixture'}} writable={writable} locked={false} onDirty={setDirty} onPending={setPending}/>:<ZenodoPanel client={client} record={record} writable={writable} onDirty={setDirty} onPending={setPending}/>}</main>;}
    let generation=0;window.mount=(record,surface)=>flushSync(()=>root.render(<Harness key={++generation} record={record} surface={surface}/>));`,
    style:'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{width:min(100%,540px);box-sizing:border-box;padding:16px;font-size:13px}'});
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fromMain',async(method,input)=>{
    const f=active;calls.push({method,input:method==='saveZenodoCredential'?{...input,plaintext:'[redacted]'}:input});
    const exportChannel={getExport:'roc:research:export-get',listExports:'roc:research:export-list',listFigures:'roc:research:figure-list',listTemplates:'roc:research:template-list'}[method];
    if(exportChannel!==undefined){
      api.parseIpcRequestArgs(exportChannel,[input]);
      assert.equal(input.projectId,f.project.id);
      return {ok:true,data:method==='getExport'?f.export:method==='listExports'?[f.export]:[]};
    }
    const suffix={getZenodoInputs:'inputs',prepareZenodo:'prepare',getZenodoPreparation:'read',getZenodoPreparations:'list',saveZenodoCredential:'saveCredential',clearZenodoCredential:'clearCredential',getZenodoCredentialStatus:'credentialStatus',startZenodoOperation:'start',getZenodoOperation:'getOperation',getZenodoOperations:'listOperations',refreshZenodoOperation:'refresh',resumeZenodoOperation:'resume',approveZenodoPublication:'approvePublication',publishZenodo:'publish',cancelZenodoOperation:'cancel',getZenodoOperationForPreparation:'operationForPreparation'}[method];
    api.parseIpcRequestArgs(`roc:research:zenodo-${suffix}`,[input]);
    const result=await f.bridge.invoke(`research.${method}`,[input],71);
    const held=f.holds.get(method);
    if(held!==undefined){held.ready.resolve();return new Promise(resolve=>{held.release=()=>{f.holds.delete(method);resolve(held.loseReply?{ok:false,error:{code:'fixture_reply_lost',message:'回执连接中断'}}:result);};});}
    return result;
  });await page.waitForFunction(()=>typeof mount==='function');
});
after(async()=>{try{await app?.close();}finally{for(const f of fixtures){await f.service.shutdown();f.close();}api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
const hash=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
async function scene(surface){
  const f=createResearchFixture(api,'reading');fixtures.push(f);active=f;calls.length=0;f.source='original';f.bytes=Buffer.from('task-created-synthetic-bytes');f.holds=new Map();
  f.export={id:'ui-export',projectId:f.project.id,status:'ready',approval:'approved',error:null,createdAt:'2026-11-06T00:00:00.000Z',endedAt:'2026-11-06T00:00:01.000Z',
    request:{title:'Synthetic approved export',manuscriptArtifactId:'artifact',publicationReview:{sourceHash:hash('fixture'),publication:{name:'Synthetic publication',description:'Isolated fixture',version:'1.2',profile:'roc-research-1',datePublished:'2026-11-06',authors:[{name:'Synthetic Author',orcid:null}],license:{name:'CC BY 4.0',description:'Synthetic license review',url:null}},resources:[],references:[]}},
    archive:{path:'paper.zip',size:f.bytes.length,sha256:hash(f.bytes)},files:[{path:'paper.pdf',size:f.bytes.length,sha256:hash(f.bytes)}]};
  f.repository.exports.get=()=>f.export;
  f.preparations=new api.ZenodoPreparationService(f.db,f.repository,{async publicationInputs(request){if(f.localFailure)throw new Error(f.localFailure);return api.sealZenodo(api.zenodoInputsSchema.omit({contentHash:true}).parse({projectId:f.project.id,exportId:f.export.id,artifactId:'artifact',exportHash:hash(JSON.stringify(f.export)),sourceHash:hash(f.source),files:request.files.map(file=>({...file,size:f.bytes.length,sha256:hash(f.bytes),md5:hash(f.bytes,'md5')}))}));}});
  const token='task-created-zenodo-ui-token';f.secretValues=new Map([['zenodo-sandbox',token]]);f.secrets={get:async key=>f.secretValues.get(key)??null,set:async(key,value)=>{f.secretValues.set(key,value);},clear:key=>f.secretValues.delete(key)};
  f.provider=zenodoProviderFixture(token);let clock=Date.now();
  const governor=new api.LiteratureProviderGovernor(Object.fromEntries(['sandbox.zenodo.org','zenodo.org'].map(host=>[host,{minIntervalMs:1,maxRequests:1000,windowMs:3600000,failureThreshold:100,cooldownMs:1}])),()=>clock,async(ms,signal)=>{signal.throwIfAborted();clock+=ms;});
  f.operations=new api.ZenodoOperationRepository(f.db,f.repository,f.preparations);
  f.service=new api.ZenodoPublicationService(f.repository,f.preparations,f.operations,new api.ZenodoTransport(f.secrets,f.provider.fetch,governor),f.secrets,async(preparation,name,signal,send)=>{signal.throwIfAborted();return send(new ReadableStream({start(controller){controller.enqueue(f.bytes);controller.close();}}),f.bytes.length);});
  const registry=new api.CapabilityRegistry();for(const descriptor of [...api.researchZenodoCapabilities,...api.researchZenodoPublicationCapabilities])registry.declare('fixture',descriptor);
  api.registerResearchZenodoCapabilities({pluginId:'fixture',capabilities:registry},f.preparations);api.registerResearchZenodoPublicationCapabilities({pluginId:'fixture',capabilities:registry},f.service,f.operations);
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
  f.hold=(method,loseReply=false)=>{const value={ready:Promise.withResolvers(),loseReply};f.holds.set(method,value);return value;};
  await page.evaluate(({record,surface})=>mount(record,surface),{record:f.export,surface});
  if(surface==='export'){
    await button('读取已保存导出').click();await button(/^Synthetic approved export/).click();
    await page.getByTestId('artifact-zenodo-toggle').click();
  }
  await page.getByTestId('artifact-zenodo-panel').waitFor();return f;
}
const button=name=>page.getByRole('button',{name,exact:true});
async function prepare({save=true}={}){
  await button('审查新的 Zenodo 准备').click();const editor=page.getByTestId('artifact-zenodo-editor');
  await editor.getByRole('checkbox',{name:'archive / paper.zip',exact:false}).check();await editor.getByLabel('上传名 paper.zip',{exact:true}).fill('paper.zip');
  await editor.getByLabel('Zenodo 环境',{exact:true}).selectOption('sandbox');await editor.getByLabel('出版类型',{exact:true}).selectOption('preprint');
  for(const [label,value]of[['Zenodo 标题','Synthetic UI publication'],['Zenodo 说明','Task-created isolated engineering acceptance.'],['Zenodo 发布日期','2026-11-06'],['Zenodo 许可 ID','cc-by-4.0'],['Zenodo 版本','fixture-1'],['作者 1 姓名','Synthetic Author']])await editor.getByLabel(label,{exact:true}).fill(value);
  for(const label of['已检查隐私，允许所选内容公开','已核对全部文件的公开许可','已核对作者与署名授权'])await editor.getByRole('checkbox',{name:label,exact:true}).check();
  await button('预览并核对拟上传文件').click();await page.getByTestId('artifact-zenodo-local-preview').waitFor();
  if(!save)return;
  await button('确认清单并保存本地准备').click();await page.getByTestId('artifact-zenodo-operation').waitFor();
}
async function start(){await button('创建草稿并上传文件').click();await page.getByText('文件已核对，等待公开批准',{exact:true}).waitFor();}
async function approve(){await page.getByRole('checkbox',{name:'已审查完整远端元数据、文件、公开关联标识和环境，单独批准公开发布',exact:true}).check();await button('保存独立公开批准').click();await expect(button('使用该批准公开发布')).toBeEnabled();}
test('local preparation requires explicit files, metadata and declarations, locks the shell, and invalidates preview on changes',async()=>{
  const f=await scene();await button('审查新的 Zenodo 准备').focus();await page.keyboard.press('Enter');
  await expect(button('关闭工件')).toBeDisabled();await button('预览并核对拟上传文件').click();assert.equal(calls.some(value=>value.method==='prepareZenodo'),false);
  await button('放弃 Zenodo 编辑').click();await expect(button('关闭工件')).toBeEnabled();
  await prepare({save:false});
  await page.getByLabel('Zenodo 标题',{exact:true}).fill('Corrected synthetic title');
  await expect(page.getByTestId('artifact-zenodo-local-preview')).toHaveCount(0);
  await expect(button('确认清单并保存本地准备')).toBeDisabled();
  await button('预览并核对拟上传文件').click();
  await expect(page.getByTestId('artifact-zenodo-local-preview')).toContainText('Corrected synthetic title');
  const held=f.hold('prepareZenodo',true);
  await button('确认清单并保存本地准备').click();await held.ready.promise;held.release();
  await button('重试同一准备请求').click();await page.getByTestId('artifact-zenodo-operation').waitFor();
  const attempts=calls.filter(value=>value.method==='prepareZenodo');assert.deepEqual(attempts[0].input,attempts[1].input);
  assert.equal(f.provider.calls.length,0);assert.equal(f.preparations.list({projectId:f.project.id,offset:0,limit:20}).total,1);
  assert.match(await page.getByTestId('artifact-zenodo-receipt').innerText(),new RegExp(hash(f.bytes,'md5')));
});
test('complete remote review and independent main human grant precede publishing; unknown replies query without repeat POST',async()=>{
  const f=await scene();await prepare();await start();assert.equal(f.provider.records.size,1);assert.equal(f.provider.uploads.length,1);
  await expect(button('使用该批准公开发布')).toBeDisabled();assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,0);
  assert.match(await page.getByTestId('artifact-zenodo-remote').innerText(),/urn:uuid:/);
  await approve();const held=f.hold('publishZenodo',true);await button('使用该批准公开发布').click();await held.ready.promise;
  await expect(button('关闭工件')).toBeDisabled();held.release();await button('重试同一远端请求').waitFor();
  await button('重试同一远端请求').click();await page.getByText('已公开发布',{exact:true}).waitFor();assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,1);
  assert.match(await page.getByTestId('artifact-zenodo-remote').innerText(),/10\.5072/);await expect(button('关闭工件')).toBeEnabled();
});
test('lost approval reply reuses the exact immutable grant, while local and remote drift stop public writes',async()=>{
  const f=await scene();await prepare();await start();
  const held=f.hold('approveZenodoPublication',true);await page.getByRole('checkbox',{name:'已审查完整远端元数据、文件、公开关联标识和环境，单独批准公开发布',exact:true}).check();await button('保存独立公开批准').click();await held.ready.promise;held.release();
  await button('重试同一远端请求').click();await expect(button('使用该批准公开发布')).toBeEnabled();
  assert.equal(f.db.prepare('SELECT count(*) FROM research_zenodo_publication_approvals').pluck().get(),1);
  const attempts=calls.filter(value=>value.method==='approveZenodoPublication');assert.deepEqual(attempts[0].input,attempts[1].input);
  f.source='changed';await button('使用该批准公开发布').click();await page.getByText('research_zenodo_inputs_changed',{exact:true}).waitFor();assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,0);
  f.source='original';const remote=[...f.provider.records.values()][0];remote.metadata.title='Changed remotely';await button('查询远端实际状态').click();await page.getByText('research_zenodo_remote_metadata_changed',{exact:true}).waitFor();await expect(button('使用该批准公开发布')).toHaveCount(0);
});
test('credential entry is transient, environment scoped and masked; archive retains readonly history',async()=>{
  const f=await scene();await page.getByLabel('凭据环境',{exact:true}).selectOption('production');await page.getByText('该环境没有保存凭据',{exact:true}).waitFor();
  const input=page.getByLabel('Zenodo 访问令牌',{exact:true});await input.fill('task-created-private-input');await expect(button('关闭工件')).toBeDisabled();
  assert.equal(await input.getAttribute('type'),'password');await button('加密保存凭据').click();await expect(input).toHaveValue('');await page.getByText('凭据已加密保存',{exact:true}).waitFor();
  assert.equal(f.secretValues.get('zenodo-production'),'task-created-private-input');assert.equal(await page.locator('body').innerText().then(text=>text.includes('task-created-private-input')),false);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);await button('清除该环境凭据').click();await page.getByText('该环境没有保存凭据',{exact:true}).waitFor();
  await prepare();await start();f.repository.updateProject({id:f.project.id,status:'archived'});await page.evaluate(()=>setWritable(false));
  await button('读取 Zenodo 历史').click();await page.getByRole('region',{name:'远端操作历史',exact:true}).waitFor();await expect(button('保存独立公开批准')).toBeDisabled();assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,0);
});
test('history pages retain exact preparation identity and selecting an existing preparation never creates another remote record',async()=>{
  const f=await scene();await prepare();await start();await button('读取 Zenodo 历史').click();const preparationRegion=page.getByRole('region',{name:'本地准备历史',exact:true});await preparationRegion.waitFor();
  await preparationRegion.getByRole('button',{name:/Synthetic UI publication/}).click();await page.getByText('文件已核对，等待公开批准',{exact:true}).waitFor();await expect(button('创建草稿并上传文件')).toHaveCount(0);assert.equal(f.provider.records.size,1);
  const operationRegion=page.getByRole('region',{name:'远端操作历史',exact:true});await operationRegion.getByRole('button',{name:/文件已核对/}).click();await expect(button('查询远端实际状态')).toBeEnabled();
  const request=calls.find(value=>value.method==='prepareZenodo').input;
  for(let index=0;index<20;index++){
    const prepared=await f.bridge.invoke('research.prepareZenodo',[{...request,requestId:`page-${index}`,metadata:{...request.metadata,title:`Pagination ${index}`}}],71);
    assert.equal(prepared.ok,true);
    const started=await f.bridge.invoke('research.startZenodoOperation',[{projectId:f.project.id,preparationId:prepared.data.id,requestId:`start-page-${index}`,expectedPreparationHash:prepared.data.contentHash}],71);
    assert.equal(started.ok,true);
  }
  await button('读取 Zenodo 历史').click();
  await expect(preparationRegion.getByRole('heading')).toHaveText('项目准备历史，共 21 项');
  await expect(preparationRegion.locator('li')).toHaveCount(20);await expect(operationRegion.locator('li')).toHaveCount(20);
  await button('下一页准备').click();await expect(preparationRegion.locator('li')).toHaveCount(1);
  await button('下一页操作').click();await expect(operationRegion.locator('li')).toHaveCount(1);
  await preparationRegion.getByRole('button',{name:/Synthetic UI publication/}).click();
  await page.getByText('文件已核对，等待公开批准',{exact:true}).waitFor();
  assert.equal(f.provider.records.size,21);await expect(button('创建草稿并上传文件')).toHaveCount(0);
});
test('lookup failures block creation until retry and old project replies cannot replace the current scope',async()=>{
  const f=await scene();const lookup=f.hold('getZenodoOperationForPreparation',true);
  await prepare();await lookup.ready.promise;await expect(button('创建草稿并上传文件')).toBeDisabled();lookup.release();
  await button('重试读取既有操作').click();await expect(button('创建草稿并上传文件')).toBeEnabled();
  const held=f.hold('startZenodoOperation');await button('创建草稿并上传文件').click();await held.ready.promise;
  await expect(button('取消正在进行的请求')).toBeEnabled();await button('取消正在进行的请求').click();
  await expect(button('关闭工件')).toBeDisabled();
  const next=await scene();held.release();await expect(button('关闭工件')).toBeEnabled();
  await expect(page.getByTestId('artifact-zenodo-operation')).toHaveCount(0);
  assert.equal(next.provider.calls.length,0);
});
test('the existing export surface propagates Zenodo dirty and pending locks without disabling its own editor',async()=>{
  await scene('export');await prepare({save:false});
  for(const name of['关闭工件','审查新的导出选择','读取已保存导出','刷新生成状态','收起 Zenodo 发布'])await expect(button(name)).toBeDisabled();
  await expect(button('确认清单并保存本地准备')).toBeEnabled();
  await button('放弃 Zenodo 编辑').click();
  for(const name of['关闭工件','审查新的导出选择','读取已保存导出','刷新生成状态','收起 Zenodo 发布'])await expect(button(name)).toBeEnabled();
});
test('cancelling an in-flight upload stops the transport and preserves its uncertain remote state',async()=>{
  const f=await scene();await prepare();const reached=Promise.withResolvers();
  f.provider.override=(url,init,respond)=>{
    if(init.method!=='PUT')return respond();
    reached.resolve();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  };
  await button('创建草稿并上传文件').click();await reached.promise;
  await button('取消正在进行的请求').click();await page.getByText('上传结果待查询',{exact:true}).waitFor();
  await expect(button('关闭工件')).toBeEnabled();assert.equal(f.provider.uploads.length,0);assert.equal(f.provider.records.size,1);
  assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,0);
});
test('650px light and dark complete review remains readable with keyboard focus and no clipped action states',async()=>{
  const f=await scene();await prepare();await start();await page.setViewportSize({width:650,height:800});
  const clip=readFileSync(join(process.cwd(),'.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');const evidence=[];
  for(const theme of['light','dark']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    for(const state of['static','hover','expanded','focus']){
      const target=button('查询远端实际状态');await target.scrollIntoViewIfNeeded();
      if(state==='hover')await target.hover();if(state==='focus')await target.focus();
      const audit=await page.evaluate(({clip})=>eval(clip)({root:'[data-testid="fixture-container"]',viewport:true}),{clip});assert.equal(audit.cut,0,JSON.stringify(audit));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);evidence.push({theme,state,...audit});
    }
    await page.screenshot({path:join(artifacts,`${theme}-review.png`),fullPage:true});
  }
  writeFileSync(join(artifacts,'clip-states.json'),JSON.stringify(evidence,null,2));await page.setViewportSize({width:1100,height:900});assert.equal(f.provider.calls.filter(call=>call.pathname.endsWith('/actions/publish')).length,0);
});
