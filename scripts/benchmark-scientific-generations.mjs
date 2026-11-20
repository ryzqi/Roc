import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import Database from 'better-sqlite3';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';

// A storage/publication replay, not an embedding provider or retrieval-quality benchmark.
const sourceReportPath=resolve(process.argv[3]), sourceBytes=readFileSync(sourceReportPath);
const previous=JSON.parse(sourceBytes), output=directory(resolve(process.argv[2]),'scientific-generations-public');
const entries=['src/main/plugins/research/scientific-index-repository.ts',
  'src/main/plugins/research/paper-ir-repository.ts','src/main/infrastructure/database-schemas.ts'];
const [generations,irs,schemas]=await Promise.all(entries.map(entry=>importTypeScriptModule(entry,
  {platform:'node',external:['better-sqlite3'],tempDir:resolve('.runtime/tmp')})));
const bundle=await build({entryPoints:entries,bundle:true,format:'esm',platform:'node',write:false,
  outdir:'in-memory',metafile:true,packages:'external',logLevel:'silent'});
const codeHashes=Object.fromEntries([...new Set([...Object.keys(bundle.metafile.inputs),
  'scripts/benchmark-scientific-generations.mjs','pnpm-lock.yaml'])].sort().map(p=>[p,sha256(readFileSync(p))]));
const inputs=new Map();
function pin(path,expected) {
  const bytes=readFileSync(path), sha=sha256(bytes), stat=statSync(path,{bigint:true});
  if(expected) assert.equal(sha,expected,path);
  inputs.set(path,{path,sha256:sha,mtimeNs:stat.mtimeNs.toString()}); return bytes;
}
pin(sourceReportPath,sha256(sourceBytes));
for(const input of previous.inputs) {
  pin(input.path,input.sha256); assert.equal(inputs.get(input.path).mtimeNs,input.mtimeNs);
}
const rows=JSON.parse(pin(join(previous.root,'trial-0.json'))), trials=[];
assert.equal(rows.length,previous.counts.sources);
const irStore=new irs.PaperIRRepository(previous.irRoot);
const configuration={configId:'storage-replay-only',revision:1,model:'deterministic-one-hot-test-vector',dimensions:3};
const revised={...configuration,revision:2};
const vectors=chunks=>chunks.filter(c=>c.retrieval).map(c=>({chunkId:c.id,
  vector:[0,1,2].map(index=>Number(index===parseInt(c.embeddingTextHash.slice(0,2),16)%3))}));
for(let trial=0;trial<2;trial++) {
  const trialRoot=join(output,`trial-${trial}`); mkdirSync(trialRoot);
  const path=join(trialRoot,'research.db'), db=new Database(path);
  const observations=[], totals={sources:rows.length,failedSources:0,chunks:0,retrieval:0,partialVectors:0,retainedHistory:0};
  try {
    db.pragma('foreign_keys=ON');schemas.applyResearchDatabaseSchema(db);
    const store=new generations.ScientificIndexRepository(db,()=> '2026-11-16T00:00:00.000Z');
    for(const row of rows) {
      const entry={index:row.index,status:row.status,failure:row.failure,ir:row.ir,sourceChunks:null,generations:null};
      if(row.status!=='parsed'){totals.failedSources++;observations.push(entry);continue;}
      const chunkPath=join(previous.root,row.path), expected=JSON.parse(pin(chunkPath,row.sha256));
      entry.sourceChunks={path:chunkPath,sha256:row.sha256};
      pin(join(previous.irRoot,row.ir.path),row.ir.sha256);
      const ir=await irStore.read(row.ir);
      const begin=embedding=>store.begin({ir,paperIR:row.ir,projectId:null,source:{kind:'library'},embedding});
      const a=begin(configuration);
      assert.deepEqual(store.chunks(a.id,null),expected);
      store.writeEmbeddings(a.id,configuration,vectors(expected));
      store.publish(a.id,()=>({paperIR:row.ir,embedding:configuration}));
      const b=begin(revised), partial=vectors(expected).slice(0,expected.filter(c=>c.retrieval).length>1?1:0);
      store.writeEmbeddings(b.id,revised,partial); totals.partialVectors+=partial.length;
      assert.throws(()=>store.publish(b.id,()=>({paperIR:row.ir,embedding:configuration})),/embedding_changed/);
      if(expected.some(c=>c.retrieval)) {
        assert.throws(()=>store.publish(b.id,()=>({paperIR:row.ir,embedding:revised})),/embeddings_incomplete/);
      }
      assert.equal(store.active(null,ir.identity.documentId).id,a.id);
      store.fail(b.id,'simulated_provider_failure');
      const c=begin(revised);
      store.writeEmbeddings(c.id,revised,vectors(expected));
      assert.throws(()=>store.publish(c.id,()=>({paperIR:row.ir,embedding:revised}),()=>{throw new Error('simulated_consumer_failure');}),
        /simulated_consumer_failure/);
      assert.equal(store.active(null,ir.identity.documentId).id,a.id);
      store.publish(c.id,()=>({paperIR:row.ir,embedding:revised}));
      assert.equal(store.get(a.id).status,'retired');assert.equal(store.get(b.id).status,'failed');
      assert.equal(store.active(null,ir.identity.documentId).id,c.id);
      assert.deepEqual(store.chunks(a.id,null),expected);store.verify(a.id);store.verify(c.id);
      entry.generations={retired:a.id,failed:b.id,active:c.id};
      totals.chunks+=expected.length;totals.retrieval+=expected.filter(c=>c.retrieval).length;totals.retainedHistory++;
      observations.push(entry);
    }
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
    assert.deepEqual(store.recover(),[]);
  } finally {db.close();}
  const reopened=new Database(path);
  try {
    schemas.applyResearchDatabaseSchema(reopened);
    assert.equal(reopened.prepare('SELECT total_changes()').pluck().get(),0);
    assert.equal(reopened.prepare("SELECT count(*) FROM research_scientific_index_generations WHERE status='active'").pluck().get(),totals.retainedHistory);
  } finally {reopened.close();}
  writeJson(join(trialRoot,'sources.json'),observations);
  const deterministicHash=hash(observations.map(({generations,...row})=>({...row,
    generations:generations===null?null:['retired','failed','active']})));
  trials.push({root:trialRoot,database:{path,sha256:sha256(readFileSync(path))},
    sources:{path:join(trialRoot,'sources.json'),sha256:sha256(readFileSync(join(trialRoot,'sources.json')))},totals,deterministicHash});
}
assert.deepEqual(trials[0].totals,trials[1].totals);
assert.equal(trials[0].deterministicHash,trials[1].deterministicHash);
for(const input of inputs.values()){
  assert.equal(sha256(readFileSync(input.path)),input.sha256);
  assert.equal(statSync(input.path,{bigint:true}).mtimeNs.toString(),input.mtimeNs);
}
writeJson(join(output,'report.json'),{schemaVersion:1,kind:'scientific-generations-saved-ir-storage-regression',
  root:output,sourceReport:{path:sourceReportPath,sha256:sha256(sourceBytes)},workingDirectory:process.cwd(),
  command:process.argv.slice(1),codeHashes,inputs:[...inputs.values()],trials,
  limitations:['Saved original IR/chunks reused; no OCR or embedding provider called.',
    'Deterministic one-hot vectors test storage, configuration and publication only; no semantic or retrieval gain.',
    'Production scheduling and retrieval integration remain a separate delivery. Research72 has no startup migration.']});
console.log(JSON.stringify({root:output,trials:trials.map(({totals,deterministicHash})=>({totals,deterministicHash}))}));
