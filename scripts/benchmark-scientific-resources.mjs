import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {resolve, join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPerformancePdf} from './lib/research-pdf-performance-fixture.mjs';
import {materializeScannedSource} from '../tests/fixtures/research-scanned-source.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {makeReport, sha256, summarizeRows} from './performance/report-lib.mjs';

// Freeze the immediately preceding resource implementation; all transitive src
// modules are read at this commit. Installed dependencies must match its lock.
const baseline = '6d6cb6ae';
const parserPath = 'src/main/plugins/research/document-parser.ts';
const trials = 3;
const scenarios = ['native-400', 'scanned-3'];
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});

async function worker(variant, scenario, root, sourcePath) {
  assert.ok(['before','after'].includes(variant)); assert.ok(scenarios.includes(scenario));
  await mkdir(root, {recursive:true});
  const sourceHashes = {}, bundle = resolve('.runtime/performance', `resource-${process.pid}.mjs`);
  await mkdir(resolve('.runtime/performance'), {recursive:true});
  const compiled = await build({entryPoints:[parserPath], bundle:true, write:false, metafile:true,
    packages:'external', format:'esm', platform:'node', target:'node22', logLevel:'silent',
    plugins:[{name:'frozen-source-and-native-lifecycle-observer',setup(builder) {
      builder.onLoad({filter:/\/src\/.*\.ts$/}, async ({path}) => {
        const name = relative(process.cwd(),path);
        let contents = variant === 'before' ? execFileSync('git',['show',`${baseline}:${name}`],{encoding:'utf8'})
          : await readFile(path,'utf8');
        sourceHashes[name] = sha256(contents);
        if (name === parserPath) {
          assert.equal(contents.split('ort.InferenceSession.create(modelBuffer,').length,3);
          contents = contents.replaceAll('ort.InferenceSession.create(modelBuffer,',
            'globalThis.__rocMeasuredCreate(ort.InferenceSession, modelBuffer,');
        }
        return {contents,loader:'ts'};
      });
    }}]});
  await writeFile(bundle,compiled.outputFiles[0].contents,{flag:'wx'});
  let live=0, highWater=0, created=0, released=0;
  globalThis.__rocMeasuredCreate = async (factory,...args) => {
    const session = await factory.create(...args), release = session.release.bind(session);
    live++; created++; highWater=Math.max(highWater,live);
    let pending;
    session.release = () => pending ??= Promise.resolve().then(release).then(() => {live--;released++;});
    return session;
  };
  let models, lease;
  try {
    const {parseResearchDocument} = await import(pathToFileURL(bundle).href);
    if (scenario === 'scanned-3') {
      const {ResearchModelStore} = await importTypeScriptModule('src/main/plugins/research/model-store.ts',
        {platform:'node',external:['zod'],tempDir:'.runtime/performance'});
      models = new ResearchModelStore(resolve('.runtime/research-models'));
      lease = await models.requireReady('complete');
    }
    const stages=[], started=performance.now(), initial=process.memoryUsage();
    const outputDir=join(root,'output');
    const parsed=await parseResearchDocument({projectRoot:resolve('.'),sourcePath,outputDir,
      options:{tier:'complete',device:'cpu',pageRange:''},modelFiles:lease?.files??null,modelManifest:lease?.manifest??'',
      signal:AbortSignal.timeout(600000),onStage:event=>{
        stages.push({...event,elapsedMs:performance.now()-started,...process.memoryUsage(),liveSessions:live});
      }});
    const elapsedMs=performance.now()-started, final=process.memoryUsage();
    assert.equal(live,0); assert.equal(created,released);
    assert.equal(parsed.pageCount,scenario==='native-400'?400:3);
    assert.equal(parsed.sourceHash,sha256(await readFile(sourcePath)));
    if (scenario==='native-400') {assert.equal(created,0);assert.equal(parsed.parseMode,'native-text');}
    else {assert.ok(created>0);assert.equal(parsed.parseMode,'ocr');}
    const artifacts=[];
    async function inventory(directory) {
      for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
        const path=join(directory,entry.name);
        if (entry.isDirectory()) await inventory(path);
        else artifacts.push({path:relative(outputDir,path),sha256:sha256(await readFile(path))});
      }
    }
    await inventory(outputDir);
    await save(join(root,'parsed.json'),parsed); await save(join(root,'stages.json'),stages);
    const pages=stages.filter(s=>s.stage===(scenario==='native-400'?'native-text':'ocr-inference'));
    const tail=pages.slice(-Math.min(100,pages.length)), tailGrowthBytes=tail.at(-1).rss-tail[0].rss;
    const result={variant,scenario,elapsedMs,peakRssBytes:process.resourceUsage().maxRSS*1024,
      initialRssBytes:initial.rss,finalRssBytes:final.rss,tailGrowthBytes,
      initial,final,created,released,highWater,retained:live,pages:parsed.pageCount,
      behaviorSha256:sha256(JSON.stringify({parsed,artifacts})),sourceHash:parsed.sourceHash,
      modelManifest:parsed.modelManifest,sourceHashes,artifacts,
      limits:'Process RSS includes output, models, allocator caches and instrumentation; sampled page boundaries do not prove absence of all leaks.'};
    await save(join(root,'receipt.json'),result);
    return result;
  } finally {
    if (lease) models.release(lease.pack);
    delete globalThis.__rocMeasuredCreate; await rm(bundle,{force:true});
  }
}

if (process.argv[2]==='--worker') {
  const result=await worker(process.argv[3],process.argv[4],resolve(process.argv[5]),resolve(process.argv[6]));
  console.log(JSON.stringify({result}));
} else {
  assert.equal(process.argv.length,3,'Usage: node scripts/benchmark-scientific-resources.mjs NEW_OUTPUT_DIRECTORY');
  assert.equal(sha256(execFileSync('git',['show',`${baseline}:pnpm-lock.yaml`])),sha256(await readFile('pnpm-lock.yaml')));
  const root=resolve(process.argv[2]); await mkdir(root,{recursive:false});
  const native=join(root,'native-400.pdf'); await writeFile(native,createPerformancePdf(),{flag:'wx'});
  const scanned=await materializeScannedSource(join(root,'scanned'));
  const report=makeReport('scientific-resource-pairs',{baseline,trials,scenarios,
    sourceHashes:{'native-400':sha256(await readFile(native)),'scanned-3':scanned.truth.sourceHash},
    order:'alternating within each scenario',nativeP50MaximumRatio:1.2,ocrP50MaximumRatio:1.5,
    nativeLast100PageRssGrowthBudgetBytes:128*1024*1024},
    [parserPath,'src/main/plugins/research/ocr-stage-sessions.ts','scripts/benchmark-scientific-resources.mjs']);
  const rows=[];
  for (const scenario of scenarios) for(let trial=0;trial<trials;trial++) {
    for (const variant of trial%2===0?['before','after']:['after','before']) {
      const directory=join(root,`${scenario}-${trial}-${variant}`);
      const child=spawn(process.execPath,[import.meta.filename,'--worker',variant,scenario,directory,
        scenario==='native-400'?native:scanned.sourcePath],{stdio:['ignore','pipe','pipe']});
      let stdout='',stderr=''; child.stdout.on('data',v=>{stdout+=v;}); child.stderr.on('data',v=>{stderr+=v;});
      const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
      await writeFile(join(root,`${scenario}-${trial}-${variant}.log`),stdout+'\n'+stderr,{flag:'wx'});
      assert.equal(code,0,stderr);
      const result=JSON.parse(stdout.trim().split('\n').at(-1)).result;
      rows.push({...result,trial});
      console.log(JSON.stringify({scenario,trial,variant,elapsedMs:result.elapsedMs,highWater:result.highWater,peakRssBytes:result.peakRssBytes}));
    }
  }
  for(const scenario of scenarios) {
    const selected=rows.filter(r=>r.scenario===scenario);
    assert.equal(new Set(selected.map(r=>r.behaviorSha256)).size,1,'paired parser outputs changed');
    for(const variant of ['before','after']) {
      const samples=selected.filter(r=>r.variant===variant);
      report.scenarios.push({id:`${scenario}-${variant}`,samples,summary:summarizeRows(samples)});
    }
  }
  report.limitations.push('Three alternating fresh-process pairs are engineering observations, not statistical proof.',
    'Same locked dependencies, real CPU models and original inputs. No OS cache flush, no forced GC.',
    'Controlled raster source is not chart-dense scientific gold. Quality scores remain unknown.',
    'Memory budget is an explicit bounded-growth screen for native400, not a zero-growth claim.');
  await save(join(root,'report.json'),report);
  const failures=[];
  for(const [scenario,ratio] of [['native-400',1.2],['scanned-3',1.5]]) {
    const before=report.scenarios.find(s=>s.id===`${scenario}-before`).summary;
    const after=report.scenarios.find(s=>s.id===`${scenario}-after`).summary;
    if(after.elapsedMs.p50>before.elapsedMs.p50*ratio) failures.push(`${scenario}:latency`);
    if(scenario==='native-400'&&after.tailGrowthBytes.max>128*1024*1024) failures.push(`${scenario}:memory`);
  }
  await save(join(root,'assessment.json'),{failures});
  assert.deepEqual(failures,[],'resource budgets exceeded; preserve report and investigate');
}
