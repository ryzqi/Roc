import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewProtocolBodyFixture} from '../unit/fixtures/research-review-protocol.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewExtractionFixture} from '../unit/fixtures/research-review-extraction.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c4a-ui');
const channels = {
  listReviewProtocols: 'roc:research:review-protocol-list', getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history', listReviewSearches: 'roc:research:review-search-list',
  listReviewCorpora: 'roc:research:review-corpus-list', getReviewCorpus: 'roc:research:review-corpus-get',
  getReviewCorpusHit: 'roc:research:review-corpus-hit', getReviewDeduplication: 'roc:research:review-deduplication-get',
  saveReviewDuplicateDecision: 'roc:research:review-deduplication-save',
  getReviewDuplicateDecisionHistory: 'roc:research:review-deduplication-history',
  freezeReviewDeduplication: 'roc:research:review-deduplication-freeze',
  createReviewScreeningPlan: 'roc:research:review-screening-createPlan', getReviewScreeningPlan: 'roc:research:review-screening-getPlan',
  getReviewScreeningPhase:'roc:research:review-screening-phase',saveReviewScreeningDecision:'roc:research:review-screening-save',
  getReviewScreeningDecisionHistory:'roc:research:review-screening-history',listReviewScreeningSuggestions:'roc:research:review-screening-suggestions',
  adjudicateReviewScreening:'roc:research:review-screening-adjudicate',getReviewScreeningArbitrationHistory:'roc:research:review-screening-arbitrations',freezeReviewScreeningPhase:'roc:research:review-screening-freeze',
  getReviewFullTextScreeningPhase:'roc:research:review-fulltext-phase',saveReviewFullTextBinding:'roc:research:review-fulltext-save',
  getReviewFullTextBindingHistory:'roc:research:review-fulltext-history',listLibrary:'roc:research:library-list',
  listDocuments:'roc:research:document-list',previewDocument:'roc:research:document-preview',
  getDocument:'roc:research:document-get',getDocumentContent:'roc:research:document-content',
  saveReviewFullTextDecision:'roc:research:review-fulltext-decision-save',getReviewFullTextDecisionHistory:'roc:research:review-fulltext-decision-history',
  listReviewFullTextSuggestions:'roc:research:review-fulltext-suggestions',
  getReviewFullTextArbitrationHistory:'roc:research:review-fulltext-arbitrations',
  listReviewExtractions:'roc:research:review-extraction-list',saveReviewExtraction:'roc:research:review-extraction-save',
  getReviewExtractionHistory:'roc:research:review-extraction-history',listEvidence:'roc:research:evidence-list',inspectEvidence:'roc:research:evidence-inspect'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-extraction-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({initialRequest,writable}) {
      const [request,setRequest]=useState(initialRequest),[open,setOpen]=useState(true);
      const [readingLocations]=useState(()=>new Map()),[reviewDrafts]=useState(()=>new Map());
      window.selectReview=next=>flushSync(()=>setRequest(next));
      return <main><button data-testid="literature-review-inspect" onClick={()=>setOpen(true)}>综述核查</button>
        {!open?null:<ArtifactInspector key={JSON.stringify(request)} client={client} selection={{kind:'review',request}}
          writable={writable} readingLocations={readingLocations} reviewDrafts={reviewDrafts}
          onClose={()=>setOpen(false)} onOpenTask={()=>{}}/>}
      </main>;
    }
    let generation=0;
    window.mount=(initialRequest,writable=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initialRequest={initialRequest} writable={writable}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{padding:16px}'});
  await build({entryPoints:['src/main/pdf-preview-protocol.ts'],outfile:join(directory,'protocol.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    const protocol=require(${JSON.stringify(join(directory,'protocol.cjs'))});protocol.registerPdfPreviewScheme();
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>{
      protocol.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        const method=name==='research.document.source'?'source':name==='research.document.asset'?'asset':null;
        if(method===null)throw new Error('unsupported test resource');
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.callMain('+JSON.stringify(method)+','+JSON.stringify(input)+')');
        if(!result.ok)throw new Error(result.message);
        return new Response(new Uint8Array(result.bytes),{headers:result.headers});
      }}),null);
      return new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))});
    });`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());
  });
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    if(method==='source'||method==='asset'){
      try{const response=await f.registry.invoke(`research.document.${method}`,input);return {ok:true,bytes:Array.from(new Uint8Array(await response.arrayBuffer())),headers:Object.fromEntries(response.headers)};}
      catch(error){return {ok:false,message:error.message};}
    }
    api.parseIpcRequestArgs(channels[method], [input]);
    if (method === f.failMethod && f.readFailure) return {ok:false,error:f.readFailure};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (method === 'getDocumentContent' && f.mismatchContent && result.ok) return {...result,data:{...result.data,run:{...result.data.run,id:'wrong-echoed-full-parse'}}};
    if (method === f.loseReply) {
      f.loseReply = null; assert.equal(result.ok, true, JSON.stringify(result));
      return {ok: false, error: {message: 'Synthetic actual commit reply lost'}};
    }
    if (method === f.deferMethod) {
      return new Promise(resolve => {f.release = () => resolve(result); f.started();});
    }
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {
    for (const f of fixtures) {await f.libraryService?.shutdown();await f.cleanup();}
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function fixture(options) {
  const f=await createReviewExtractionFixture(api,options);
  fixtures.push(f);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities,...api.researchReviewExtractionCapabilities,...api.researchEvidenceCapabilities])registry.declare('research',descriptor);
  const context={pluginId:'research',capabilities:registry};
  api.registerResearchSystematicReviewCapabilities(context,f.repository.systematicReviews);
  api.registerResearchReviewSearchCapabilities(context,f.reviews);api.registerResearchReviewCorpusCapabilities(context,f.corpora);
  api.registerResearchReviewDeduplicationCapabilities(context,f.dedup);
  api.registerResearchReviewScreeningCapabilities(context,f.screening,f.decisions,f.arbitration,f.freezing);
  api.registerResearchReviewFullTextCapabilities(context,f.fulltexts);
  api.registerResearchReviewFullTextScreeningCapabilities(context,f.fullScreening,f.fullArbitration,f.fullFreezing);
  f.libraryService=new api.ResearchLibraryService(f.repository.library,{},f.root,async()=>{throw new Error('unexpected_external_library_request');});
  api.registerResearchLibraryCapabilities(context,f.repository.library,f.libraryService);
  api.registerResearchDocumentCapabilities(context,f.repository.documents,f.service);
  api.registerResearchEvidenceCapabilities(context,f.repository.evidence);
  api.registerResearchReviewExtractionCapabilities(context,f.extractions);
  f.registry=registry;
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
  return f;
}
async function mount(f, writable = true) {
  active = f;
  await page.evaluate(({request, writable}) => window.mount(request, writable),
    {request: {mode: 'manage', projectId: f.project.id, versionId: f.protocol.version.id}, writable});
  await tid('artifact-review-corpus-inspect').first().waitFor();
  await tid('artifact-review-corpus-inspect').first().focus();
  await page.keyboard.press('Enter');
  await tid('artifact-review-dedup').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-review-dedup-refresh"]').disabled);
  if (f.frozen === null) return;
  await tid('artifact-review-screening-inspect').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-screening-plan').waitFor();
  await tid('artifact-review-screening-plan-frozen').waitFor();
  await tid('artifact-review-title-inspect').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-title').waitFor();
  await tid('artifact-review-title-frozen').waitFor();
  await tid('artifact-review-fulltext-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-fulltext-frozen').waitFor();
  await tid('artifact-review-extractions-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-extractions').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-extractions-refresh"]').disabled);
}




const actor={kind:'user',id:'synthetic-extraction-human'};
async function select() {
  await tid('artifact-review-extraction-select').first().focus();await page.keyboard.press('Enter');await tid('artifact-review-extraction-editor').waitFor();
}
async function evidence(f,label) {
  await page.getByLabel(`${label}原文证据`,{exact:true}).selectOption(f.evidence.id);
  const field=tid('artifact-review-extraction-field').filter({has:page.getByRole('heading',{name:label,exact:true})});
  await field.getByText('对应所选全文来源',{exact:false}).waitFor();await field.getByTestId('artifact-review-extraction-evidence-add').click();
}
async function fill(f,{kind='number',value='1',studyKind='text',reason='Synthetic source does not report this field'}={}) {
  await page.getByLabel('提取审核人',{exact:true}).selectOption(f.reviewerIds[0]);
  await page.getByLabel('研究设计值类型',{exact:true}).selectOption(studyKind);
  if(studyKind==='text')await page.getByLabel('研究设计文本',{exact:true}).fill(f.protocol.version.body.qualityAssessment[0].studyDesign);
  else await page.getByLabel('研究设计原因',{exact:true}).fill('Synthetic source study design cannot be classified');
  await evidence(f,'研究设计');
  const label=f.protocol.version.body.extractionFields[0].label;
  await page.getByLabel(`${label}值类型`,{exact:true}).selectOption(kind);
  if(kind==='number')await page.getByLabel(`${label}数值`,{exact:true}).fill(value);
  else if(kind==='text')await page.getByLabel(`${label}文本`,{exact:true}).fill(value);
  else await page.getByLabel(`${label}原因`,{exact:true}).fill(reason);
  await evidence(f,label);await page.getByLabel('提取审核说明',{exact:true}).fill('Synthetic human verifies explicit values, units and original Evidence');
}
async function save() {await tid('artifact-review-extraction-save').click();await tid('artifact-review-extraction-current').waitFor();}
async function audit(label) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const result = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  assert.equal(result.cut, 0);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(result, null, 2));
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}







test('actual frozen included report extraction records explicit human design/value/unit and exact Evidence hashes without a new scientific source',async()=>{
  const f=await fixture();await mount(f);assert.equal(await tid('artifact-review-extraction-select').count(),1);await select();
  assert.equal(await tid('artifact-review-extraction-save').isDisabled(),true);await fill(f);await audit('extraction-default');
  await tid('artifact-review-extraction-save').hover();await audit('extraction-hover');await save();const extraction=f.extractions.list(f.get)[0];
  assert.deepEqual(extraction.snapshot.request.fields,[{fieldId:'difference',unit:'mg/L',value:{kind:'number',number:1},evidence:[f.reference]}]);
  assert.deepEqual(extraction.snapshot.request.studyDesign.evidence,[f.reference]);assert.equal(extraction.snapshot.request.expectedFullFreezeHash,f.fullFrozen.freezeHash);
  assert.equal(extraction.snapshot.request.expectedBindingHash,f.binding.snapshotHash);assert.equal(extraction.snapshot.actor.id,`window:${windowId}`);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),1);
});

test('explicit missing and unjudgeable values retain required field and protocol unit while preserving a human reason rather than fabricating a number',async()=>{
  for(const kind of ['missing','unjudgeable']) {
    const f=await fixture();await mount(f);await select();await fill(f,{kind,studyKind:'unjudgeable'});await save();const extraction=f.extractions.list(f.get)[0];
    assert.equal(extraction.snapshot.request.fields.length,1);assert.equal(extraction.snapshot.request.fields[0].value.kind,kind);
    assert.equal(extraction.snapshot.request.fields[0].unit,'mg/L');assert.ok(!('number' in extraction.snapshot.request.fields[0].value));
    assert.equal(extraction.snapshot.request.studyDesign.value.kind,'unjudgeable');assert.equal(extraction.snapshot.request.fields[0].evidence[0].expectedHash,f.reference.expectedHash);
  }
});

test('blank numeric input cannot submit zero and required evidence must be explicitly chosen for both design and value',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const label=f.protocol.version.body.extractionFields[0].label;
  await page.getByLabel(`${label}数值`,{exact:true}).fill('');assert.equal(await tid('artifact-review-extraction-save').isDisabled(),true);
  await page.getByLabel(`${label}数值`,{exact:true}).fill('0');await save();assert.deepEqual(f.extractions.list(f.get)[0].snapshot.request.fields[0].value,{kind:'number',number:0});
});

test('exact-parent extraction revision preserves original values, units, Evidence and native immutable history',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);await save();const first=f.extractions.list(f.get)[0];
  await tid('artifact-review-extraction-revise').click();await page.getByLabel('Group mean difference值类型',{exact:true}).selectOption('unjudgeable');
  await page.getByLabel('Group mean difference原因',{exact:true}).fill('Synthetic later audit cannot judge the reported outcome. '.repeat(100));
  await page.getByLabel('提取修订原因',{exact:true}).fill('Synthetic human explicitly revises earlier numeric interpretation');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-extraction-current"]')?.textContent.includes('版本 2'));
  const history=f.extractions.history(f.extractionHistory);assert.equal(history.length,2);assert.deepEqual(history[0],{...first,isLatest:false});
  assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);assert.equal(history[1].snapshot.request.fields[0].value.kind,'unjudgeable');
  await tid('artifact-review-extraction-history').locator('summary').first().click();await tid('artifact-review-extraction-history').locator('ul').waitFor({state:'visible'});
  const original=tid('artifact-review-extraction-history').locator('li').first();
  await original.locator('summary').click();await original.locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await original.locator('pre').innerText()),first.snapshot);await audit('extraction-expanded-history');
});

test('lost actual extraction reply retries exact fields and source refs with no duplicate extraction version',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const start=calls.length;f.loseReply='saveReviewExtraction';
  await tid('artifact-review-extraction-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewExtraction');assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_extractions').pluck().get(),1);
});

test('real invalidated Evidence after explicit selection refuses a new extraction without rewriting field value or digest',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);const before=f.changes();
  await tid('artifact-review-extraction-save').click();await tid('artifact-review-extraction-editor').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_extractions').pluck().get(),0);
  assert.equal(await page.getByLabel('Group mean difference数值',{exact:true}).inputValue(),'1');
});

test('real original byte drift refuses extraction at the source boundary with no scientific write and permits exact retry after restoration',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const modified=Buffer.from(f.original);modified[0]^=1;writeFileSync(f.sourcePath,modified);
  const before=f.changes(),start=calls.length;await tid('artifact-review-extraction-save').click();await tid('artifact-review-extraction-editor').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_extractions').pluck().get(),0);
  writeFileSync(f.sourcePath,f.original);await save();const writes=calls.slice(start).filter(call=>call.method==='saveReviewExtraction');assert.deepEqual(writes[1].input,writes[0].input);
});

test('pending actual extraction keeps current fields and source refs visible but disables selection, refresh and close',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewExtraction';
  await tid('artifact-review-extraction-save').click();await begun;assert.equal(await tid('artifact-review-extraction-form').count(),1);
  assert.equal(await page.getByLabel('Group mean difference数值',{exact:true}).isDisabled(),true);assert.equal(await tid('artifact-review-extraction-select').first().isDisabled(),true);
  assert.equal(await tid('artifact-review-extractions-refresh').isDisabled(),true);assert.equal(await tid('artifact-review-fulltext-refresh').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);f.deferMethod=null;f.release();await tid('artifact-review-extraction-current').waitFor();
});

test('superseded actual Evidence is readable as history but cannot be added to a new field',async()=>{
  const f=await fixture();f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);await mount(f);await select();
  await page.getByLabel('研究设计原文证据',{exact:true}).selectOption(f.evidence.id);
  await page.getByText('来源失效或不对应所选全文',{exact:false}).waitFor();
  assert.equal(await tid('artifact-review-extraction-evidence-add').isDisabled(),true);
  assert.equal(f.extractions.list(f.get).length,0);
});

test('failed extraction reread retains the actual receipt and blocks revision until successful reread',async()=>{
  const f=await fixture();await f.extractions.save(f.extract(),actor);await mount(f);await select();
  f.failMethod='listReviewExtractions';f.readFailure={code:'synthetic_transport_error',message:'Synthetic extraction transport failure'};
  await tid('artifact-review-extractions-refresh').click();await page.getByRole('alert').filter({hasText:'transport failure'}).waitFor();
  await page.getByText('以下为上次成功读取的提取回执。',{exact:true}).waitFor();
  assert.equal(await tid('artifact-review-extraction-current').count(),1);assert.equal(await tid('artifact-review-extraction-revise').count(),0);
  f.readFailure=null;await tid('artifact-review-extractions-refresh').click();await tid('artifact-review-extraction-revise').waitFor();
});

test('required fields remain present and optional unitless fields require explicit selection and expose no numeric value',async()=>{
  const body=reviewProtocolBodyFixture();body.extractionFields.push({id:'description',label:'Synthetic optional description',unit:null,required:false});
  const f=await fixture({protocolBody:body});await mount(f);await select();await fill(f);
  assert.equal(await page.getByLabel('Synthetic optional description值类型',{exact:true}).count(),0);
  await page.getByLabel('记录可选字段 Synthetic optional description',{exact:true}).check();
  assert.equal(await page.getByLabel('Synthetic optional description值类型',{exact:true}).locator('option[value="number"]').count(),0);
  assert.equal(await tid('artifact-review-extraction-save').isDisabled(),true);
  await page.getByLabel('Synthetic optional description值类型',{exact:true}).selectOption('missing');
  await page.getByLabel('Synthetic optional description原因',{exact:true}).fill('Synthetic human could not find this description in the source');
  await evidence(f,'Synthetic optional description');await save();
  const fields=f.extractions.list(f.get)[0].snapshot.request.fields;
  assert.equal(fields.length,2);assert.equal(fields[1].unit,null);assert.equal(fields[1].value.kind,'missing');
});

test('late prior-project extraction list and Evidence inspection cannot appear or authorize fields in the next project',async()=>{
  for(const method of ['listReviewExtractions','inspectEvidence']) {
    const f=await fixture(),next=await fixture();await f.extractions.save(f.extract(),actor);await mount(f);
    const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod=method;
    if(method==='listReviewExtractions')await tid('artifact-review-extractions-refresh').click();
    else {await select();await tid('artifact-review-extraction-revise').click();await page.getByLabel('研究设计原文证据',{exact:true}).selectOption(f.evidence.id);}
    await begun;await mount(next);await select();f.deferMethod=null;f.release();
    await page.waitForFunction(()=>document.querySelector('[aria-label="研究设计原文证据"]')?.value==='');
    assert.equal(await tid('artifact-review-extraction-current').count(),0);assert.equal(await tid('artifact-review-extraction-evidence-add').count(),0);
    assert.equal(await tid('artifact-review-extraction-save').isDisabled(),true);
  }
});

test('archived superseded extraction retains saved values and exact Evidence/locator refs at dark narrow size without a mutable form',async()=>{
  const f=await fixture();await f.extractions.save(f.extract(),actor);f.reparse();f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');const before=f.changes();
  await mount(f,false);await select();await tid('artifact-review-extraction-current').waitFor();assert.match(await tid('artifact-review-extraction-current').innerText(),/提取来源引用已变化/u);
  assert.equal(await tid('artifact-review-extraction-form').count(),0);assert.equal(await tid('artifact-review-extraction-revise').count(),0);assert.equal(f.changes(),before);
  await tid('artifact-review-extraction-current').locator('details').locator('summary').click();await tid('artifact-review-extraction-current').locator('pre').waitFor({state:'visible'});
  const snapshot=JSON.parse(await tid('artifact-review-extraction-current').locator('pre').innerText());assert.equal(snapshot.sources[0].digest,f.reference.expectedHash);
  assert.equal(snapshot.sources[0].sourceLocator.parseId,f.selection.parseId);await audit('extraction-archived-dark-narrow');
});
