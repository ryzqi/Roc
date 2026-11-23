import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';
let api, visual;
before(async () => {
  const modules = await Promise.all([loadScientificSearchApi(), ...['visual-index-service','visual-index-repository',
    'visual-retrieval-adapter','visual-model-files','scientific-search-snapshot'].map(name =>
    importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']}))]);
  api = modules[0]; visual = Object.assign({}, ...modules.slice(1));
});
after(() => api?.dispose());
const matrix = rows => ({tokens:rows.length,dimensions:rows[0].length,values:new Float32Array(rows.flat())});
const signal = () => new AbortController().signal;
const model = {family:'colpali',path:'/controlled-fixture/no-model',sha256:'a'.repeat(64),selectionId:'fixture',selectionHash:'b'.repeat(64)};
async function fixture(options = {}) {
  const f = await scientificSearchFixture(api, {image:true,embedded:false,...options});
  const configs = new Map(), config = {get:key=>configs.get(key)??null,set:(key,value)=>configs.set(key,value)};
  let calls = 0, encode = async input => ({matrices:(input.query === null ? input.images : [input.query]).map(()=>matrix([[1,0],[0,1]])),assertCurrent(){}});
  const adapter = {encode:async (...args)=>{calls++;return encode(...args);}};
  const store = new visual.VisualIndexRepository(f.root);
  const create = () => new visual.VisualIndexService(f.repository,{library:f.root,index:null},store,adapter,config);
  const service = create(), request = {projectId:f.project.id,assets:[{documentId:f.document.id,objectId:f.ir.figures[0].id}]};
  const query = {projectId:f.project.id,query:'architecture diagram',intent:'figure'};
  return {...f,service,store,create,request,query,calls:()=>calls,encode:value=>{encode=value;},
    enable:()=>service.saveConfig(f.project.id,{enabled:true,model}),close:async()=>{await service.shutdown();await f.close();}};
}
test('MaxSim sums token maxima independently; invalid vectors, dimensions and budget fail closed', async () => {
  const q = matrix([[1,0],[0,1]]), a = matrix([[1,0],[0,1]]), b = matrix([[Math.SQRT1_2,Math.SQRT1_2]]);
  const scores = await visual.visualMaxSim(q,[a,b],signal());
  assert.equal(scores[0],2); assert.ok(Math.abs(scores[1]-Math.SQRT2)<1e-6);
  assert.throws(()=>visual.validateVisualMatrix(matrix([[0,0]])),/not_normalized/);
  assert.throws(()=>visual.validateVisualMatrix(matrix([[NaN,1]])),/value_invalid/);
  assert.throws(()=>visual.decodeVisualMatrix(Buffer.alloc(4),{tokens:2,dimensions:2}),/size_invalid/);
  await assert.rejects(visual.visualMaxSim(q,[matrix([[1,0,0]])],signal()),/dimensions_changed/);
  const huge = matrix(Array.from({length:4096},()=>Array.from({length:512},(_,i)=>i===0?1:0)));
  const longQuery = matrix(Array.from({length:256},()=>Array.from({length:512},(_,i)=>i===0?1:0)));
  await assert.rejects(visual.visualMaxSim(longQuery,[huge],signal()),/budget_exceeded/);
  const controller = new AbortController(); controller.abort(new Error('cancel scoring'));
  await assert.rejects(visual.visualMaxSim(q,[a],controller.signal),/cancel scoring/);
});
test('default disabled and text intent avoid inference and visual disk writes; normal scientific search still works', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.service.readConfig(f.project.id),{enabled:false,model:null});
    assert.equal((await f.service.search(f.query)).status,'disabled');
    await assert.rejects(f.service.rebuild(f.request),/visual_disabled/);
    f.enable();
    assert.equal((await f.service.search({...f.query,intent:'text'})).status,'not_applicable');
    assert.equal(f.calls(),0); assert.ok(!(await readdir(f.root)).includes('visual-index'));
    assert.ok((await f.router.search({projectId:f.project.id,query:'Original method',documentIds:[]})).candidates.length);
  } finally {await f.close();}
});
test('selected assets publish durable token matrices and original PDF locators, preserving raw values and source files', async () => {
  const f = await fixture();
  try {
    f.enable();
    const publication = await f.service.rebuild(f.request), index = await f.store.active(f.project.id);
    assert.equal(publication.generation,index.generation); assert.equal(index.manifest.entries.length,1);
    assert.deepEqual([...index.matrices[0].values],[1,0,0,1]);
    const restarted = f.create();
    try {
      const result = await restarted.search(f.query), candidate = result.candidates[0];
      assert.equal(result.status,'ready'); assert.equal(candidate.score,2);
      assert.deepEqual(candidate.image.sourceLocator,f.ir.figures[0].sourceLocator);
      assert.equal(candidate.image.sha256,hash(f.imageBytes));
      assert.equal(candidate.verification,'verify_original_pdf'); assert.equal(candidate.exactValues,'requires_table_or_text');
      assert.equal(hash(await readFile(f.source)),hash(f.bytes));
      assert.deepEqual(f.ir.tables[0].cells.map(c=>c.text),['Method','F1 (%)','Original baseline','90','91']);
      assert.equal((await restarted.search({...f.query,intent:'table'})).candidates.length,0);
    } finally {await restarted.shutdown();}
  } finally {await f.close();}
});
test('foreign documents and unavailable page assets are rejected before inference', async () => {
  const f = await fixture();
  try {
    f.enable();
    await assert.rejects(f.service.rebuild({...f.request,assets:[{documentId:'foreign',objectId:'page:1'}]}),/scope_invalid/);
    await assert.rejects(f.service.rebuild({...f.request,assets:[{documentId:f.document.id,objectId:'page:1'}]}),/object_invalid/);
    assert.equal(f.calls(),0);
    await f.service.rebuild(f.request);
    await assert.rejects(f.service.search({...f.query,documentIds:['foreign']}),/scope_invalid/);
  } finally {await f.close();}
});
test('model errors and a final model identity fence keep the previous active generation', async () => {
  const f = await fixture();
  try {
    f.enable(); const first = await f.service.rebuild(f.request);
    f.encode(async()=>{throw new Error('fixture model unavailable');});
    await assert.rejects(f.service.rebuild(f.request),/fixture model unavailable/);
    assert.equal((await f.store.active(f.project.id)).generation,first.generation);
    f.encode(async()=>({matrices:[matrix([[1,0]])],assertCurrent(){throw new Error('model changed after inference');}}));
    await assert.rejects(f.service.rebuild(f.request),/model changed after inference/);
    assert.equal((await f.store.active(f.project.id)).generation,first.generation);
  } finally {await f.close();}
});
for (const change of ['image','source','generation','config','owner']) test(`in-flight ${change} mutation rejects results and preserves old active`, async () => {
  const f = await fixture();
  try {
    f.enable(); const first = await f.service.rebuild(f.request);
    f.encode(async()=>{
      if (change==='image') await writeFile(join(f.root,'parser/figure.png'),Buffer.from('changed image'));
      if (change==='source') await writeFile(f.source,Buffer.from('changed source'));
      if (change==='generation') await f.publish();
      if (change==='config') f.service.saveConfig(f.project.id,{enabled:false,model});
      if (change==='owner') f.db.prepare('UPDATE research_library SET revision = revision + 1 WHERE id = ?').run(f.document.libraryItemId);
      return {matrices:[matrix([[1,0]])],assertCurrent(){}};
    });
    await assert.rejects(f.service.search(f.query),/changed|source_hash|source_size|invalid|cancelled/);
    assert.equal((await f.store.active(f.project.id)).generation,first.generation);
  } finally {await f.close();}
});
test('cancel and shutdown wait for adapter settlement before allowing another operation', async () => {
  const f = await fixture();
  let release, entered;
  const ready = new Promise(resolve=>{entered=resolve;}), settlement = new Promise(resolve=>{release=resolve;});
  try {
    f.enable(); const first = await f.service.rebuild(f.request);
    f.encode(async (_input, signal)=>{entered(); await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      await settlement; signal.throwIfAborted();});
    const pending = f.service.rebuild(f.request); pending.catch(()=>{}); await ready;
    let done = false; const shutdown = f.service.shutdown().then(()=>{done=true;});
    await delay(10); assert.equal(done,false);
    await assert.rejects(f.service.search(f.query),/visual_closed/);
    release(); await shutdown; await assert.rejects(pending,/visual_cancelled/);
    assert.equal((await f.store.active(f.project.id)).generation,first.generation);
  } finally {release?.();await f.close();}
});
test('independent index integrity rejects changed binary data and symlink model input', async () => {
  const f = await fixture();
  try {
    f.enable();await f.service.rebuild(f.request);
    const index = await f.store.active(f.project.id), dir = join(f.root,'visual-index',hash(f.project.id));
    await writeFile(join(dir,`${index.manifest.entries[0].matrix.sha256}.f32`),Buffer.alloc(16));
    await assert.rejects(f.service.search(f.query),/index_changed/);
    assert.equal(f.calls(),1);
  } finally {await f.close();}
});
test('model inspection binds actual local bytes and forbids executable modules or non-retrieval architecture', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'roc-visual-model-')));
  try {
    await writeFile(join(root,'config.json'),JSON.stringify({architectures:['ColPaliForRetrieval']}));
    await writeFile(join(root,'model.safetensors'),'controlled fixture, not actual weights');
    const first = await visual.inspectVisualModel(root,'colpali',signal());
    assert.equal((await visual.inspectVisualModel(root,'colpali',signal())).sha256,first.sha256);
    await writeFile(join(root,'model.safetensors'),'different fixture weights');
    assert.throws(first.assertCurrent,/model_changed/);
    assert.notEqual((await visual.inspectVisualModel(root,'colpali',signal())).sha256,first.sha256);
    await assert.rejects(visual.inspectVisualModel(root,'colqwen2',signal()),/architecture_unsupported/);
    await writeFile(join(root,'modules.json'),'[]');
    await assert.rejects(visual.inspectVisualModel(root,'colpali',signal()),/file_unsupported/);
    await rm(join(root,'modules.json'));
    await symlink(join(root,'config.json'),join(root,'linked.json'));
    await assert.rejects(visual.inspectVisualModel(root,'colpali',signal()),/symlink/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('model cancellation during file open closes the descriptor without an uncaught stream error', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-visual-model-abort-')));
  try {
    await writeFile(join(root, 'model.safetensors'), 'controlled fixture');
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      import {importTypeScriptModule} from './scripts/lib/bundle-ts.mjs';
      const {inspectVisualModel} = await importTypeScriptModule(
        'src/main/plugins/research/visual-model-files.ts', {platform: 'node'});
      const original = fs.open, controller = new AbortController(), reason = new Error('controlled_model_cancel');
      let opened;
      fs.open = async (...args) => {
        opened = await original(...args);
        controller.abort(reason);
        return opened;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(inspectVisualModel(process.argv[1], 'colpali', controller.signal), error => error === reason);
        assert.equal(opened.fd, -1);
        await new Promise(resolve => setImmediate(resolve));
        console.log('model_abort_caught');
      } finally {fs.open = original; syncBuiltinESMExports();}
    `, root], {timeout: 10_000});
    assert.equal(result.stdout.trim(), 'model_abort_caught');
    assert.equal(result.stderr, '');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('explicit Table image candidates retain the table locator and exact original cells', async () => {
  const f = await fixture({imageKind:'table'});
  try {
    f.enable();
    await f.service.rebuild({...f.request,assets:[{documentId:f.document.id,objectId:f.ir.tables[0].id}]});
    const result = await f.service.search({...f.query,intent:'table'});
    assert.equal(result.candidates[0].kind,'table');
    assert.deepEqual(result.candidates[0].image.sourceLocator,f.ir.tables[0].sourceLocator);
    assert.equal(result.candidates[0].exactValues,'requires_table_or_text');
    assert.deepEqual(f.ir.tables[0].cells.map(c=>c.text),['Method','F1 (%)','Original baseline','90','91']);
  } finally {await f.close();}
});

test('project release blocks admission until cancellation settles and deletion cleanup finishes', async () => {
  const f = await fixture();
  let entered, settle, cleanup;
  const ready = new Promise(resolve=>{entered=resolve;}), gate = new Promise(resolve=>{settle=resolve;});
  const cleanupGate = new Promise(resolve=>{cleanup=resolve;});
  try {
    f.enable(); const first = await f.service.rebuild(f.request);
    f.encode(async (_input, signal)=>{entered(); await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      await gate; signal.throwIfAborted();});
    const pending = f.service.rebuild(f.request); pending.catch(()=>{}); await ready;
    let cleaning = false;
    const release = f.service.withProjectReleased(f.project.id, async()=>{cleaning=true;await cleanupGate;return 'deleted';});
    await delay(10); assert.equal(cleaning,false);
    await assert.rejects(f.service.search(f.query),/project_releasing/);
    settle(); await assert.rejects(pending,/visual_cancelled/); await delay(10);
    assert.equal(cleaning,true); await assert.rejects(f.service.search(f.query),/project_releasing/);
    cleanup(); assert.equal(await release,'deleted');
    assert.equal((await f.store.active(f.project.id)).generation,first.generation);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await f.service.withProjectReleased(f.project.id, async()=>{});
  } finally {settle?.();cleanup?.();await f.close();}
});
