import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, plans, visuals, quality, structure;
before(async () => {
  [api, plans, visuals, quality, structure] = await Promise.all([loadResearchTestApi(),
    ...['knowledge-source-plan','pdf-caption-linker','pdf-quality-assessor','paper-structure'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform:'node'}))]);
});
after(() => api?.dispose());
const options = {tier:'compact', device:'cpu', pageRange:''};
const config = {id:'test', name:'test', baseUrl:'https://fixture.invalid', model:'model-one', dimensions:3, enabled:true};
const logger = {info() {}, warn() {}, error() {}};
async function pdf(path, text, visual = false) {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([600,800]);
  page.drawText('2 Method', {x:30,y:740,size:14,font});
  page.drawText(text, {x:30,y:700,size:10,font});
  if (visual) page.drawText('Figure 2: Original architecture.', {x:30,y:640,size:10,font});
  await writeFile(path, await document.save());
}
async function fixture(kind = 'pdf', enabled = true, visual = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'roc-scientific-project-')));
  const workspace = join(root,'workspace'), storage = join(root,'storage');
  await mkdir(workspace); await mkdir(storage);
  const f = createResearchFixture(api, 'figure', workspace);
  // These tests own scans/jobs explicitly. Native watcher callbacks would request
  // a second scan and correctly gate nextJob while a manual scan is returning.
  const {projectId,revision,...settings}=f.repository.indexing.settings(f.project.id);
  f.repository.indexing.saveSettings(projectId,revision,{...settings,watch:false});
  const source = join(workspace,kind === 'pdf' ? 'paper.pdf' : 'paper.md');
  const write = text => kind === 'pdf' ? pdf(source,text,visual) : writeFile(source,`# Method\n\n${text}`);
  await write('Original method learns exact sources.');
  if (enabled) f.repository.knowledge.saveEmbeddingConfig(config,'test-secret');
  let calls=0, parses=0, provider=async texts => texts.map(()=>[3,4,0]);
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
    {embed:async ({texts,signal}) => {calls++; return await provider(texts,signal);}},
    {secrets:{get:async ()=>'test-key'},logger});
  const indexer = new api.ResearchIndexService(f.repository,{
    identity:async ()=>'native-test-model', defaultParseOptions:()=>options,
    parseDocument:async input => {
      parses++;
      const parsed = await api.parseResearchDocument({...input,modelFiles:null,modelManifest:''});
      if (!visual) return parsed;
      const canvas = createCanvas(80,64);
      canvas.getContext('2d').fillRect(4,4,72,56);
      const png = await canvas.encode('png'); canvas.width=0; canvas.height=0;
      await mkdir(join(input.outputDir,'regions'),{recursive:true});
      await writeFile(join(input.outputDir,'regions','fixture-figure.png'),png);
      const blocks = visuals.attachPaperVisuals([...parsed.blocks,
        {id:'project-figure',kind:'figure',text:'',label:'figure',locator:'page 1 figure',
          imagePath:'regions/fixture-figure.png',locations:[{page:1,bbox:[30,100,110,164],coordinateOrigin:'TOPLEFT'}]},
        {id:'project-caption',kind:'paragraph',text:'Figure 2: Original architecture.',label:'paragraph',
          locator:'page 1 caption',imagePath:null,locations:[{page:1,bbox:[30,170,300,185],coordinateOrigin:'TOPLEFT'}]}
      ]);
      return {...parsed,blocks,structure:structure.buildPaperStructure(blocks),
        assets:[...parsed.assets,{path:'regions/fixture-figure.png',kind:'figure',page:1}],
        quality:quality.assessPdfQuality({pages:[{page:1,regions:[],coordinateFrame:{
          kind:'image',page:1,width:600,height:800,unit:'raster-pixel',coordinateOrigin:'TOPLEFT'}}],blocks})};
    }
  },embeddings,storage,logger);
  const job = async force => {
    f.repository.indexing.requestScan(f.project.id,force);
    await indexer.scan(f.project.id,new AbortController().signal);
    const queued=f.repository.indexing.nextJob();
    assert.ok(queued,`scan must produce a real repository job: ${JSON.stringify({
      scope:f.repository.indexing.scope(f.project.id),
      jobs:f.db.prepare('SELECT id,status,generation FROM research_index_jobs').all()
    })}`);
    return f.repository.indexing.beginJob(queued.id);
  };
  const process = async job => {
    await indexer.process(job,new AbortController().signal);
    await indexer.releaseProject(f.project.id);
  };
  return {...f,root,storage,source,write,embeddings,indexer,job,process,
    provider:value=>{provider=value;}, calls:()=>calls, parses:()=>parses,
    close:async ()=>{await indexer.shutdown(); await embeddings.shutdown(); await f.close(); await rm(root,{recursive:true,force:true});}};
}
function snapshot(f) {
  return {
    documents:f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all(),
    chunks:f.db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all(),
    vectors:f.db.prepare('SELECT * FROM research_knowledge_embeddings ORDER BY chunk_id,space_key').all(),
    keywords:f.db.prepare('SELECT rowid,content,title FROM research_knowledge_keywords ORDER BY rowid').all(),
    active:f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='active' ORDER BY id").all(),
    activeVectors:f.db.prepare(`SELECT e.* FROM research_scientific_embeddings e
      JOIN research_scientific_index_generations g ON g.id=e.generation_id WHERE g.status='active' ORDER BY e.chunk_id`).all()
  };
}
function assertOriginalQueryable(f, old) {
  assert.deepEqual(snapshot(f),old);
  assert.ok(f.db.prepare("SELECT count(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'Original'").pluck().get()>0);
  assert.ok(f.db.prepare(`SELECT count(*) FROM research_scientific_fts f
    JOIN research_scientific_index_generations g ON g.id=f.generation_id
    WHERE research_scientific_fts MATCH 'Original' AND g.status='active'`).pluck().get()>0);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
}
test('project figure context resolves the actual PNG copied into its immutable parser artifact', async () => {
  const f = await fixture('pdf',true,true);
  try {
    const {load}=await import('sqlite-vec');load(f.db);
    const {ScientificRetrievalRouter}=await importTypeScriptModule('src/main/plugins/research/scientific-retrieval-router.ts',
      {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']});
    const job=await f.job(false);await f.process(job);
    const publishedJob=f.repository.indexing.job(job.id);
    assert.equal(publishedJob.status,'ready',JSON.stringify(publishedJob));
    const router=new ScientificRetrievalRouter(f.repository,f.embeddings,{library:null,index:f.storage},
      new api.ScholarlyRelationsRepository(f.db,f.repository));
    const search=await router.search({projectId:f.project.id,query:'Figure 2',documentIds:[],
      embeddingConfigId:null,limit:20,candidateLimit:100});
    const candidateIds=search.candidates.filter(c=>c.object.kind==='figure').map(c=>c.id);
    assert.equal(candidateIds.length,1);
    const context=await router.readContext({search,candidateIds});
    const image=context.evidence[0].image;
    assert.equal(image.storage,'project');
    assert.ok(image.path.startsWith('artifacts/'));
    assert.ok(image.path.endsWith('/regions/fixture-figure.png'));
    assert.deepEqual([image.width,image.height],[80,64]);
    const {createHash}=await import('node:crypto');
    const bytes=await readFile(join(f.storage,image.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),image.sha256);
    const row=f.db.prepare('SELECT payload_json FROM research_index_files WHERE id=?').get(job.fileId);
    const swapped=JSON.parse(row.payload_json);
    swapped.artifactPath='artifacts/unrelated-parse';
    f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(JSON.stringify(swapped),job.fileId);
    await assert.rejects(router.readContext({search,candidateIds}),/source_changed/);
    f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(row.payload_json,job.fileId);
    await writeFile(join(f.storage,image.path),Buffer.from('changed'));
    await assert.rejects(router.readContext({search,candidateIds}),/context_image_invalid/);
  } finally {await f.close();}
});
test('a pending rescan gates queued jobs until the authoritative scan finishes',async()=>{
  const f=await fixture();
  try {
    f.repository.indexing.requestScan(f.project.id,false);
    await f.indexer.scan(f.project.id,new AbortController().signal);
    const queued=f.repository.indexing.nextJob();assert.ok(queued);
    f.repository.indexing.requestScan(f.project.id,false);
    assert.equal(f.repository.indexing.nextJob(),null);
    assert.equal(f.repository.indexing.job(queued.id).status,'queued');
    await f.indexer.scan(f.project.id,new AbortController().signal);
    assert.equal(f.repository.indexing.nextJob().id,queued.id);
  } finally {await f.close();}
});
test('published project PDF is searchable through the generation-bound router and rejects changed physical sources', async () => {
  const f=await fixture();
  try {
    const {load}=await import('sqlite-vec');load(f.db);
    const {ScientificRetrievalRouter}=await importTypeScriptModule('src/main/plugins/research/scientific-retrieval-router.ts',
      {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']});
    const a=await f.job(false);await f.process(a);
    assert.equal(f.repository.indexing.job(a.id).status,'ready');
    const router=new ScientificRetrievalRouter(f.repository,f.embeddings,{library:null,index:f.storage},
      new api.ScholarlyRelationsRepository(f.db,f.repository));
    const request={projectId:f.project.id,query:'Original method',documentIds:[],embeddingConfigId:null,limit:20,candidateLimit:100};
    const result=await router.search(request);
    assert.ok(result.hits.some(hit=>hit.content.includes('Original method')));
    assert.ok(result.candidates.some(hit=>hit.signals.some(signal=>signal.method==='dense')));
    assert.ok(result.snapshot.generations.every(g=>g.storageProjectId===f.project.id));
    await router.assertCurrent(result);
    const workspace=join(f.root,'foreign-workspace');await mkdir(workspace);
    const foreign=f.repository.createProject({title:'Other scope',description:'',workspacePath:workspace});
    assert.equal((await router.search({...request,projectId:foreign.id})).candidates.length,0);
    await f.write('Changed physical source is not valid evidence.');
    await assert.rejects(router.assertCurrent(result),/source_size|source_hash|source_changed/);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {await f.close();}
});
test('pure generic candidate plan preserves SQL IDs, UTF16 spans, metadata and serializer inputs', async () => {
  const f=await fixture('markdown',false);
  try {
    const content=Array.from({length:150},(_,i)=>`Exact 🧪 source paragraph ${i}.`).join('\n\n');
    const input={id:'plan',projectId:f.project.id,sourceType:'file',sourceId:'source',title:'标题'.repeat(300),
      content,chunks:[{content,locator:'lines 1-299',section:'2 Method'},{content:'',locator:'empty object'}],embeddingPolicy:'none'};
    const metadata={sourceHash:'a'.repeat(64),parseId:'parse'};
    const expected=plans.knowledgeSourceEmbeddingInputs(input,metadata), plan=plans.planKnowledgeSource(input,metadata);
    assert.ok(expected.length>1);
    f.repository.knowledge.upsertFromSource(input,metadata);
    assert.deepEqual(f.repository.knowledge.knowledgeChunks(input.id),expected);
    assert.deepEqual(f.db.prepare('SELECT id,chunk_index AS "index",content,locator FROM research_knowledge_chunks ORDER BY chunk_index').all(),
      plan.map(({id,index,content,locator})=>({id,index,content,locator})));
    for (const chunk of plan.filter(c=>c.structure?.parentId)) {
      assert.equal(content.slice(chunk.structure.start,chunk.structure.end),chunk.content);
    }
    const prepared=await f.embeddings.prepareSource(input,metadata,null);
    assert.deepEqual(prepared,{identity:null,chunks:expected,vectors:[]});
  } finally {await f.close();}
});
test('real native PDF publishes scientific and generic vectors together; cached rebuild needs no parser/provider', async () => {
  const f=await fixture();
  try {
    const a=await f.job(false); await f.process(a);
    assert.equal(f.repository.indexing.job(a.id).status,'ready');
    const old=snapshot(f); assert.ok(old.active.length===1 && old.vectors.length>0 && old.activeVectors.length>0);
    const calls=f.calls(), parses=f.parses();
    // A configuration-independent job invalidation exercises the cached-source path.
    f.repository.indexing.invalidate(f.project.id);
    const b=await f.job(false); await f.process(b);
    assert.equal(f.repository.indexing.job(b.id).status,'ready');
    assert.equal(f.calls(),calls); assert.equal(f.parses(),parses);
    assert.equal(f.repository.scientificIndex.get(old.active[0].id).status,'retired');
    assert.equal(snapshot(f).active.length,1);
    const references=f.repository.indexing.referencedArtifacts();
    assert.ok(references.has(JSON.parse(old.active[0].snapshot_json).source.artifactId));
  } finally {await f.close();}
});
test('scientific provider failure and later generic provider failure preserve the entire old active index', async () => {
  for (const boundary of ['scientific','generic']) {
    const f=await fixture();
    try {
      const a=await f.job(false); await f.process(a); const old=snapshot(f);
      await f.write('Replacement method has changed sources.');
      f.provider(async texts=>{
        if(boundary==='scientific' || texts.some(text=>text.startsWith('Document:'))) throw new Error('embedding_provider_http_503');
        return texts.map(()=>[1,2,3]);
      });
      const b=await f.job(false); await f.process(b);
      assert.equal(f.repository.indexing.job(b.id).status,'failed');
      assertOriginalQueryable(f,old);
      assert.equal(f.db.prepare("SELECT count(*) FROM research_scientific_index_generations WHERE status='failed'").pluck().get(),1);
      if(boundary==='generic') assert.ok(f.db.prepare(`SELECT count(*) FROM research_scientific_embeddings e
        JOIN research_scientific_index_generations g ON g.id=e.generation_id WHERE g.status='failed'`).pluck().get()>0);
    } finally {await f.close();}
  }
});
test('source/configuration changes during provider await cannot publish a candidate', async () => {
  for (const change of ['source','configuration']) {
    const f=await fixture(); let release;
    try {
      const a=await f.job(false); await f.process(a); const old=snapshot(f);
      await f.write('Replacement method changes its inputs.');
      let enter; const entered=new Promise(resolve=>{enter=resolve;});
      const pending=new Promise(resolve=>{release=resolve;});
      f.provider(async texts=>{enter(); await pending; return texts.map(()=>[1,2,3]);});
      const b=await f.job(false), operation=f.process(b); await entered;
      if(change==='source') await f.write('Unpublished source changed during provider.');
      else f.repository.knowledge.saveEmbeddingConfig({...config,model:'model-two'},'test-secret');
      release(); await operation;
      assert.equal(f.repository.indexing.job(b.id).status,'failed');
      assertOriginalQueryable(f,old);
    } finally {release?.(); await f.close();}
  }
});
test('failed generic vector consumer rolls back text, job receipt and scientific active switch', async () => {
  const f=await fixture();
  try {
    const a=await f.job(false); await f.process(a); const old=snapshot(f);
    await f.write('Replacement method is ready to publish.');
    f.db.exec(`CREATE TRIGGER reject_vector BEFORE INSERT ON research_knowledge_embeddings
      BEGIN SELECT RAISE(ABORT,'research_test_vector_write_failed'); END`);
    const b=await f.job(false); await f.process(b);
    assert.equal(f.repository.indexing.job(b.id).status,'failed');
    assertOriginalQueryable(f,old);
    assert.equal(f.repository.scientificIndex.get(old.active[0].id).status,'active');
  } finally {await f.close();}
});
test('plaintext and no-configuration publication keep explicit absence of scientific/vector rows', async () => {
  for(const [kind,enabled] of [['markdown',true],['pdf',false]]) {
    const f=await fixture(kind,enabled);
    try {
      const a=await f.job(false); await f.process(a); const old=snapshot(f);
      assert.equal(f.repository.indexing.job(a.id).status,'ready');
      assert.equal(old.active.length,kind==='pdf'?1:0);
      assert.equal(old.vectors.length>0,enabled);
      assert.equal(old.activeVectors.length,0);
      if(enabled) {
        await f.write('Replacement plaintext source.');
        f.provider(async ()=>{throw new Error('embedding_provider_http_503');});
        const b=await f.job(false); await f.process(b);
        assert.equal(f.repository.indexing.job(b.id).status,'failed'); assert.deepEqual(snapshot(f),old);
      } else assert.equal(f.calls(),0);
    } finally {await f.close();}
  }
});
test('startup marks interrupted project builds for rescan without recovering library work or removing old artifacts', async () => {
  const f=await fixture();
  try {
    const a=await f.job(false); await f.process(a); const old=snapshot(f);
    const ir=await f.indexer.paperIR(f.project.id,a.fileId), current=old.active[0];
    const staged=f.repository.scientificIndex.begin({ir,projectId:f.project.id,
      source:JSON.parse(current.snapshot_json).source,embedding:f.embeddings.selectedIdentity(null)});
    const library=f.repository.scientificIndex.begin({ir,projectId:null,source:{kind:'library'},embedding:null});
    // Disable background scheduling while checking the actual startup recovery owner.
    const settings=f.repository.indexing.settings(f.project.id), {projectId,revision,...value}=settings;
    f.repository.indexing.saveSettings(projectId,revision,{...value,paused:true,watch:false});
    f.indexer.start();
    assert.equal(f.repository.scientificIndex.get(staged.id).status,'cancelled');
    assert.equal(f.repository.scientificIndex.get(library.id).status,'building');
    assert.equal(f.repository.indexing.scope(f.project.id).scan_requested,1);
    assertOriginalQueryable(f,old);
    await readFile(join(f.storage,'artifacts',JSON.parse(current.snapshot_json).source.artifactId,'result.json'));
  } finally {await f.close();}
});
test('removing a project source retires retrieval generations while preserving all historical chunks and artifacts', async () => {
  const f=await fixture();
  try {
    const a=await f.job(false); await f.process(a);
    const active=snapshot(f).active[0], history=f.repository.scientificIndex.chunks(active.id,f.project.id);
    await rm(f.source);
    f.repository.indexing.requestScan(f.project.id,false);
    await f.indexer.scan(f.project.id,new AbortController().signal);
    assert.equal(f.repository.scientificIndex.get(active.id).status,'retired');
    assert.equal(f.repository.scientificIndex.active(f.project.id,active.document_id),null);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_documents').pluck().get(),0);
    assert.deepEqual(f.repository.scientificIndex.chunks(active.id,f.project.id),history);
    await readFile(join(f.storage,'artifacts',JSON.parse(active.snapshot_json).source.artifactId,'result.json'));
  } finally {await f.close();}
});
