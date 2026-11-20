import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from '@playwright/test';
import Database from 'better-sqlite3';
import {applicationIdentity} from './database/verify-research-migration-startup.mjs';
import {fingerprintTable} from './database/research-migration-lib.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const root = resolve(process.argv[2]), output = resolve(process.argv[3]);
mkdirSync(output, {recursive:false});
const receiptPath = join(root,'project-receipt.json'), receipt = JSON.parse(readFileSync(receiptPath));
assert.equal(hash(receipt.sourceRun.path), receipt.sourceRun.sha256);
const seed = JSON.parse(readFileSync(receipt.sourceRun.path)), buildHash = applicationIdentity();
const protectedTables = ['research_documents','research_document_parses','research_evidence',
  'research_evidence_source_metadata','research_evidence_source_locators','research_wiki_revisions',
  'research_scientific_chunks','research_scientific_embeddings'];
function snapshot() {
  const db = new Database(receipt.database,{readonly:true});
  try {return Object.fromEntries(protectedTables.map(t=>[t,fingerprintTable(db,t)]));} finally {db.close();}
}
const before = snapshot(), rows = [], errors = [], previewRequests = [];
const beforePath=join(output,'before.db'), beforeDb=new Database(receipt.database,{readonly:true});
try {await beforeDb.backup(beforePath);} finally {beforeDb.close();}
const baseline={path:beforePath,sha256:hash(beforePath)};
const event = (kind,detail) => appendFileSync(join(output,'events.jsonl'),JSON.stringify({kind,detail})+'\n');
const env = {...process.env,ROC_DATA_ROOT:receipt.dataRoot};
for (const key of ['ROC_SMOKE','ROC_SMOKE_API_KEY','ELECTRON_RENDERER_URL','ELECTRON_RUN_AS_NODE']) delete env[key];
let app, page;
try {
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'),
    args:[resolve('dist/main/index.js'),'--user-data-dir='+join(root,'chromium')],env,timeout:60000});
  app.process().stderr.on('data',data=>event('stderr',data.toString()));
  page = await app.firstWindow();
  page.on('pageerror',error=>{errors.push(error.message);event('pageerror',error.message);});
  page.on('request',request=>{if(request.url().startsWith('roc-preview://research/')) previewRequests.push({url:request.url(),method:request.method()});});
  await page.setViewportSize({width:1000,height:900});
  await page.getByTestId('portal').waitFor({timeout:60000});
  // The copied fixture config intentionally points at a reserved .invalid host.
  // Supply only its public dummy credential so real transport failure, rather
  // than missing configuration, exercises the production fallback path.
  const ciphertext = await app.evaluate(async ({safeStorage}) => {
    if(!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('test_encryption_unavailable');
    return (await safeStorage.encryptStringAsync('fixture-key')).toString('base64');
  });
  const core=new Database(join(receipt.dataRoot,'plugin-data/data/core.db'));
  try { core.prepare('INSERT OR REPLACE INTO plugin_secrets (plugin_id,key,ciphertext_base64,updated_at) VALUES (?,?,?,?)')
    .run('@roc/plugin-research','fixture-secret',ciphertext,new Date().toISOString()); } finally {core.close();}
  const call = async (method,input) => {
    const result = await page.evaluate(async ({method,input}) => input===undefined ? await window.roc.research[method]() : await window.roc.research[method](input),{method,input});
    assert.equal(result.ok,true,method+':'+JSON.stringify(result.error));return result.data;
  };
  const projects = await call('listProjects');
  assert.equal(projects.find(p=>p.id===receipt.projectId)?.workspacePath,receipt.workspace);
  await page.getByTestId('portal-card-open-'+receipt.projectId).click();
  const evidence = await call('listEvidence',{projectId:receipt.projectId});
  assert.equal(evidence.length,45);
  assert.deepEqual([...evidence].sort((a,b)=>a.id.localeCompare(b.id)),seed.observations.map(r=>r.evidence).sort((a,b)=>a.id.localeCompare(b.id)));
  await page.evaluate(projectId=>{
    const url=new URL(location.href);url.searchParams.set('page','research');url.searchParams.set('project',projectId);url.searchParams.set('view','literature');
    history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));
  },receipt.projectId);
  await page.getByTestId('literature-hub').waitFor();
  if(await page.getByTestId('sidebar-drawer').isVisible()) await page.getByTestId('sidebar-drawer-close').click();
  const picker=page.getByRole('combobox',{name:'选择当前文献',exact:true});await picker.waitFor();
  for(const item of seed.observations) {
    const document=await call('getDocument',{documentId:item.documentId});
    assert.equal(document.sourceHash,item.sourceHash);assert.equal(document.currentParseId,item.parseId);
    const request={projectId:receipt.projectId,documentId:item.documentId,parseId:item.parseId,
      sourceHash:item.sourceHash,parseHash:item.paperIR.identity.parseHash};
    const content=await call('getDocumentContent',request);assert.equal(content.run.id,item.parseId);
    const preview=await call('previewDocument',request);
    const bytes=await page.evaluate(async url=>{
      const response=await fetch(url);if(!response.ok) throw new Error('PDF fetch '+response.status);
      const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
      await fetch(url,{method:'HEAD'});
      return {size:bytes.byteLength,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
    },preview.sourceUrl);
    assert.equal(bytes.sha256,item.sourceHash);assert.equal(bytes.size,document.size);
    const revision=await call('wikiRevision',{projectId:receipt.projectId,pageId:item.pageId,revision:item.revision.revision});
    assert.deepEqual(revision,item.revision);
    const legacy=await call('searchKnowledge',{projectId:receipt.projectId,documentId:'document:'+item.parseId,query:item.query,embeddingConfigId:null,limit:10,candidateLimit:50,rerank:'none'});
    assert.ok(legacy.hits.length,'legacy empty:'+item.paperId);
    assert.ok(['network','provider_unavailable'].includes(legacy.ranking.degradation));
    const search={projectId:receipt.projectId,documentIds:[item.documentId],query:item.query,embeddingConfigId:null,limit:10,candidateLimit:50,rerank:'none'};
    const scientific=await call('searchScientificKnowledge',search);
    assert.ok(scientific.hits.length);assert.deepEqual(scientific.snapshot.generations.map(g=>g.generationId),[item.b]);
    const scope={projectId:receipt.projectId,documentId:item.documentId,storageProjectId:null};
    assert.equal((await call('listScientificGenerations',scope)).activeGeneration,item.b);
    assert.equal((await call('activateScientificGeneration',{...scope,generationId:item.a,expectedActiveId:item.b})).activeGeneration,item.a);
    const rolledBack=await call('searchScientificKnowledge',search);
    assert.deepEqual(rolledBack.snapshot.generations.map(g=>g.generationId),[item.a]);assert.ok(rolledBack.hits.length);
    assert.equal((await call('activateScientificGeneration',{...scope,generationId:item.b,expectedActiveId:item.a})).activeGeneration,item.b);
    await picker.selectOption(document.libraryItemId);
    await page.getByTestId('paper-reader').waitFor();
    if(await page.getByTestId('reader-compare-pdf').getAttribute('aria-pressed')!=='true') await page.getByTestId('reader-compare-pdf').click();
    await page.waitForFunction(()=>{
      const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
      return canvas?.width>0 && canvas.height>0 && canvas.parentElement.style.visibility==='visible';
    },null,{timeout:30000});
    const raster=await page.getByTestId('reader-pdf-canvas').evaluate(canvas=>({width:canvas.width,height:canvas.height,label:canvas.getAttribute('aria-label')}));
    const screenshot=join(output,item.paperId+'.png');await page.screenshot({path:screenshot});
    rows.push({paperId:item.paperId,documentId:item.documentId,parseId:item.parseId,bytes,pageCount:preview.pageCount,
      legacy,scientific,rolledBack,revisionHash:createHash('sha256').update(JSON.stringify(revision)).digest('hex'),raster,
      screenshot:{path:screenshot,sha256:hash(screenshot)}});
    event('paper',{paperId:item.paperId,count:rows.length});console.log(JSON.stringify({papers:rows.length,paperId:item.paperId}));
    await picker.selectOption('');await page.getByTestId('reader-pdf').waitFor({state:'detached'});
  }
  const multiple=await call('searchScientificKnowledge',{projectId:receipt.projectId,query:'method results',documentIds:[],limit:20,candidateLimit:100,rerank:'none'});
  assert.equal(multiple.snapshot.generations.length,45);assert.ok(multiple.hits.length);
  assert.deepEqual(await call('listEvidence',{projectId:receipt.projectId}),evidence);
  assert.deepEqual(errors,[]);
  await app.close();app=null;
  const after=snapshot();assert.deepEqual(after,before);assert.equal(applicationIdentity(),buildHash);
  for(const file of receipt.copies.filter(f=>f.target.startsWith(receipt.libraryRoot+'/')))assert.equal(hash(file.target),file.sha256);
  writeFileSync(join(output,'report.json'),JSON.stringify({version:1,status:'Verified passing',root,receipt:{path:receiptPath,sha256:hash(receiptPath)},
    buildHash,scriptHash:hash('scripts/verify-scientific-desktop.mjs'),rows,multiple,baseline,before,after,errors,previewRequests,
    quality:{recall:null,answerCorrectness:null,realProjectAcceptance:null},
    limitations:['Copied public45 engineering project; no genuine research history or semantic-quality acceptance.',
      'Real Electron/preload/PDF raster and source bytes; controlled saved vectors and dummy credential at reserved .invalid endpoint.',
      'One page raster per paper; all-page PDF text read was verified separately.']},null,2)+'\n',{flag:'wx'});
} catch(error) {
  if(page) await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,rows:rows.length,errors},null,2)+'\n');
  throw error;
} finally {await app?.close();}
