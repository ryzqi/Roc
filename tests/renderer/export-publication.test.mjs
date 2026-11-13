import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/export-publication-ui');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-export-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const methods=['inspectArtifact','listFigures','listTemplates','getExportInputs','prepareExport','getExport','listExports','cancelExport'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    function Harness({initial}) {
      const [request,setRequest]=useState(initial),[writable,setWritable]=useState(true);
      const [locations]=useState(()=>new Map()),[drafts]=useState(()=>new Map());
      window.setWritable=value=>flushSync(()=>setWritable(value));
      return <main>{request===null?null:<ArtifactInspector key={JSON.stringify(request)} client={client}
        selection={{kind:'stage',request,onReviewContext:()=>{}}} writable={writable}
        readingLocations={locations} reviewDrafts={drafts} onClose={()=>setRequest(null)} onOpenTask={()=>{}}/>}</main>;
    }
    let generation=0;
    window.mount=input=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initial={input}/></LazyMotion></MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fromMain', async (method, input) => {
    const f = active; calls.push({method, input});
    const channel = {inspectArtifact:'roc:research:artifact-inspect',listFigures:'roc:research:figure-list',
      listTemplates:'roc:research:template-list',getExportInputs:'roc:research:export-inputs',prepareExport:'roc:research:export-prepare',
      getExport:'roc:research:export-get',listExports:'roc:research:export-list',cancelExport:'roc:research:export-cancel'}[method];
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 73);
    const hold = f.holds.get(method);
    if (hold !== undefined) return new Promise(resolve => {
      hold.release = () => resolve(hold.loseReply ? {ok: false, error: {code: 'fixture_reply_lost', message: '导出回执连接中断'}} : result);
      hold.ready.resolve();
    });
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  if (page !== undefined && !page.isClosed()) await page.evaluate(() => window.unmount?.());
  try {await app?.close();} finally {
    for (const f of fixtures) {await f.service?.shutdown(); await f.templateService?.shutdown(); f.close(); rmSync(f.root, {recursive: true, force: true});} api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
const hash = value => createHash('sha256').update(value).digest('hex');
async function scene({approved = true, stage = 'export', imported = false} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-export-material-')));
  const f = createResearchFixture(api, 'writing', root); f.root = root;
  fixtures.push(f); active = f; calls.length = 0; f.holds = new Map();
  f.repository.knowledge.upsertFromSource({id:'export-ui-source',projectId:f.project.id,sourceType:'file',sourceId:'synthetic.md',
    title:'Synthetic source',content:'Measured difference was -4 ms.',chunks:[{content:'Measured difference was -4 ms.',locator:'block:0'}],embeddingPolicy:'none'});
  const evidence = f.repository.evidence.capture({projectId:f.project.id,chunkId:'export-ui-source:chunk:0'});
  f.artifactId = f.withWorker(() => f.repository.runs.complete(f.run.id,f.project.id,{title:'合成导出验收',markdown:'Synthetic manuscript',
    claims:[{subjectType:'paragraph',content:'Measured difference was -4 ms.',status:'supported',evidenceIds:[evidence.id]}],
    sections:[{title:'Results',claimIndexes:[0]}],verdict:'ready'})).outputArtifactIds[0];
  for (const claim of f.repository.evidence.listClaims({projectId:f.project.id,artifactId:f.artifactId})) {
    const source = f.repository.evidence.inspectEvidence(evidence.id,f.project.id);
    const relation = f.repository.evidence.relations.propose({projectId:f.project.id,claimId:claim.id,expectedClaimVersion:claim.version,
      evidenceId:evidence.id,expectedSourceDigest:hash(JSON.stringify(source)),kind:'supports',condition:null,supersedesRelationId:null},
      {kind:'user',id:'synthetic-ui-reviewer'});
    f.repository.evidence.relations.review({projectId:f.project.id,relationId:relation.id,expectedVersion:relation.version,
      expectedClaimVersion:relation.claimVersion,expectedSourceDigest:relation.sourceDigest,decision:'confirm',note:'Synthetic explicit support review.'},
      {kind:'user',id:'synthetic-ui-reviewer'});
  }
  if (approved) f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
  f.db.prepare('UPDATE research_projects SET current_stage=? WHERE id=?').run(stage,f.project.id);
  f.db.prepare(`INSERT INTO research_review_cycles(project_id,origin_artifact_id,manuscript_artifact_id,revision_round,status,report_artifact_ids_json,updated_at)
    VALUES(?,?,?,0,'accepted','[]',?)`).run(f.project.id,f.artifactId,f.artifactId,'2026-11-03T00:00:00.000Z');
  f.templateService = new api.ResearchTemplateService(f.repository,{});
  if (imported) {
    const source = join(root,'template-source'); mkdirSync(source);
    writeFileSync(join(source,'main.tex'),'\\documentclass{article}\n\\begin{document}\n\\input{roc-manuscript.tex}\n\\bibliography{roc-references}\n\\end{document}\n');
    const template = await f.templateService.importTemplate({projectId:f.project.id,sourcePath:source});
    writeFileSync(join(root,'synthetic-template.pdf'),'Synthetic fixture PDF');
    f.template = f.repository.saveTemplate({...template,status:'ready',pdfPath:join(root,'synthetic-template.pdf'),pdfHash:hash('Synthetic fixture PDF'),
      compiledRevision:template.revision,compiledDigest:template.sourceDigest},template.revision);
  }
  f.sources = new api.ResearchExportSourceService(f.repository,{verify:async()=>assert.fail('no figure selected')},
    {snapshot:async()=>assert.fail('no experiment selected')},f.templateService);
  f.compile = Promise.withResolvers();
  f.service = new api.ResearchExportService(f.repository,f.sources,{identity:async()=>hash('synthetic tools'),status:async()=>({available:true,versions:{fixture:'synthetic-1'},error:null}),
    writeBibliography:async()=>({filename:'references.bib',content:'@misc{synthetic,title={Synthetic source}}'}),
    compile:input=>new Promise((resolve,reject)=>{
      f.compile.reject=()=>reject(new Error('synthetic_compile_failed'));
      input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}); f.compile.resolve();
    })},join(root,'exports'),{error(){},warn(){}});
  const handlers=new Map(),context={pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}};
  api.registerResearchArtifactInspectorCapability(context,f.repository);
  api.registerResearchExportCapabilities(context,f.repository.exports,f.service);
  handlers.set('research.figure.list',input=>f.repository.figures.list(input.projectId,input.limit));
  handlers.set('research.template.list',input=>f.repository.listTemplates(input.projectId));
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
  f.request={projectId:f.project.id,artifactId:f.artifactId,expectedVersion:null};
  f.hold=(method,loseReply=false)=>{const value={ready:Promise.withResolvers(),loseReply};f.holds.set(method,value);return value;};
  await page.evaluate(request=>mount(request),f.request); await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
const editor=()=>page.getByTestId('artifact-export-editor'),review=()=>page.getByTestId('artifact-export-review');
const text=(label,value)=>(label==='发布日期'?editor().getByLabel(label,{exact:true}):editor().getByRole('textbox',{name:label,exact:true})).fill(value);
const select=(label,value)=>editor().getByRole('combobox',{name:label,exact:true}).selectOption(value);
async function open() {
  await page.getByTestId('artifact-export-toggle').focus(); await page.keyboard.press('Enter');
  await review().waitFor(); await page.getByTestId('artifact-export-inputs-load').waitFor();
}
async function capture(template='default:en') {
  await review().getByRole('combobox',{name:'导出模板',exact:true}).selectOption(template);
  await page.getByTestId('artifact-export-inputs-load').click(); await editor().waitFor();
}
async function publication() {
  await text('出版名称','Synthetic publication'); await text('出版说明','Synthetic engineering acceptance.');
  await text('发布日期','2026-11-06'); await text('作者 1 姓名','Synthetic author');
  const license=editor().getByRole('region',{name:'出版许可',exact:true});
  await license.getByLabel('许可名称',{exact:true}).fill('Synthetic redistribution permission');
  await license.getByLabel('许可及权限说明',{exact:true}).fill('Human explicitly permits redistribution of synthetic content.');
}
async function metadata(region,{name='Synthetic resource',software=false}={}) {
  await region.getByLabel('名称',{exact:true}).fill(name); await region.getByLabel('说明',{exact:true}).fill('Synthetic source content.');
  if(software){await region.getByLabel('版本（软件必填）',{exact:true}).fill('1');await region.getByLabel('公开 URL（软件必填）',{exact:true}).fill('https://example.org/software');}
  await region.getByLabel('许可名称',{exact:true}).fill('Synthetic explicit license');
  await region.getByLabel('许可及权限说明',{exact:true}).fill('Human reviewed the permitted delivery.');
}
async function complete() {
  await publication();
  const reference=editor().getByRole('combobox',{name:'选择待审查文献',exact:true});
  const count=await reference.locator('option').count();
  for(let i=0;i<count;i++) {
    await reference.selectOption(String(i));
    const fields=reference.locator('..').locator('..');
    await metadata(fields,{name:`Synthetic reference ${i+1}`});
    await text('文献获取说明','Acquire the synthetic source from the study author.');
  }
}
async function preview(){await page.getByTestId('artifact-export-preview-button').focus();await page.keyboard.press('Enter');await page.getByTestId('artifact-export-preview').waitFor();}

// Source capture, IPC parsing, replay, repository state and cancellation use real main code.
// The compiler is held or fails deliberately; these tests do not claim successful PDF generation.
test('approved manuscript uses lazy explicit publication review and exact replay after a lost prepare receipt',async()=>{
  const f=await scene();
  assert.equal(calls.some(call=>call.method==='getExportInputs'||call.method==='listTemplates'),false);
  await open(); await page.getByTestId('artifact-export-inputs-load').click(); await review().getByRole('alert').waitFor();
  assert.match(await review().getByRole('alert').innerText(),/明确选择/u);
  await capture();
  assert.equal(await editor().getByLabel('作者 1 姓名',{exact:true}).inputValue(),'');
  assert.equal(await editor().getByLabel('发布日期',{exact:true}).inputValue(),'');
  assert.equal(await page.getByTestId('artifact-export-prepare').isDisabled(),true);
  await page.getByTestId('artifact-export-preview-button').click(); await editor().getByRole('alert').waitFor();
  assert.equal(calls.filter(call=>call.method==='prepareExport').length,0);
  await complete();
  await select('报告与转换稿引用格式','nature');
  await editor().getByRole('checkbox',{name:'DOCX',exact:true}).check();
  for(const id of ['artifact-inspector-refresh','artifact-citation-coverage-toggle','artifact-consistency-toggle',
    'artifact-response-toggle','artifact-journal-toggle','artifact-export-toggle','artifact-export-history-load'])
    assert.equal(await page.getByTestId(id).isDisabled(),true,id);
  await page.keyboard.press('Escape'); await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  assert.equal(await page.getByTestId('artifact-inspector-panel').count(),1);
  await preview(); await text('出版说明','Changed publication description.');
  assert.equal(await page.getByTestId('artifact-export-preview').count(),0);
  assert.equal(await page.getByTestId('artifact-export-prepare').isDisabled(),true); await preview();
  await editor().getByRole('checkbox',{name:'HTML',exact:true}).check();
  assert.equal(await page.getByTestId('artifact-export-preview').count(),0);
  await preview();
  await select('报告与转换稿引用格式','ieee');
  assert.equal(await page.getByTestId('artifact-export-preview').count(),0);
  await preview();
  assert.match(await page.getByTestId('artifact-export-preview').innerText(),/docx、html.*ieee/u);
  const held=f.hold('prepareExport',true);
  await page.getByTestId('artifact-export-prepare').click(); await held.ready.promise;
  assert.equal(await page.getByTestId('artifact-export-discard').isDisabled(),true);
  held.release(); await editor().getByRole('alert').waitFor(); f.holds.delete('prepareExport');
  await page.getByTestId('artifact-export-prepare').click(); await editor().waitFor({state:'hidden'});
  await page.getByTestId('artifact-export-cancel').waitFor();
  const writes=calls.filter(call=>call.method==='prepareExport'); assert.equal(writes.length,2); assert.deepEqual(writes[0].input,writes[1].input);
  assert.deepEqual(writes[0].input.conversionFormats,['docx','html']);
  assert.equal(writes[0].input.reportCitationStyle,'ieee');
  assert.equal(f.repository.exports.list(f.project.id,200).length,1);
  await page.getByTestId('artifact-export-cancel').click(); await review().getByText('已取消，尚未登记科研工件',{exact:true}).waitFor();
});

test('mandatory template bytes require explicit bundled permission and preview preserves complete metadata',async()=>{
  const f=await scene({imported:true}); await open(); await capture(f.template.id); await complete();
  const resource=page.getByTestId('artifact-export-resource-editor');
  const count=await editor().getByRole('combobox',{name:'选择待审查资源',exact:true}).locator('option').count(); assert.ok(count>=1);
  await page.getByTestId('artifact-export-preview-button').click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(),/对象类型与交付方式/u);
  for(let i=0;i<count;i++) {
    await select('选择待审查资源',String(i));
    assert.equal(await resource.locator('option[value="metadata_only"]').evaluate(el=>el.disabled),true);
    await select('科研对象类型','software'); await metadata(resource,{software:true});
    await select('交付方式','bundled');
  }
  await preview();
  const receipt=page.getByTestId('artifact-export-preview');
  assert.match(await receipt.innerText(),/Human reviewed the permitted delivery/u);
  assert.match(await receipt.innerText(),/https:\/\/example.org\/software/u);
  assert.match(await receipt.innerText(),/已确认再分发权限/u);
  await page.getByTestId('artifact-export-discard').click(); await editor().waitFor({state:'hidden'});
});

test('source drift refuses preview and permission changes retain drafts with an accessible discard',async()=>{
  const f=await scene(); await open(); await capture(); await complete();
  f.db.prepare('UPDATE research_projects SET description=? WHERE id=?').run('Changed source facts.',f.project.id);
  await page.getByTestId('artifact-export-preview-button').click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(),/出版来源已变化/u);
  assert.equal(await page.getByTestId('artifact-export-preview').count(),0);
  await page.evaluate(()=>setWritable(false));
  assert.equal(await editor().getByLabel('出版名称',{exact:true}).inputValue(),'Synthetic publication');
  assert.equal(await page.getByTestId('artifact-export-preview-button').isDisabled(),true);
  assert.equal(await page.getByTestId('artifact-export-discard').isDisabled(),false);
  await page.getByTestId('artifact-export-discard').click(); await editor().waitFor({state:'hidden'});
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(),false);
  assert.equal(calls.some(call=>call.method==='prepareExport'),false);
});

test('cancellation locks receipt navigation until actual completion and saved status refresh/history stay truthful',async()=>{
  const f=await scene(); await open(); await capture(); await complete(); await preview();
  await page.getByTestId('artifact-export-prepare').click(); await page.getByTestId('artifact-export-cancel').waitFor(); await Promise.race([f.compile.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(JSON.stringify(f.repository.exports.list(f.project.id,200).map(record=>({status:record.status,error:record.error}))))),3000))]);
  await page.evaluate(()=>setWritable(false));
  assert.equal(await page.getByTestId('artifact-export-cancel').isDisabled(),true);
  assert.equal(calls.some(call=>call.method==='cancelExport'),false);
  await page.evaluate(()=>setWritable(true));
  await page.getByTestId('artifact-export-history-load').click(); await page.getByTestId('artifact-export-history').waitFor();
  const held=f.hold('cancelExport'); await page.getByTestId('artifact-export-cancel').click(); await held.ready.promise;
  for(const target of [review().getByRole('button',{name:'审查新的导出选择'}),page.getByTestId('artifact-export-history-load'),
    page.getByTestId('artifact-export-history').getByRole('button'),page.getByTestId('artifact-inspector-refresh')])
    assert.equal(await target.isDisabled(),true);
  held.release(); f.holds.delete('cancelExport'); await review().getByText('已取消，尚未登记科研工件',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(),false);
  await review().getByText('查看已提交的公开交付清单',{exact:true}).click();
  await page.getByTestId('artifact-export-execution').getByText('Synthetic author',{exact:true}).waitFor();
  assert.match(await page.getByTestId('artifact-export-execution').innerText(),/Synthetic author/u);
  await review().getByRole('button',{name:'审查新的导出选择'}).click();
  await page.getByTestId('artifact-export-history').getByRole('button').click();
  await review().getByText('已取消，尚未登记科研工件',{exact:true}).waitFor();
  await page.getByTestId('artifact-export-status-refresh').click(); await review().getByText('已取消，尚未登记科研工件',{exact:true}).waitFor();
});

test('draft inactive archived and client-readonly scenes cannot prepare or cancel exports',async()=>{
  await scene({approved:false}); assert.equal(await page.getByTestId('artifact-export-toggle').count(),0);
  for(const state of ['inactive','archived','readonly']) {
    const f=await scene({stage:state==='inactive'?'writing':'export'});
    if(state==='archived'){f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);await page.evaluate(request=>mount(request),f.request);}
    if(state==='readonly')await page.evaluate(()=>setWritable(false));
    await page.getByTestId('artifact-export-toggle').click(); await review().waitFor();
    assert.equal(await page.getByTestId('artifact-export-inputs-load').count(),0,state);
    await page.getByTestId('artifact-export-history-load').click(); await review().getByText('此稿件没有已保存导出。',{exact:true}).waitFor();
    assert.equal(calls.some(call=>['prepareExport','cancelExport'].includes(call.method)),false,state);
  }
});

test('late capture preview submit and history replies never populate a different project',async()=>{
  const a=await scene();await open();const captureHold=a.hold('getExportInputs');
  await review().getByRole('combobox',{name:'导出模板',exact:true}).selectOption('default:en');await page.getByTestId('artifact-export-inputs-load').click();await captureHold.ready.promise;
  const b=await scene();await open();a.holds.delete('getExportInputs');captureHold.release();
  assert.equal(await editor().count(),0);await capture();await complete();const previewHold=b.hold('getExportInputs');
  await page.getByTestId('artifact-export-preview-button').click();await previewHold.ready.promise;
  const c=await scene();await open();b.holds.delete('getExportInputs');previewHold.release();await capture();await complete();await preview();
  const submitHold=c.hold('prepareExport');await page.getByTestId('artifact-export-prepare').click();await submitHold.ready.promise;
  const d=await scene();await open();c.holds.delete('prepareExport');submitHold.release();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('artifact-export-execution').count(),0);
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(),false);
  const historyHold=d.hold('listExports');await page.getByTestId('artifact-export-history-load').click();await historyHold.ready.promise;
  await scene();await open();d.holds.delete('listExports');historyHold.release();
  assert.equal(await page.getByTestId('artifact-export-history').count(),0);
});

test('narrow light/dark fields and preview support keyboard focus and exact clipping audit',async()=>{
  await scene();await open();await capture();await complete();
  await text('出版说明','长公开说明核对作者、许可与来源。'.repeat(70));await preview();
  const auditSource=readFileSync(join(process.cwd(),'.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
  await page.setViewportSize({width:650,height:900});await page.emulateMedia({reducedMotion:'reduce'});
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    for(const state of ['fields','preview']) {
      const target=state==='fields'?editor().getByRole('textbox',{name:'出版说明',exact:true}):page.getByTestId('artifact-export-prepare');
      await target.focus();await target.scrollIntoViewIfNeeded();await target.hover();
      assert.equal(await target.evaluate(el=>el===document.activeElement),true);
      const audit=await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      writeFileSync(join(artifacts,`${theme}-${state}-audit.json`),JSON.stringify(audit,null,2));
      assert.equal(audit.cut,0);assert.equal(audit.hidden,3);
      const panelPath=await page.getByTestId('artifact-inspector-panel').evaluate(el=>{const parts=[];
        for(let item=el;item&&item!==document.body&&parts.length<4;item=item.parentElement)
          parts.unshift(`${item.tagName.toLowerCase()}${[...item.classList].slice(0,3).map(name=>`.${name}`).join('')}`);
        return parts.join(' > ');});
      assert.deepEqual(audit.issues.map(i=>[i.el,i.kind,i.side,i.level,i.gap,i.why]).sort(),
        ['bottom','right','top'].map(side=>[panelPath,'box-shadow',side,'hidden',0,'overflow:hidden']).sort());
      assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:join(artifacts,`${theme}-${state}-650.png`)});
    }
  }
});
