import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, ScientificLibraryIndexService;
before(async () => {
  [api, {ScientificLibraryIndexService}] = await Promise.all([loadResearchTestApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-library-index.ts', {platform:'node'})]);
});
after(() => api?.dispose());
const config = {id:'test', name:'test', baseUrl:'https://fixture.invalid', model:'model-one', dimensions:3, enabled:true};
const options = {tier:'compact', device:'cpu', pageRange:''};
const logger = {info() {}, warn() {}, error() {}};
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'roc-scientific-library-')));
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600,800]);
  page.drawText('2 Method', {x:30,y:740,size:14,font});
  page.drawText('Original method learns exact sources.', {x:30,y:700,size:10,font});
  const bytes = Buffer.from(await pdf.save()), source = join(root,'source.pdf');
  await writeFile(source,bytes);
  const f = createResearchFixture(api,'reading',root);
  const document = f.repository.documents.import({id:'library-document', libraryItemId:null, projectId:f.project.id,
    filename:'source.pdf', mediaType:'application/pdf', sourcePath:'source.pdf', sourceHash:hash(bytes), size:bytes.length,
    entry:{metadata:{id:'library-paper', source:'local', externalId:'publication-fixture', doi:null,
      title:'Synthetic library publication', authors:[], abstract:null, publishedYear:null, citationCount:null,
      url:null, openAccessUrl:null, importedAt:'2026-11-16T00:00:00Z', updatedAt:'2026-11-16T00:00:00Z'},
      bibliography:{citationKey:'libraryPublication', entryType:'article', fields:{title:'Synthetic library publication'},
        preambles:[], csl:null, title:'Synthetic library publication', authors:[], doi:null, publishedYear:null, abstract:null, url:null}}
  },false).document;
  if (enabled) f.repository.knowledge.saveEmbeddingConfig(config,'test-secret');
  let calls=0, parses=0, provider=async texts => texts.map(()=>[3,4,0]);
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
    {embed:async ({texts,signal}) => {calls++; return await provider(texts,signal);}},
    {secrets:{get:async ()=>'test-key'},logger});
  const library = new ScientificLibraryIndexService(f.repository,embeddings,root);
  const service = new api.ResearchDocumentService(f.repository,{
    defaultParseOptions:()=>options,
    parseDocument:async input => {parses++; return await api.parseResearchDocument({...input,modelFiles:null,modelManifest:''});}
  },root,null,null,library);
  const startJobs = () => f.repository.knowledgeJobs.start((id,signal,requireCurrent) =>
    id.startsWith('document:') ? library.rebuild(id,signal,requireCurrent) : embeddings.embedDocument(id,null,signal));
  return {...f,root,source,bytes,document,embeddings,library,service,startJobs,
    parse:()=>service.parse(document.id), provider:value=>{provider=value;}, calls:()=>calls, parses:()=>parses,
    changeConfig:model=>f.repository.knowledge.saveEmbeddingConfig({...config,model},'test-secret'),
    close:async ()=>{await service.shutdown(); await f.repository.knowledgeJobs.shutdown(); await embeddings.shutdown();
      await f.close(); await rm(root,{recursive:true,force:true});}};
}
function snapshot(f) {
  return {
    documents:f.db.prepare("SELECT * FROM research_knowledge_documents WHERE id LIKE 'document:%' ORDER BY id").all(),
    chunks:f.db.prepare("SELECT * FROM research_knowledge_chunks WHERE document_id LIKE 'document:%' ORDER BY id").all(),
    vectors:f.db.prepare(`SELECT e.* FROM research_knowledge_embeddings e JOIN research_knowledge_chunks c ON c.id=e.chunk_id
      WHERE c.document_id LIKE 'document:%' ORDER BY e.chunk_id,e.space_key`).all(),
    keywords:f.db.prepare(`SELECT k.rowid,k.content,k.title FROM research_knowledge_keywords k
      JOIN research_knowledge_chunks c ON c.rowid=k.rowid WHERE c.document_id LIKE 'document:%' ORDER BY k.rowid`).all(),
    active:f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='active' ORDER BY id").all(),
    activeVectors:f.db.prepare(`SELECT e.* FROM research_scientific_embeddings e
      JOIN research_scientific_index_generations g ON g.id=e.generation_id WHERE g.status='active' ORDER BY e.chunk_id`).all()
  };
}
function assertOriginal(f, old, parseId) {
  assert.deepEqual(snapshot(f),old);
  assert.equal(f.repository.documents.get(f.document.id).currentParseId,parseId);
  assert.ok(f.db.prepare("SELECT count(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'Original'").pluck().get()>0);
  assert.ok(f.db.prepare(`SELECT count(*) FROM research_scientific_fts f
    JOIN research_scientific_index_generations g ON g.id=f.generation_id
    WHERE research_scientific_fts MATCH 'Original' AND g.status='active'`).pluck().get()>0);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
}
function gate(f) {
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}), pending=new Promise(resolve=>{release=resolve;});
  f.provider(async texts=>{enter();await pending;return texts.map(()=>[1,2,3]);});
  return {entered,release};
}
test('real native library PDF publishes both vector indexes and ready outbox; cached reparse retains history', async () => {
  const f=await fixture();
  try {
    const a=await f.parse(); assert.equal(a.status,'ready');
    const old=snapshot(f), {data}=f.repository.documents.parsed(a.id,a.currentParseId);
    assert.ok(old.active.length===1 && old.vectors.length>0 && old.activeVectors.length>0);
    assert.equal(f.repository.knowledgeJobs.list(null).find(j=>j.documentId===`document:${a.currentParseId}`).status,'ready');
    const calls=f.calls(), b=await f.parse(); assert.equal(b.status,'ready');
    assert.notEqual(a.currentParseId,b.currentParseId); assert.equal(f.calls(),calls);
    assert.equal(f.repository.scientificIndex.get(old.active[0].id).status,'retired');
    assert.deepEqual(f.repository.documents.parsed(a.id,a.currentParseId).data,data);
    assert.ok((await readdir(join(f.root,data.outputPath))).length>0);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {await f.close();}
});
test('scientific/provider and generic/vector SQL failures preserve current parse, old text/vectors and failed parser output', async () => {
  for (const boundary of ['scientific','generic','vector-write']) {
    const f=await fixture();
    try {
      const a=await f.parse(), old=snapshot(f); f.changeConfig('model-two');
      if (boundary==='vector-write') f.db.exec(`CREATE TRIGGER reject_vector BEFORE INSERT ON research_knowledge_embeddings
        BEGIN SELECT RAISE(ABORT,'research_test_vector_write_failed'); END`);
      else f.provider(async texts=>{
        if(boundary==='scientific' || texts.some(text=>text.startsWith('Document:'))) throw new Error('embedding_provider_http_503');
        return texts.map(()=>[1,2,3]);
      });
      const b=await f.parse(); assert.equal(b.status,'failed');
      assertOriginal(f,old,a.currentParseId);
      const run=f.repository.documents.runs(a.id)[0], failed=f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='failed'").all();
      assert.equal(failed.length,1); assert.equal(run.status,'failed');
      // The immutable IR receipt must still be readable even though this parse did not become current.
      const ir=JSON.parse(failed[0].snapshot_json).paperIR;
      assert.equal(hash(await readFile(join(f.root,ir.path))),ir.sha256);
      const walk=await readdir(f.root,{recursive:true});
      assert.ok(walk.some(path=>path.includes(run.id) && path.endsWith('structured.json')),
        'failed parser structured output must be retained');
    } finally {await f.close();}
  }
});
test('provider-time original source, embedding config, title, IR corruption and cancellation cannot publish', async () => {
  for (const change of ['source','configuration','title','IR','cancel']) {
    const f=await fixture();let waiting;
    try {
      const a=await f.parse(), old=snapshot(f); f.changeConfig('model-two');
      waiting=gate(f); const operation=f.parse(); await waiting.entered;
      if(change==='source') await writeFile(f.source,Buffer.concat([f.bytes,Buffer.from('\n% changed\n')]));
      if(change==='configuration') f.changeConfig('model-three');
      if(change==='title') {
        const item=f.repository.library.get(f.document.libraryItemId);
        f.db.prepare('UPDATE research_library SET metadata_json=? WHERE id=?')
          .run(JSON.stringify({...item.metadata,title:'Changed during embedding'}),item.id);
      }
      if(change==='IR') {
        const candidate=f.db.prepare("SELECT snapshot_json FROM research_scientific_index_generations WHERE status='building'").get();
        const ir=JSON.parse(candidate.snapshot_json).paperIR;
        await writeFile(join(f.root,ir.path),'corrupted immutable IR');
      }
      if(change==='cancel') {
        const active=f.repository.documents.get(f.document.id);
        f.service.cancel(active.id,active.activeParseId);
      }
      waiting.release(); const b=await operation;
      assert.equal(b.status,change==='cancel'?'cancelled':'failed');
      assertOriginal(f,old,a.currentParseId);
    } finally {waiting?.release();await f.close();}
  }
});
test('configuration outbox rebuild atomically replaces both indexes without re-running the parser', async () => {
  const f=await fixture();
  try {
    const a=await f.parse(), old=snapshot(f), parses=f.parses();
    f.changeConfig('model-two'); f.startJobs();
    f.repository.knowledgeJobs.configurationChanged(); await f.repository.knowledgeJobs.idle();
    const current=snapshot(f);
    assert.equal(f.parses(),parses); assert.equal(f.repository.documents.get(a.id).currentParseId,a.currentParseId);
    assert.equal(f.repository.scientificIndex.get(old.active[0].id).status,'retired');
    assert.equal(current.active.length,1); assert.equal(current.active[0].embedding_config_revision,2);
    assert.ok(current.vectors.length>0 && current.activeVectors.length>0);
    assert.ok(current.vectors.every(row=>row.space_key==='embedding:test:2'));
    assert.equal(f.repository.knowledgeJobs.list(null).find(j=>j.documentId===`document:${a.currentParseId}`).status,'ready');
  } finally {await f.close();}
});
test('replaced and deleted running outbox jobs fence actual library publication', async () => {
  for (const change of ['requeue','delete']) {
    const f=await fixture();let waiting;
    try {
      const a=await f.parse(), old=snapshot(f); f.changeConfig('model-two');
      waiting=gate(f);
      const id=`document:${a.currentParseId}`;
      f.repository.knowledgeJobs.enqueue(id);
      let fenced=false;
      f.repository.knowledgeJobs.start(async (documentId,signal,requireCurrent)=>{
        if(!documentId.startsWith('document:')) return null;
        try {return await f.library.rebuild(documentId,signal,requireCurrent);}
        catch(error) {
          assert.match(error.message,/research_knowledge_job_changed/);
          assertOriginal(f,old,a.currentParseId);
          fenced=true;
          throw error;
        }
      });
      await waiting.entered;
      if(change==='requeue') f.repository.knowledgeJobs.enqueue(id);
      else f.db.prepare('DELETE FROM research_knowledge_jobs WHERE document_id=?').run(id);
      waiting.release();
      await f.repository.knowledgeJobs.idle();
      assert.equal(fenced,true);
      assert.equal(f.db.prepare("SELECT count(*) FROM research_scientific_index_generations WHERE status='failed'").pluck().get(),1);
      if(change==='delete') assertOriginal(f,old,a.currentParseId);
      else assert.equal(snapshot(f).active[0].embedding_config_revision,2);
    } finally {waiting?.release();await f.close();}
  }
});
test('no-config text publication, archive retirement and restore vector rebuilding retain historical parses', async () => {
  const f=await fixture(false);
  try {
    const a=await f.parse(), old=snapshot(f); assert.equal(a.status,'ready');
    assert.equal(old.vectors.length,0);assert.equal(old.activeVectors.length,0);assert.equal(old.active.length,1);
    assert.equal(f.repository.knowledgeJobs.list(null).find(j=>j.documentId===`document:${a.currentParseId}`).status,'blocked');
    let item=f.repository.library.get(f.document.libraryItemId);
    item=f.repository.library.archive(item.id,item.revision,true);
    assert.equal(snapshot(f).active.length,0);assert.equal(snapshot(f).documents.length,0);
    assert.equal(f.repository.scientificIndex.get(old.active[0].id).status,'retired');
    assert.ok(f.repository.documents.parsed(a.id,a.currentParseId).data.paperIR);
    f.changeConfig('model-two');
    f.repository.library.archive(item.id,item.revision,false); f.startJobs();await f.repository.knowledgeJobs.idle();
    assert.equal(snapshot(f).active.length,1);assert.ok(snapshot(f).activeVectors.length>0);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  } finally {await f.close();}
});
test('startup recovery requeues configuration builds and identifies interrupted new parses in library scope only', async () => {
  const f=await fixture();
  try {
    const a=await f.parse(), {data}=f.repository.documents.parsed(a.id,a.currentParseId);
    const prepared=await f.library.prepare(a.id,a.currentParseId,data,new AbortController().signal);
    assert.deepEqual(f.library.recover(),[]);
    assert.equal(f.repository.scientificIndex.get(prepared.staged.generation.id).status,'cancelled');
    assert.equal(f.repository.knowledgeJobs.list(null).find(j=>j.documentId===`document:${a.currentParseId}`).status,'queued');
    // Exercise a real interrupted new parse after its immutable IR has been staged.
    const parseId='interrupted-library-parse';f.repository.documents.begin(a.id,parseId);
    const input=structuredClone(data);
    const ir=f.repository.documents.buildPaperIR(a.id,parseId,{...input,paperIR:undefined,paperIRVersion:undefined});
    const {PaperIRRepository}=await importTypeScriptModule('src/main/plugins/research/paper-ir-repository.ts',{platform:'node'});
    input.paperIR=await new PaperIRRepository(f.root).publish(ir);input.paperIRVersion=input.paperIR.version;
    const interrupted=await f.library.prepare(a.id,parseId,input,new AbortController().signal);
    f.repository.documents.recover();
    assert.deepEqual(f.library.recover(),[a.id]);
    assert.equal(f.repository.scientificIndex.get(interrupted.staged.generation.id).status,'cancelled');
    assert.equal(f.repository.documents.get(a.id).currentParseId,a.currentParseId);
    assert.equal(f.repository.documents.runs(a.id)[0].error,'research_document_parse_interrupted');
    await f.service.parseMany({documentIds:[a.id],tier:null});
    assert.equal(f.repository.documents.get(a.id).status,'ready');
  } finally {await f.close();}
});
