import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,statSync,copyFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {directory,sha256,writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot,publicScientificSourceLock} from '../evaluation/adapters/scientific-public/sources.mjs';

const reportPath=resolve(process.argv[3]), previous=JSON.parse(readFileSync(reportPath));
const output=directory(resolve(process.argv[2]),'scientific-rollout');
const entry='evaluation/runtime/scientific-rollout-rehearsal.ts', temporary=join(resolve('.runtime/tmp'),`rollout-${Date.now()}.mjs`);
mkdirSync(dirname(temporary),{recursive:true});
const built=await build({entryPoints:[entry],outfile:temporary,bundle:true,format:'esm',platform:'node',packages:'external',
  loader:{'.md':'text','.c':'text'},metafile:true,logLevel:'silent'});
const codeHashes=Object.fromEntries([...new Set([...Object.keys(built.metafile.inputs),'scripts/benchmark-scientific-rollout.mjs','pnpm-lock.yaml'])]
  .sort().map(p=>[p,sha256(readFileSync(p))]));
const inputs=new Map();
function pin(path,expected) {
  path=path instanceof URL ? fileURLToPath(path) : resolve(path);
  const bytes=readFileSync(path),digest=sha256(bytes),stat=statSync(path,{bigint:true});
  if(expected)assert.equal(digest,expected,path);
  inputs.set(path,{path,sha256:digest,mtimeNs:stat.mtimeNs.toString()});return bytes;
}
const lock=JSON.parse(pin(publicScientificSourceLock));pin(reportPath);
for(const p of previous.inputs){pin(p.path,p.sha256);assert.equal(inputs.get(resolve(p.path)).mtimeNs,p.mtimeNs);}
const rows=JSON.parse(pin(join(previous.root,'trial-0.json')));
const cohort=previous.cohorts.find(c=>c.rows===45);assert.ok(cohort);
const sourceRun=JSON.parse(pin(cohort.run));assert.equal(sourceRun.rows.length,45);
const selected=rows.filter(r=>r.cohort===previous.cohorts.indexOf(cohort));assert.equal(selected.length,45);
const prepared=[],copies=[];
function copy(source,target,expected) {
  const bytes=pin(source,expected);mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);
  assert.equal(sha256(readFileSync(target)),sha256(bytes));copies.push({source:resolve(source),path:target,sha256:sha256(bytes)});
}
try {
  for(const row of selected) {
    assert.equal(row.status,'parsed','Retain failures; this locked PDF cohort must be complete');
    const source=sourceRun.rows[row.index],sourcePath=join(defaultPublicScientificRoot,source.source);
    const locked=lock.files.find(p=>p.path===source.source);assert.equal(locked.sha256,source.sourceHash);
    const relativeSource=`sources/${source.paperId}.pdf`;copy(sourcePath,join(output,relativeSource),source.sourceHash);
    const parsed=JSON.parse(pin(join(previous.root,row.contentPath),row.receipt.identity.parseHash));
    pin(join(previous.root,row.receipt.path),row.receipt.sha256);
    const artifactRoot=join(sourceRun.root,dirname(source.structured),'..');
    const relativeOutput=`parser/${source.paperId}`,target=join(output,relativeOutput);
    // Each saved artifact remains immutable. Only the rehearsal receives an explicitly derived structured snapshot.
    for(const name of new Set([...parsed.assets.map(a=>a.path),...Object.values(parsed.artifacts)])) {
      const receipt=source.artifacts.find(a=>a.path===name);assert.ok(receipt,name);
      copy(join(artifactRoot,name),join(target,name),receipt.sha256);
    }
    const structured=JSON.parse(readFileSync(join(target,parsed.artifacts.structuredContent)));
    structured.blocks=parsed.blocks;structured.quality=parsed.quality;
    writeFileSync(join(target,parsed.artifacts.structuredContent),JSON.stringify(structured));
    // Mark the task-created derivative separately from its unchanged original.
    copies.find(c=>c.path===join(target,parsed.artifacts.structuredContent)).derivedSha256=sha256(readFileSync(join(target,parsed.artifacts.structuredContent)));
    prepared.push({paperId:source.paperId,sourcePath:relativeSource,sourceHash:source.sourceHash,outputPath:relativeOutput,parsed});
  }
  const {runScientificRollout}=await import(pathToFileURL(temporary).href);
  const result=await runScientificRollout(realpathSync(output),prepared);
  const resultPath=join(output,'run.json');writeJson(resultPath,result);
  for(const input of inputs.values()) {assert.equal(sha256(readFileSync(input.path)),input.sha256);assert.equal(statSync(input.path,{bigint:true}).mtimeNs.toString(),input.mtimeNs);}
  for(const file of copies)assert.equal(sha256(readFileSync(file.path)),file.derivedSha256??file.sha256);
  const outputs=['run.json','research.db','agent.db','before.db','protected-before.json','protected-after.json'].map(name=>({path:join(output,name),sha256:sha256(readFileSync(join(output,name)))}));
  const counts={papers:result.observations.length,pages:result.observations.reduce((n,r)=>n+r.pdf.pages,0),shadowEvents:result.events.length,
    compared:result.events.filter(e=>e.status==='compared').length,expectedFailures:result.events.filter(e=>e.status==='failed').length,
    retainedEvidence:result.observations.length,retainedWikiRevisions:result.observations.length};
  writeJson(join(output,'report.json'),{version:1,kind:'public45-isolated-rollout-engineering-rehearsal',root:output,
    command:process.argv.slice(1),workingDirectory:process.cwd(),sourceReport:{path:reportPath,sha256:sha256(readFileSync(reportPath))},
    codeHashes,inputs:[...inputs.values()],copies,outputs,counts,
    quality:{recall:null,answerCorrectness:null,realProjectAcceptance:null},
    limitations:['Saved parser outputs reused; current library publication builds owner-bound IR without OCR.',
      'One isolated project contains all45 public PDFs; no real user project or global rollout enabled.',
      'Vectors and provider outages are controlled engineering probes, not semantic quality evidence.',
      'PDF.js reads every page; native renderer preview is outside this rehearsal.',
      'Explicit corruption and repair may repack FTS internal tables; authoritative postings and all other tables are preserved.']});
  console.log(JSON.stringify({root:output,counts}));
} finally {rmSync(temporary,{force:true});}
