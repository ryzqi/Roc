import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {extractionDigest} from '../unit/fixtures/research-review-extraction.mjs';
import {reviewSearchPayloadFixture} from '../unit/fixtures/research-review-search.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture,fullTextExclude} from '../unit/fixtures/research-review-fulltext-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c6-ui');
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
  getReviewExtractionHistory:'roc:research:review-extraction-history',listEvidence:'roc:research:evidence-list',inspectEvidence:'roc:research:evidence-inspect',getReviewStudies:'roc:research:review-studies-get',saveReviewStudies:'roc:research:review-studies-save',getReviewStudiesHistory:'roc:research:review-studies-history',getReviewReport:'roc:research:review-report-get'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-report-ui-')); mkdirSync(artifacts, {recursive: true});
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
async function fixture({included=[0],excluded=[2],...options}={}) {
  const f=await createReviewFullTextScreeningFixture(api,options);
  fixtures.push(f);f.includedIndices=included;
  for(const item of f.title.freeze.authority.items.filter(item=>item.status==='included')) {
    const index=f.corpus.snapshot.hits.findIndex(hit=>hit.id===item.hit.id);
    if(included.includes(index)||excluded.includes(index)) {
      await f.bind(index);
      for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(index,reviewer,`source-${index}-${reviewer}`,excluded.includes(index)?fullTextExclude:undefined),actor);
    }else await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  }
  f.fullFrozen=await f.fullFreezing.freeze({...f.fullPhase,requestId:'freeze-for-ui-groups',
    expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,reviewNote:'Synthetic human confirms fulltext sources for explicit report memberships'},actor);
  f.extractions=new api.ResearchReviewExtractionRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,f.service,()=>f.time);
  f.studies=new api.ResearchReviewStudiesRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,()=>f.time);
  f.evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:`document:${f.selection.parseId}:chunk:0`});
  f.reference={id:f.evidence.id,expectedHash:extractionDigest(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id))};
  f.qualityPlans=new api.ResearchReviewQualityPlanRepository(f.db,f.repository,f.extractions,f.fullFreezing,()=>f.time);
  f.assessments=new api.ResearchReviewQualityAssessmentRepository(f.db,f.repository,f.qualityPlans,f.extractions,f.fullFreezing,()=>f.time);
  f.reports=new api.ResearchReviewReportService(f.db,f.repository,f.corpora,f.reviews,f.dedup,f.freezing,f.fullFreezing,f.studies,f.extractions,f.qualityPlans,f.assessments);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities,...api.researchReviewExtractionCapabilities,...api.researchEvidenceCapabilities,...api.researchReviewStudiesCapabilities,api.researchReviewReportCapability])registry.declare('research',descriptor);
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
  api.registerResearchReviewStudiesCapabilities(context,f.studies);
  api.registerResearchReviewReportCapability(context,f.reports);
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
  await tid('artifact-review-report-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-report').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-report-refresh"]').disabled);
}




const actor={kind:'user',id:'synthetic-report-human'};
function extraction(f,requestId='extract-report') {
  const index=f.includedIndices[0],binding=f.bound.get(index);
  return {...f.get,hitId:f.corpus.snapshot.hits[index].id,requestId,expectedFullFreezeHash:f.fullFrozen.freezeHash,
    bindingId:binding.snapshot.id,expectedBindingHash:binding.snapshotHash,reviewerId:f.reviewerIds[0],reviewNote:'Synthetic human source extraction',
    studyDesign:{value:{kind:'text',text:f.protocol.version.body.qualityAssessment[0].studyDesign},evidence:[f.reference]},
    fields:[{fieldId:f.protocol.version.body.extractionFields[0].id,unit:f.protocol.version.body.extractionFields[0].unit,
      value:{kind:'missing',reason:'Synthetic original does not report the chosen measure'},evidence:[f.reference]}],
    parentExtractionId:null,expectedParentHash:null,revisionReason:null};
}
function groups(f) {
  return {...f.get,requestId:'group-for-report',expectedFullFreezeHash:f.fullFrozen.freezeHash,
    groups:f.includedIndices.length===0?[]:[{studyId:'study-one',label:'Synthetic study one',reason:'Synthetic explicit investigation identity',
      reports:f.includedIndices.map(index=>({hitId:f.corpus.snapshot.hits[index].id,expectedBindingHash:f.bound.get(index).snapshotHash,
        sourceNote:'Synthetic human explicitly associates original report with study'}))}],
    reviewerId:f.reviewerIds[0],reviewNote:'Synthetic human confirms report memberships',parentGroupingId:null,expectedParentHash:null,revisionReason:null};
}
async function quality(f) {
  f.extraction=await f.extractions.save(extraction(f),actor);
  f.quality=await f.qualityPlans.create({...f.get,hitId:f.extraction.snapshot.request.hitId,requestId:'quality-for-report',
    extractionId:f.extraction.snapshot.id,expectedExtractionHash:f.extraction.snapshotHash,framework:f.protocol.version.body.qualityAssessment[0],
    definition:{origin:'user_declared',documentationNote:'Synthetic documented domain definition',domains:[{id:'domain',label:'Synthetic domain',
      question:'Synthetic explicit source question',judgements:['adequate','concerns']}],overallJudgements:['reviewed','concerns']},
    reviewerId:f.reviewerIds[0],reviewNote:'Synthetic human reviews declared framework'},actor);
  f.assessment=await f.assessments.save({...f.get,extractionId:f.extraction.snapshot.id,qualityPlanId:f.quality.snapshot.id,requestId:'assess-for-report',
    expectedPlanHash:f.quality.snapshotHash,expectedExtractionHash:f.extraction.snapshotHash,
    domains:[{domainId:'domain',value:{kind:'judged',judgement:'concerns',reason:'Synthetic source domain concerns'},evidence:[f.reference]}],
    overall:{value:{kind:'unjudgeable',reason:'Synthetic overall quality cannot be judged'},evidence:[f.reference]},reviewerId:f.reviewerIds[0],
    reviewNote:'Synthetic human explicit assessment',parentAssessmentId:null,expectedParentHash:null,revisionReason:null},actor);
}
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

test('actual report displays conserved human counts and unreported study number with no scientific writes or new requests',async()=>{
  const f=await fixture(),report=f.reports.get(f.get),before=f.changes(),requests=f.calls.length;await mount(f);await tid('artifact-review-report-body').waitFor();
  const counts=await tid('artifact-review-report-counts').innerText();
  assert.match(counts,/识别记录 8 = 移除重复 0 \+ 筛选记录 8/u);
  assert.match(counts,/寻求全文报告 7 = 未取得报告 5 \+ 已资格评估报告 2/u);
  assert.match(counts,/已资格评估报告 2 = 全文排除 1 \+ 纳入报告 1/u);
  assert.match(counts,/人工声明研究 尚未审核，未报告/u);
  assert.match(await tid('artifact-review-report-body').innerText(),new RegExp(report.bodyHash));
  assert.equal(f.changes(),before);assert.equal(f.calls.length,requests);
  await tid('artifact-review-report-counts').scrollIntoViewIfNeeded();await audit('report-default');
  await tid('artifact-review-report-refresh').hover();await audit('report-hover');
});

test('explicit grouping produces a real reviewed study count and zero included set remains unreported until human empty grouping',async()=>{
  for(const included of [[0],[]]) {
    const f=await fixture({included}),before=f.reports.get(f.get);assert.equal(before.body.counts.includedStudies,null);
    await f.studies.save(groups(f),actor);await mount(f);await tid('artifact-review-report-body').waitFor();
    assert.match(await tid('artifact-review-report-counts').innerText(),new RegExp(`人工声明研究 ${included.length}`));
  }
});

test('query appendix preserves exact parameters/dates/source receipts and raw repeated records with unknown metadata',async()=>{
  const f=await fixture();await mount(f);const report=f.reports.get(f.get),queries=tid('artifact-review-report-queries');
  await queries.locator('summary').first().click();assert.equal(await queries.locator('li').count(),2);
  await queries.locator('li').first().locator('summary').click();await queries.locator('li').first().locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await queries.locator('li').first().locator('pre').innerText()),report.body.queries[0]);
  const records=tid('artifact-review-report-records');await records.locator('summary').first().click();assert.equal(await records.locator('li').count(),8);
  await records.locator('li').first().locator('summary').click();await records.locator('li').first().locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await records.locator('li').first().locator('pre').innerText()),report.body.records[0]);
  assert.equal(report.body.records[0].record.record.publishedYear,null);assert.equal(new Set(report.body.records.map(row=>row.record.record.id)).size,4);
  await audit('report-queries-records-expanded');
});

test('title and fulltext exclusion rows retain primary criteria and exact human source refs while unreceived reports stay separate',async()=>{
  const f=await fixture();await mount(f);const details=tid('artifact-review-report-exclusions'),rows=f.reports.get(f.get).body.exclusions;
  await details.locator('summary').first().click();assert.equal(await details.locator('li').count(),2);
  await details.locator('li').first().waitFor({state:'visible'});
  assert.match(await details.innerText(),/标题摘要排除/u);assert.match(await details.innerText(),/全文资格排除/u);
  for(const [index,row] of rows.entries()) {
    const item=details.locator('li').nth(index);await item.locator('summary').click();await item.locator('pre').waitFor({state:'visible'});
    assert.deepEqual(JSON.parse(await item.locator('pre').innerText()),row);
  }
  assert.equal(rows[0].binding,null);assert.equal(rows[1].binding.expectedHash,f.bound.get(2).snapshotHash);
});

test('evidence table retains missing unit-linked extraction and exact human framework/unjudgeable quality result',async()=>{
  const f=await fixture();await quality(f);await mount(f);const details=tid('artifact-review-report-evidence');
  await details.locator('summary').first().click();await tid('artifact-review-report-evidence-row').waitFor();
  assert.match(await details.innerText(),/单位 mg\/L/u);assert.match(await details.innerText(),/原文未报告：Synthetic original/u);
  assert.match(await details.innerText(),/总体 无法判断/u);
  const row=tid('artifact-review-report-evidence-row');await row.getByText('字段及原文定位的完整提取',{exact:true}).click();
  await row.locator('pre').first().waitFor({state:'visible'});assert.deepEqual(JSON.parse(await row.locator('pre').first().innerText()),
    {snapshot:f.extraction.snapshot,snapshotHash:f.extraction.snapshotHash});await audit('report-evidence-expanded');
});

test('larger original corpus paginates exact raw hits and partial query coverage remains visible',async()=>{
  for(const options of [
    {maxPages:3,fetch:async url=>Response.json(reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')),12))},
    {maxPages:1}
  ]) {
    const f=await fixture(options);await mount(f);await tid('artifact-review-report-body').waitFor();
    const report=f.reports.get(f.get),records=tid('artifact-review-report-records');
    if(options.maxPages===1) {await page.getByText('已声明查询仍有检索覆盖缺口',{exact:true}).waitFor();assert.equal(report.body.searchCoverageComplete,false);continue;}
    await records.locator('summary').first().click();assert.equal(await records.locator('li').count(),10);
    await page.getByRole('button',{name:'下一页原始记录',exact:true}).click();await records.locator('li').first().locator('summary').click();
    await records.locator('li').first().locator('pre').waitFor({state:'visible'});
    assert.deepEqual(JSON.parse(await records.locator('li').first().locator('pre').innerText()),report.body.records[10]);
  }
});

test('failed marked receipt reread retains labeled original report instead of inventing empty counts and late project result is ignored',async()=>{
  const f=await fixture();await quality(f);await mount(f);await tid('artifact-review-report-body').waitFor();const original=f.reports.get(f.get);
  f.db.prepare('DELETE FROM research_review_quality_assessments').run();await tid('artifact-review-report-refresh').click();
  await tid('artifact-review-report').getByRole('alert').filter({hasText:'校验失败'}).waitFor();
  await page.getByText('以下为上次成功读取的报告回执。',{exact:true}).waitFor();assert.match(await tid('artifact-review-report-body').innerText(),new RegExp(original.bodyHash));
  const prior=await fixture(),next=await fixture();await prior.studies.save(groups(prior),actor);await mount(prior);
  const begun=new Promise(resolve=>{prior.started=resolve;});prior.deferMethod='getReviewReport';await tid('artifact-review-report-refresh').click();await begun;
  await mount(next);prior.deferMethod=null;prior.release();await tid('artifact-review-report-body').waitFor();
  assert.match(await tid('artifact-review-report-counts').innerText(),/人工声明研究 尚未审核，未报告/u);
  assert.match(await tid('artifact-review-report-body').innerText(),new RegExp(next.reports.get(next.get).bodyHash));
});

test('archived source reparse preserves exact frozen report body/hash/counts while live source flags change at dark narrow size',async()=>{
  const f=await fixture();await quality(f);await f.studies.save(groups(f),actor);const report=f.reports.get(f.get);f.reparse();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await tid('artifact-review-report-body').waitFor();
  assert.match(await tid('artifact-review-report-body').innerText(),new RegExp(report.bodyHash));
  await page.getByText('全文来源引用已变化',{exact:false}).waitFor();assert.deepEqual(f.reports.get(f.get).body,report.body);
  assert.equal(f.changes(),before);await tid('artifact-review-report-evidence').locator('summary').first().click();
  await page.getByText('提取来源引用已变化',{exact:true}).waitFor();await audit('report-archived-dark-narrow');
});
