import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const deferred = () => Promise.withResolvers();

async function fixture(fileCount = 1) {
  const root = await mkdtemp(join(tmpdir(), 'roc-index-release-')), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace), entered = deferred(), cleanup = deferred();
  await writeFile(join(workspace, 'paper.md'), '# Result\n\nOriginal retained paper result.');
  for (let index = 1; index < fileCount; index++) {
    await writeFile(join(workspace, `paper-${index}.md`), `# Result ${index}\n\nOriginal retained batch result ${index}.`);
  }
  f.repository.knowledge.saveEmbeddingConfig({id:'test',name:'Test',baseUrl:'https://fixture.invalid',
    model:'fixture',dimensions:2,enabled:true},'fixture');
  let calls = 0;
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {embed:async ({texts,signal}) => {
    calls++;
    if (calls === 1) {entered.resolve(signal); await cleanup.promise;}
    return texts.map(() => [1,0]);
  }}, {secrets:{get:async ()=>'fixture'},logger:{warn(){}}});
  const warnings = [];
  const service = new api.ResearchIndexService(f.repository,
    {defaultParseOptions:()=>({tier:'compact'}),identity:async ()=>'unused',parseDocument:async ()=>{throw Error('unexpected parser');}},
    embeddings,join(root,'storage'),{info(){},warn:(...args)=>warnings.push(args)},undefined,api.mainResourceActivity);
  const configure = async () => {
    const {revision, projectId, ...settings} = f.repository.indexing.settings(f.project.id);
    return await service.configure({...settings,projectId,expectedRevision:revision,paused:false,watch:false});
  };
  const control = action => service.control({projectId:f.project.id,
    expectedRevision:service.status(f.project.id).settings.revision,action,fileId:null});
  return {...f,service,entered,cleanup,configure,control,warnings,calls:()=>calls,
    close:async () => {cleanup.resolve(); await service.shutdown(); await embeddings.shutdown(); await f.close();
      await rm(root,{recursive:true,force:true});}};
}

test('pause acknowledges only after provider settlement and resume processes the preserved source', {timeout:15000}, async () => {
  const f = await fixture();
  try {
    await f.configure(); const signal = await f.entered.promise;
    let acknowledged = false;
    const paused = Promise.resolve(f.control('pause')).then(value=>{acknowledged=true; return value;});
    await nextTurn();
    assert.equal(signal.aborted,true);
    assert.equal(acknowledged,false,'pause must wait for actual cleanup');
    assert.equal(api.mainResourceActivity.busy,true);
    f.cleanup.resolve();
    assert.equal((await paused).phase,'paused');
    assert.equal(api.mainResourceActivity.busy,false);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_index_jobs WHERE status='running'").pluck().get(),0);
    await f.control('resume');
    const deadline = Date.now()+5000;
    while (f.service.status(f.project.id).phase!=='idle' && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.status(f.project.id).phase,'idle');
    assert.equal(f.calls(),2);
    assert.equal(f.db.prepare('SELECT content FROM research_knowledge_documents').pluck().get(),
      '# Result\n\nOriginal retained paper result.');
    assert.deepEqual(f.warnings,[]);
  } finally {await f.close();}
});

test('a hundred-file index queue pauses with settled cancellation and resumes all preserved work', {timeout:30000}, async () => {
  const f = await fixture(100);
  try {
    await f.configure(); const signal = await f.entered.promise;
    const paused = f.control('pause');
    await nextTurn(); assert.equal(signal.aborted, true);
    f.cleanup.resolve(); await paused;
    assert.equal(f.service.status(f.project.id).phase, 'paused');
    assert.equal(f.db.prepare("SELECT count(*) FROM research_index_jobs WHERE status='running'").pluck().get(), 0);
    const calls = f.calls(); await new Promise(done => setTimeout(done, 40)); assert.equal(f.calls(), calls);
    await f.control('resume');
    const deadline = Date.now() + 15000;
    while (f.service.status(f.project.id).phase !== 'idle' && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.service.status(f.project.id).phase, 'idle');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_knowledge_documents').pluck().get(), 100);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_index_jobs WHERE status IN ('running','queued','failed')").pluck().get(), 0);
    assert.deepEqual(f.warnings, []);
  } finally {await f.close();}
});

test('captured index Evidence reads the preserved source with current and historical parse metadata', {timeout:15000}, async () => {
  const f = await fixture();
  try {
    await f.configure(); await f.entered.promise; f.cleanup.resolve();
    const deadline = Date.now() + 5000;
    while (f.service.status(f.project.id).phase !== 'idle' && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.service.status(f.project.id).phase, 'idle');
    const chunkId = f.db.prepare('SELECT id FROM research_knowledge_chunks').pluck().get();
    const evidence = f.repository.evidence.capture({projectId:f.project.id,chunkId});
    const metadata = f.repository.evidence.sourceMetadata(f.project.id,evidence.id);
    assert.equal(metadata.parseId,null);
    const current = f.service.evidenceSource(f.project.id,evidence.id);
    const source = await f.service.source(f.project.id,current.fileId,current.sourceHash);
    assert.equal(source.bytes.toString(),'# Result\n\nOriginal retained paper result.');
    // Only metadata variants change; real captured Evidence and cached source remain.
    for (const parseId of ['historical-parse', undefined]) {
      const variant = {...metadata};
      if (parseId === undefined) delete variant.parseId; else variant.parseId = parseId;
      f.db.prepare('UPDATE research_evidence_source_metadata SET metadata_json=? WHERE evidence_id=?')
        .run(JSON.stringify(variant),evidence.id);
      assert.deepEqual(f.service.evidenceSource(f.project.id,evidence.id),current);
    }
    for (const variant of [{...metadata,parseId:17},{...metadata,unexpected:true}]) {
      f.db.prepare('UPDATE research_evidence_source_metadata SET metadata_json=? WHERE evidence_id=?')
        .run(JSON.stringify(variant),evidence.id);
      assert.throws(() => f.service.evidenceSource(f.project.id,evidence.id));
    }
    assert.deepEqual(f.warnings,[]);
  } finally {await f.close();}
});

test('project release waits for that project and deletion fences new work through cleanup', {timeout:15000}, async () => {
  const f = await fixture();
  try {
    await f.configure(); const signal = await f.entered.promise;
    let released=false;
    const pending=Promise.resolve(f.service.releaseProject(f.project.id)).then(()=>{released=true;});
    await nextTurn(); assert.equal(signal.aborted,true); assert.equal(released,false);
    f.cleanup.resolve(); await pending;
    const actionEntered=deferred(), actionDone=deferred();
    const deletion=f.service.withProjectReleased(f.project.id,async ()=>{
      actionEntered.resolve(); await actionDone.promise;
      assert.equal(api.mainResourceActivity.busy,false);
      return f.repository.deleteProject(f.project.id);
    });
    try {
      await actionEntered.promise;
      await assert.rejects(async ()=>f.control('scan'),/project_releasing/);
      await assert.rejects(async ()=>f.configure(),/project_releasing/);
    } finally {actionDone.resolve();}
    await deletion;
    await nextTurn();
    assert.throws(()=>f.repository.getProject(f.project.id),/not_found/);
    assert.deepEqual(f.warnings,[]);
  } finally {await f.close();}
});

test('releasing another project does not wait for or abort an unrelated provider', {timeout:15000}, async () => {
  const f=await fixture();
  try {
    const otherWorkspace=join(f.project.workspacePath,'other');
    await mkdir(otherWorkspace);
    const other=f.repository.createProject({title:'Other',description:'',workspacePath:otherWorkspace});
    await f.configure(); const signal=await f.entered.promise;
    await f.service.releaseProject(other.id);
    assert.equal(signal.aborted,false);
    assert.equal(api.mainResourceActivity.busy,true);
    assert.equal(f.calls(),1);
  } finally {await f.close();}
});

test('historical Evidence pins its parse after the current document and index change', async () => {
  const f = createResearchFixture(api,'reading');
  try {
    const input={id:'old-project-doc',projectId:f.project.id,sourceType:'file',sourceId:'paper.pdf',title:'Old source',
      content:'Original cited text',chunks:[{content:'Original cited text',locator:'PDF page 1'}],embeddingPolicy:'none'};
    f.repository.knowledge.upsertFromSource(input,{type:'project-index',fileId:'original-file',sourceHash:'a'.repeat(64),
      parserKey:'old-parser',parseId:'old-parse'});
    const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:`${input.id}:chunk:0`});
    f.repository.knowledge.upsertFromSource({...input,content:'Replacement source',chunks:[{content:'Replacement source',locator:'PDF page 1'}]},
      {type:'project-index',fileId:'original-file',sourceHash:'b'.repeat(64),parserKey:'new-parser',parseId:'new-parse'});
    assert.equal(f.repository.indexing.referencedArtifacts().has('old-parse'),true);
    assert.equal(f.repository.evidence.sourceMetadata(f.project.id,evidence.id).parseId,'old-parse');
  } finally {await f.close();}
});
