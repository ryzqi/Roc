import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewSearchPayloadFixture} from '../unit/fixtures/research-review-search.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture} from '../unit/fixtures/research-review-fulltext-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c3a-ui');
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
  getDocument:'roc:research:document-get',getDocumentContent:'roc:research:document-content'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-fulltext-binding-ui-')); mkdirSync(artifacts, {recursive: true});
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
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());
  });
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (method === f.failMethod && f.readFailure) return {ok:false,error:f.readFailure};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
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
  const f=await createReviewFullTextScreeningFixture(api,options);
  fixtures.push(f);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities])registry.declare('research',descriptor);
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
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
  return f;
}
async function mount(f, writable = true) {
  active = f;
  await page.evaluate(({request, writable}) => window.mount(request, writable),
    {request: {projectId: f.project.id, versionId: f.protocol.version.id}, writable});
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
  await tid('artifact-review-fulltext-counts').waitFor();
}


const actor={kind:'user',id:'synthetic-source-declarer'};
async function select(index=0) {
  await tid('artifact-review-fulltext-select').nth(index).focus();await page.keyboard.press('Enter');
  await tid('artifact-review-fulltext-binding').getByText('摘要未提供',{exact:true}).waitFor();
}
async function retrieved(f,mode='current',note='Synthetic human explicitly relates the selected original document to this exact search hit') {
  const form=tid('artifact-review-fulltext-binding-form');await form.getByLabel('全文获取状态',{exact:true}).selectOption('retrieved');
  await form.getByLabel('全文对应已有文献',{exact:true}).selectOption(f.document.libraryItemId);
  await form.getByLabel('全文原文件',{exact:true}).selectOption(f.document.id);
  await form.getByLabel('全文绑定版本',{exact:true}).selectOption(mode);
  await form.getByLabel('原文件与命中关联说明',{exact:true}).fill(note);
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-fulltext-binding-save"]').disabled);
}
async function notRetrieved(note='Synthetic human declares the original full text could not be obtained') {
  const form=tid('artifact-review-fulltext-binding-form');await form.getByLabel('全文获取状态',{exact:true}).selectOption('not_retrieved');
  await form.getByLabel('未获取全文原因',{exact:true}).fill(note);
}
async function save() {
  await tid('artifact-review-fulltext-binding-save').click();await tid('artifact-review-fulltext-binding-current').waitFor();
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





test('actual PDF and current parse bind to the exact included original hit through existing project library without another import',async()=>{
  const f=await fixture();await mount(f);assert.equal(await tid('artifact-review-fulltext-select').count(),7);
  await select();await retrieved(f);await audit('fulltext-source-default');
  await tid('artifact-review-fulltext-binding-save').hover();await audit('fulltext-source-hover');await save();
  const binding=f.fulltexts.list(f.get)[0];assert.deepEqual(binding.snapshot.request.outcome.selection,f.selection);
  assert.equal(binding.snapshot.request.hitId,f.corpus.snapshot.hits[0].id);assert.equal(binding.snapshot.request.expectedTitleFreezeHash,f.title.freezeHash);
  assert.equal(binding.snapshot.source.parse.id,f.selection.parseId);assert.equal(binding.snapshot.source.parse.hash,f.selection.parseHash);
  assert.equal(binding.snapshot.actor.id,`window:${windowId}`);assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),1);
  const phase=f.fullFreezing.getPhase(f.fullPhase);assert.equal(phase.counts.pending,1);assert.equal(phase.counts.included,0);
});

test('explicit not-retrieved reason remains separate from eligibility and exact-parent retrieval revision retains immutable source history',async()=>{
  const f=await fixture();await mount(f);await select();await notRetrieved();await save();const first=f.fulltexts.list(f.get)[0];
  assert.equal(first.snapshot.source,null);assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.not_retrieved,1);
  assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.excluded,0);
  await tid('artifact-review-fulltext-binding-revise').click();await retrieved(f,'current','Explicit later synthetic full text was obtained. '.repeat(100));
  await page.getByLabel('全文绑定修订原因',{exact:true}).fill('Synthetic newly obtained full text now explicitly linked');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-fulltext-binding-current"]')?.textContent.includes('版本 2'));
  const history=f.fulltexts.history({...f.get,hitId:f.corpus.snapshot.hits[0].id});assert.equal(history.length,2);
  assert.deepEqual(history[0],{...first,isLatest:false});assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);
  await tid('artifact-review-fulltext-binding-history').locator('summary').click();await tid('artifact-review-fulltext-binding-history').locator('ul').waitFor({state:'visible'});
  await audit('fulltext-expanded-source-history');
});

test('explicit original-file-only selection captures real bytes without inventing a parse or coordinates',async()=>{
  const f=await fixture();await mount(f);await select();await retrieved(f,'original');await save();const binding=f.fulltexts.list(f.get)[0];
  assert.deepEqual(binding.snapshot.request.outcome.selection,{documentId:f.document.id,sourceHash:f.document.sourceHash,parseId:null,parseHash:null});
  assert.equal(binding.snapshot.source.parse,null);assert.equal(binding.snapshot.source.size,f.original.length);
});

test('lost actual source-binding commit reply replays the exact request without duplicate binding versions',async()=>{
  const f=await fixture();await mount(f);await select();await retrieved(f);const start=calls.length;f.loseReply='saveReviewFullTextBinding';
  await tid('artifact-review-fulltext-binding-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewFullTextBinding');assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),1);
});

test('actual reparse after selection refuses stale parse binding without writes and explicit new source selection uses the real current version',async()=>{
  const f=await fixture();await mount(f);await select();await retrieved(f);f.reparse();const before=f.changes();
  await tid('artifact-review-fulltext-binding-save').click();await tid('artifact-review-fulltext-binding').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
  await tid('artifact-review-fulltext-binding-form').getByRole('button',{name:'查找文献',exact:true}).click();
  await retrieved(f);await save();assert.equal(f.fulltexts.list(f.get)[0].snapshot.source.parse.id,'fulltext-reparse');
});

test('changed actual original file bytes refuse an original-file binding and restoration permits the same failed request identity',async()=>{
  const f=await fixture();await mount(f);await select();await retrieved(f,'original');
  const modified=Buffer.from(f.original);modified[0]^=1;writeFileSync(f.sourcePath,modified);const before=f.changes(),start=calls.length;
  await tid('artifact-review-fulltext-binding-save').click();await tid('artifact-review-fulltext-binding').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
  writeFileSync(f.sourcePath,f.original);await save();const writes=calls.slice(start).filter(call=>call.method==='saveReviewFullTextBinding');
  assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
});

test('held actual source commit keeps its form and blocks source fields, record selection, refresh and drawer closure',async()=>{
  const f=await fixture();await mount(f);await select();await retrieved(f);
  const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewFullTextBinding';await tid('artifact-review-fulltext-binding-save').click();await begun;
  assert.equal(await tid('artifact-review-fulltext-binding-form').count(),1);assert.equal(await page.getByLabel('全文原文件',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-fulltext-select').first().isDisabled(),true);assert.equal(await tid('artifact-review-fulltext-refresh').isDisabled(),true);
  assert.equal(await tid('artifact-review-title-refresh').isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-fulltext-binding-current').waitFor();
});

test('real unavailable project source list is an explicit error rather than an empty successful choice and cannot admit a binding',async()=>{
  const f=await fixture();await mount(f);await select();f.failMethod='listLibrary';f.readFailure={code:'synthetic_list_unavailable',message:'Synthetic actual source list unavailable'};
  await page.getByLabel('全文获取状态',{exact:true}).selectOption('retrieved');await page.getByRole('alert').filter({hasText:'source list unavailable'}).waitFor();
  assert.equal(await tid('artifact-review-fulltext-binding-save').isDisabled(),true);assert.equal(await page.getByLabel('全文对应已有文献',{exact:true}).isDisabled(),true);
  f.failMethod=null;f.readFailure=null;await tid('artifact-review-fulltext-binding-form').getByRole('button',{name:'查找文献',exact:true}).click();
  await retrieved(f);await save();
});

test('archived history retains exact superseded parse and original relation note at narrow dark size without mutable source controls',async()=>{
  const f=await fixture();await f.fulltexts.save(f.retrieved(),actor);f.reparse();f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select();await tid('artifact-review-fulltext-binding-current').waitFor();
  assert.match(await tid('artifact-review-fulltext-binding-current').innerText(),/所选来源已变化/u);assert.match(await tid('artifact-review-fulltext-binding-current').innerText(),/fulltext-parse/u);
  assert.equal(await tid('artifact-review-fulltext-binding-form').count(),0);assert.equal(await tid('artifact-review-fulltext-binding-revise').count(),0);assert.equal(f.changes(),before);
  await audit('fulltext-archived-dark-narrow');
});

test('actual complete not-retrieved fulltext freeze remains readonly and does not reinterpret missing reports as exclusions',async()=>{
  const f=await fixture();for(const [index] of f.corpus.snapshot.hits.entries())if(index!==1)await f.fulltexts.save(f.notRetrieved(index,`not-obtained-${index}`),actor);
  const phase=f.fullFreezing.getPhase(f.fullPhase);await f.fullFreezing.freeze({...f.fullPhase,requestId:'explicit-full-freeze',expectedReviewHash:phase.reviewHash,
    reviewNote:'Synthetic complete reviewed missing-fulltext set'},actor);
  await mount(f);await select();await tid('artifact-review-fulltext-binding-current').waitFor();
  assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.not_retrieved,7);assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.excluded,0);
  assert.equal(await tid('artifact-review-fulltext-frozen').count(),1);assert.equal(await tid('artifact-review-fulltext-binding-form').count(),0);
  assert.equal(await tid('artifact-review-fulltext-binding-revise').count(),0);
});


test('late actual preview from a prior project cannot expose its document or enable a source write in the current corpus',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const a=await fixture(),b=await fixture();await mount(a);await select();
  const begun=new Promise(resolve=>{a.started=resolve;});a.deferMethod='previewDocument';
  const form=tid('artifact-review-fulltext-binding-form');await form.getByLabel('全文获取状态',{exact:true}).selectOption('retrieved');
  await form.getByLabel('全文对应已有文献',{exact:true}).selectOption(a.document.libraryItemId);
  await form.getByLabel('全文原文件',{exact:true}).selectOption(a.document.id);await form.getByLabel('全文绑定版本',{exact:true}).selectOption('current');await begun;
  await mount(b);await select();await notRetrieved('Synthetic current project lacks obtained fulltext');await save();
  const current=await tid('artifact-review-fulltext-binding-current').innerText();a.deferMethod=null;a.release();
  assert.equal(await tid('artifact-review-fulltext').count(),1);assert.equal(await tid('artifact-review-fulltext-binding-current').innerText(),current);
  assert.equal(a.fulltexts.list(a.get).length,0);assert.equal(b.fulltexts.list(b.get).length,1);
  assert.equal(b.fulltexts.list(b.get)[0].snapshot.request.corpusId,b.corpus.snapshot.id);
});
