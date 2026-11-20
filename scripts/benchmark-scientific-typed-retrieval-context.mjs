import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const repo=resolve('.'),task=resolve('.artifacts/scientific-rag/phase8-typed-retrieval-context-01');
const old=resolve('.artifacts/scientific-rag/phase8-matched-retrieval-context-01');
const irRoot=resolve('.artifacts/scientific-rag/phase2-public-01/paper-ir-public-2026-11-16T13-36-53.200Z-2fc98ebd');
const originalDb=resolve('.artifacts/scientific-rag/baselines/sciegqa-retrieval-01/sciegqa-bm25-2026-11-16T08-39-28.605Z-24fc3a1e/research.sqlite');
const root=join(task,process.argv[2]??'run-01');
assert.ok(root.startsWith(task+'/')&&dirname(root)===task);
assert.ok(!existsSync(root),'Use a fresh run directory; retain failures');
mkdirSync(root);mkdirSync(join(root,'code'));mkdirSync(join(root,'runtime'));
// SQLite caches temp-directory candidates at native initialization. Configure
// its writable boundary before the first connection, including the source DB.
const sqliteTmp=join(root,'sqlite-tmp'),previousSqliteTmp=process.env.SQLITE_TMPDIR??null;
mkdirSync(sqliteTmp);process.env.SQLITE_TMPDIR=sqliteTmp;
const sha=b=>createHash('sha256').update(b).digest('hex');
const write=(path,v)=>writeFileSync(path,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const pins=new Map(),copies=[],derivedStructured=[];
let networkAttempts=0;
const rejectNetwork=()=>{networkAttempts++;throw new Error('typed_network_forbidden');};
globalThis.fetch=rejectNetwork;http.request=http.get=https.request=https.get=rejectNetwork;net.Socket.prototype.connect=rejectNetwork;
function pin(path,expected) {
  path=resolve(path);const b=readFileSync(path),s=statSync(path,{bigint:true}),h=sha(b);
  if(expected)assert.equal(h,expected,path);
  pins.set(path,{path,bytes:b.length,sha256:h,mtimeNs:String(s.mtimeNs)});return b;
}
const read=(p,h)=>JSON.parse(pin(p,h));
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):e.isFile()?[join(p,e.name)]:[]);
function copy(src,dst,expected) {
  const b=pin(src,expected);mkdirSync(dirname(dst),{recursive:true});copyFileSync(src,dst);
  assert.equal(sha(readFileSync(dst)),sha(b));copies.push({source:resolve(src),path:relative(root,dst),bytes:b.length,sha256:sha(b)});
}
try {
  const snapshot=process.argv[3]?resolve(task,process.argv[3]):null;
  if(snapshot)assert.ok(snapshot.startsWith(task+'/')&&snapshot!==root,'Frozen code must be in the task artifact tree');
  const frozen=snapshot?read(join(snapshot,'source-freeze.json')):null;
  const productionPaths=frozen?frozen.files.map(p=>p.path):[
    ...walk(join(repo,'src')).map(p=>relative(repo,p)),
    'resources/research-runtime/process-guard.lock.json','resources/research-skills/catalog.json',
    'package.json','pnpm-lock.yaml','tsconfig.json'];
  const productionPins=[];
  for(const path of productionPaths) {
    assert.ok((path.startsWith('src/')||path.startsWith('resources/')||
      ['package.json','pnpm-lock.yaml','tsconfig.json'].includes(path))&&!path.split('/').includes('..'));
    const source=join(snapshot??repo,path),expected=frozen?.files.find(p=>p.path===path);
    copy(source,join(root,'code',path),expected?.sha256);
    productionPins.push({path,bytes:readFileSync(join(root,'code',path)).length,sha256:sha(readFileSync(join(root,'code',path)))});
  }
  assert.equal(new Set(productionPaths).size,productionPaths.length);
  assert.ok(productionPaths.some(p=>p.startsWith('src/')));
  for(const p of productionPins)assert.equal(sha(readFileSync(join(snapshot??repo,p.path))),p.sha256,'Concurrent source freeze drift');
  const sourceFreeze={version:1,snapshot,files:productionPins,createdAt:new Date().toISOString(),
    contract:'Build only from run-local copied production src/resources; live src and git HEAD are not subsequent inputs.'};
  write(join(root,'source-freeze.json'),sourceFreeze);
  const toolPaths=['scripts/benchmark-scientific-typed-retrieval-context.mjs',
    'evaluation/runtime/production-scientific-typed-ablation.ts','scripts/verify-scientific-typed-retrieval-context.mjs'];
  for(const path of toolPaths)copy(join(repo,path),join(root,'code',path));
  console.log(JSON.stringify({stage:'code-frozen',root,files:productionPins.length,
    sha256:sha(readFileSync(join(root,'source-freeze.json')))}));
  const previous=read(join(irRoot,'report.json')),rows=read(join(irRoot,'trial-0.json'));
  const lock=read('evaluation/corpora/scientific-rag/public-sources.lock.json');
  const qasperLock=read('evaluation/lib/sources.lock.json').qasper;
  pin('evaluation/local/sources/qasper/v0.3-dev/source.tgz',qasperLock.archiveSha256);
  const rawPath='evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0/qasper-dev-v0.3.json';
  const raw=read(rawPath,qasperLock.memberSha256);
  const baselineRun=read(previous.cohorts[1].run);
  const irRows=rows.filter(r=>r.cohort===1);
  assert.equal(irRows.length,45);assert.equal(new Set(irRows.map(r=>r.sourceHash)).size,45);
  assert.deepEqual(baselineRun.rows.map(r=>r.paperId).sort(),[...lock.qasper.pdfCohort].sort());
  const oldCohort=read('evaluation/corpora/scientific-rag/sciegqa-cohort.lock.json');
  const oldLabels=read('evaluation/local/corpora/sciegqa-bench-v1/labels.json');
  const oldProtocol=read(join(old,'run-04/protocol.json'));
  for(const f of ['run.mjs','runtime.ts','verify.mjs','sealed-manifest.json','sealed-manifest.sha256','seal-summary.json'])pin(join(old,f));
  const db=new Database(originalDb,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  const originalCounts={documents:db.prepare('SELECT count(*) FROM research_knowledge_documents').pluck().get(),
    embeddings:db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get()};db.close();pin(originalDb);
  const sourceCohortMapping=oldCohort.papers.map(p=>({paperId:p.id,sourceHash:p.pdf.sha256,
    status:irRows.some(r=>r.sourceHash===p.pdf.sha256)?'mapped':'unavailable',
    reason:'No identical source hash in frozen phase2 QASPER45; no substitution',
    questions:oldProtocol.questions.filter(q=>q.paperId===p.id)}));
  assert.equal(sourceCohortMapping.filter(r=>r.status==='mapped').length,0);
  assert.equal(sourceCohortMapping.flatMap(r=>r.questions).length,225);
  // Select every original question, including unsupported/unanswerable originals.
  // Selection is independent of saved candidate/model outputs.
  const questions=irRows.flatMap(r=>{
    const p=baselineRun.rows[r.index];assert.equal(p.sourceHash,r.sourceHash);
    return raw[p.paperId].qas.map((q,index)=>({id:q.question_id,paperId:p.paperId,publishedQuery:q.question,
      unqualified:true,originalQuestionIndex:index}));
  });
  assert.equal(questions.length,288);assert.equal(new Set(questions.map(q=>q.id)).size,288);
  const inputs=[],objects=[],papers=[];
  for(const r of irRows) {
    const p=baselineRun.rows[r.index];
    const base={paperId:p.paperId,status:r.status,sourceHash:r.sourceHash,failure:r.failure,
      originalIR:r.receipt,contentPath:r.contentPath};
    papers.push(base);
    if(r.status!=='parsed')continue;
    const ir=read(join(irRoot,r.receipt.path),r.receipt.sha256);
    const parsed=read(join(irRoot,r.contentPath),r.receipt.identity.parseHash);
    assert.equal(ir.identity.paperId,p.paperId);assert.equal(ir.identity.sourceHash,r.sourceHash);
    for(const [plural,type] of Object.entries({tables:'table',figures:'figure',equations:'equation',algorithms:'algorithm'}))
      for(const o of ir[plural])objects.push({paperId:p.paperId,type,blockId:o.blockId,objectId:o.id});
    const sourcePath=`sources/paper-${r.index}.pdf`,outputPath=`parser/paper-${r.index}`;
    const sourcePin=lock.files.find(f=>f.path===p.source&&f.sha256===r.sourceHash);assert.ok(sourcePin);
    copy(join('evaluation/local/sources/scientific-public',p.source),join(root,sourcePath),r.sourceHash);
    // Copy the original artifact payload, never regenerate OCR/assets.
    const artifactRoot=resolve(baselineRun.root,dirname(p.structured),'..');
    for(const name of new Set([...parsed.assets.map(a=>a.path),...Object.values(parsed.artifacts)])) {
      assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
      const receipt=p.artifacts.find(a=>a.path===name);assert.ok(receipt,name);
      if(name===parsed.artifacts.structuredContent) {
        const original=read(join(artifactRoot,name),receipt.sha256);
        copy(join(artifactRoot,name),join(root,outputPath,name+'.original.json'),receipt.sha256);
        // Saved phase2 IR added typed blocks/quality after the old parser saved
        // structured.json. Rebind only this task's publication input to those
        // already frozen values. Original pages/assets remain byte-pinned.
        const adapted={...original,blocks:parsed.blocks,quality:parsed.quality};
        const path=join(outputPath,name);write(join(root,path),adapted);
        derivedStructured.push({paperId:p.paperId,path,originalPath:join(outputPath,name+'.original.json'),
          savedContentPath:resolve(irRoot,r.contentPath),sha256:sha(readFileSync(join(root,path)))});
      } else copy(join(artifactRoot,name),join(root,outputPath,name),receipt.sha256);
    }
    pin(join(baselineRun.root,p.result));
    inputs.push({id:p.paperId,title:raw[p.paperId].title,sourceHash:r.sourceHash,sourceUri:null,
      parsed,resultHash:r.receipt.identity.parseHash,parseId:`typed-public:${p.paperId}:${r.receipt.identity.parseHash}`,
      sourcePath,outputPath});
  }
  assert.equal(objects.length,483);assert.equal(inputs.length,45);
  const codeRoot=join(root,'code');
  const built=await build({absWorkingDir:codeRoot,entryPoints:[join(codeRoot,'evaluation/runtime/production-scientific-typed-ablation.ts')],bundle:true,write:false,
    outfile:join(root,'runtime/typed.mjs'),platform:'node',format:'esm',target:'node22',packages:'external',
    loader:{'.md':'text','.c':'text'},metafile:true,logLevel:'silent'});
  const codePins=[];
  for(const path of [...new Set([...Object.keys(built.metafile.inputs),...toolPaths,'package.json','pnpm-lock.yaml','tsconfig.json'])].sort()) {
    const absolute=resolve(codeRoot,path);assert.ok(absolute.startsWith(codeRoot+'/'),'Build input escaped frozen code: '+path);
    const b=readFileSync(absolute);
    codePins.push({path:relative(codeRoot,absolute),bytes:b.length,sha256:sha(b)});
  }
  writeFileSync(join(root,'runtime/typed.mjs'),built.outputFiles[0].contents,{flag:'wx'});
  const protocol={version:2,createdAt:new Date().toISOString(),workingDirectory:repo,command:process.argv,
    kind:'typed-public-D/F-engineering',sourceReport:join(irRoot,'report.json'),irRoot,rawQuestionsPath:resolve(rawPath),
    publicLockPath:resolve('evaluation/corpora/scientific-rag/public-sources.lock.json'),
    papers,questions,objects,sourceCohortMapping,originalCounts,sourcePins:[...pins.values()],copies,derivedStructured,codePins,
    bundleSha256:sha(built.outputFiles[0].contents),nodeVersion:process.version,
    sourceFreezeSha256:sha(readFileSync(join(root,'source-freeze.json'))),
    environment:{sqliteTmp,previousSqliteTmp,configuredBeforeFirstConnection:true,
      sandboxPolicy:'Unchanged offline-parent.sb; SQLite temp files remain inside the task artifact tree'},
    completionContract:'complete-observations-seed45-error0-D288-success-per-arm-v1',
    controls:{query:'Unchanged original QASPER question, trimmed by production request schema',limit:20,candidateLimit:80,
      keyword:true,embedding:null,rerank:'none',provider:null,model:null,ocr:false,repeats:1,
      commonChunks:'All retrievable current generation chunks projected verbatim to generic',
      D:'Generic and actual ScientificRetrievalRouter; overall router difference only',
      F:'First source-bound scientific top20; generic8000chars/no neighbors, scientific7000tokens/1object/1paragraph/0images; whole output8000tokens',
      objectF:'All483 source IR objects retained; first original-order question whose real candidates include object block/type, first such candidate; same F budgets; outside-top20 explicit',
      sourceAdapter:'Task structured input overlays frozen phase2 blocks/quality on byte-pinned original pages; production collectDocumentContent binds imagePath to copied asset IDs; locator identities/metadata rebound at publication'},
    scientificMetrics:null,answerMetrics:null,qualityGold:null,scientificE2E:false};
  write(join(root,'protocol.json'),protocol);
  write(join(root,'protocol-lock.json'),{sha256:sha(readFileSync(join(root,'protocol.json'))),
    lockedAt:new Date().toISOString(),beforeDatabaseAndSearch:true});
  console.log(JSON.stringify({stage:'locked',papers:papers.length,questions:questions.length,objects:objects.length,
    sourceCohortMappingUnavailable:45,pins:pins.size}));
  const {runMatched}=await import(pathToFileURL(join(root,'runtime/typed.mjs')).href);
  const result=await runMatched(root,inputs,questions,true,objects);
  const changed=[];
  for(const p of pins.values()) {
    const b=readFileSync(p.path),s=statSync(p.path,{bigint:true});
    if(b.length!==p.bytes||sha(b)!==p.sha256||String(s.mtimeNs)!==p.mtimeNs)changed.push(p.path);
  }
  write(join(root,'source-readback.json'),{checked:pins.size,changed,sourceUnchanged:!changed.length});
  // Read the complete persisted observations before deciding completion. Seed
  // and request failures must remain inspectable and must never produce exit 0.
  const seed=JSON.parse(readFileSync(join(root,'seed.json')));
  const dr=JSON.parse(readFileSync(join(root,'d-report.json'))),fr=JSON.parse(readFileSync(join(root,'f-report.json')));
  const dRows=questions.map((_,i)=>JSON.parse(readFileSync(join(root,`d-query-${i}.json`))));
  const fRows=questions.map((_,i)=>JSON.parse(readFileSync(join(root,`f-query-${i}.json`))));
  const objectRows=objects.map((_,i)=>JSON.parse(readFileSync(join(root,`f-object-${i}.json`))));
  const successful=o=>o?.error===null&&o.result!==null&&o.result!==undefined;
  const dSuccess=Object.fromEntries(['generic','scientific'].map(arm=>[arm,dRows.filter(r=>successful(r[arm])).length]));
  const failures=[];
  if(seed.seeded.length!==45||seed.seedErrors.length!==0)failures.push('seed45-error0');
  if(new Set(seed.seeded.map(s=>s.paperId)).size!==45)failures.push('unique45-seeds');
  if(dRows.length!==288||dSuccess.generic!==288||dSuccess.scientific!==288)failures.push('all-D-requests-successful');
  for(const arm of ['generic','scientific'])if(dr[arm].requests!==288||dr[arm].errors!==0)failures.push('D-report-'+arm);
  if(fr.query.rows!==288||fr.objects.rows!==483||fRows.length!==288||objectRows.length!==483)failures.push('complete-F-denominators');
  for(const [i,row] of dRows.entries())if(JSON.stringify(row.question)!==JSON.stringify(questions[i]))failures.push('D-question-order-'+i);
  for(const [i,row] of fRows.entries())if(JSON.stringify(row.question)!==JSON.stringify(questions[i]))failures.push('F-question-order-'+i);
  for(const [i,row] of objectRows.entries())if(JSON.stringify(row.selection.object)!==JSON.stringify(objects[i]))failures.push('F-object-order-'+i);
  if(changed.length||networkAttempts||dr.providerAttempts||!dr.totalChangesUnchanged||dr.dbBeforeSha256!==dr.dbAfterSha256)
    failures.push('source-network-provider-readonly');
  const gate={version:1,contract:protocol.completionContract,observationsWritten:true,seeded:seed.seeded.length,
    seedErrors:seed.seedErrors.length,dRows:dRows.length,dSuccess,fQueryRows:fRows.length,fObjectRows:objectRows.length,
    passed:failures.length===0,failures};
  write(join(root,'completion-gate.json'),gate);
  assert.ok(gate.passed,'typed_completion_gate_failed: '+failures.join(','));
  write(join(root,'completion.json'),{result,sourceUnchanged:true,productionWrites:0,indexRefreshOriginal:0,
    modelCalls:0,networkCalls:0,networkAttempts,ocrCalls:0,scientificMetrics:null,scientificE2E:false,
    completionGateSha256:sha(readFileSync(join(root,'completion-gate.json')))});
  console.log(JSON.stringify({stage:'complete',root,d:result.d}));
}catch(e) {
  write(join(root,'failure.json'),{name:e.name,code:e.message,sqliteCode:e.code??null,stack:e.stack});
  console.error(e.stack);process.exitCode=1;
}
