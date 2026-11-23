import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {createReactProfileCollector, createIpcProfileCollector} from '../../scripts/performance/profiling/collectors.mjs';
import {rendererProfilingPlugin, preloadProfilingPlugin, profilingBoundaries} from '../../scripts/performance/profiling/build-plugin.mjs';
import {summarizeProfileRuns} from '../../scripts/performance/profiling/summarize-runs.mjs';

const profileRun = (duration = 5, calls = 2) => ({kind:'macos-app', protocolSha256:'protocol', fixtureSha256:'fixture',
  source:{gitSha:'commit', sourceSha256:'built-source', lockSha256:'lock'},
  host:{identitySha256:'host', display:[{width:1440,height:900,scaleFactor:2}]},
  fixture:{buildMode:'react-production-profiling', samples:1, idleMinutes:0,
    appBuildDir:'.roc-profile-fixture', uiWorkloads:{sustainedStream:null}},
  scenarios:[{id:'workload',measurement:{buildMode:'react-production-profiling',
    reactProfile:{rootCommits:2,boundaries:[{id:'root',commits:2,actualRenderMs:duration,maxActualRenderMs:duration}]},
    ipcProfile:{calls,channels:calls ? [{channel:'read',calls,fulfilled:calls,rejected:0,inFlight:0}] : []}}}]});

test('React measurements keep inclusive boundaries separate, bounded and inactive outside the window', () => {
  let time = 0;
  const profile = createReactProfileCollector({now:()=>time, slowestLimit:2});
  profile.onRender('root','mount',100,100,0,0);
  assert.equal(profile.snapshot().rootCommits,0);
  profile.begin('synthetic-workload');
  for (const duration of [1,2,3]) profile.onRender('root','update',duration,10,time++,time);
  profile.onRender('canvas','nested-update',2,8,1,2);
  const result = profile.end();
  assert.equal(result.rootCommits,3);
  assert.equal(result.boundaries[0].actualRenderMs,6);
  assert.deepEqual(result.boundaries[0].slowest.map(row=>row.actualRenderMs),[3,2]);
  assert.equal(result.boundaries[1].actualRenderMs,2);
  result.boundaries[0].phases.update = 100;
  profile.onRender('root','update',999,999,1,2);
  assert.equal(profile.snapshot().boundaries[0].phases.update,3);
  profile.begin('next');
  assert.equal(profile.snapshot().rootCommits,0);
});

test('IPC observations preserve promise identity, values and errors without retaining payloads', async () => {
  let time = 0;
  const requests = [];
  const profile = createIpcProfileCollector((channel,argument) => {
    let resolve, reject;
    const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
    requests.push({channel,argument,promise,resolve,reject});
    return promise;
  }, {now:()=>time});
  const inactive = profile.invoke('outside','private-argument');
  requests[0].resolve('outside'); await inactive;
  assert.equal(profile.snapshot().calls,0);
  profile.begin('requests');
  const success = profile.invoke('documents.read',{content:'private-argument'});
  const failure = profile.invoke('documents.read','private-argument');
  assert.equal(success,requests[1].promise);
  time = 20;
  const reply = {ok:false,error:{message:'private-response'}};
  requests[1].resolve(reply);
  assert.equal(await success,reply);
  const error = new Error('private-error');
  const rejected = assert.rejects(failure,value=>value===error);
  time = 30;
  requests[2].reject(error); await rejected;
  const result = profile.end();
  assert.deepEqual(result.channels,[{channel:'documents.read',calls:2,fulfilled:1,rejected:1,applicationFailures:1,
    inFlight:0,maxInFlight:2,completedRoundTripMs:50,maxRoundTripMs:30}]);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('unfinished IPC replies stay pending in the closed window and cannot leak into the next epoch', async () => {
  let complete;
  const promise = new Promise(resolve=>{complete=resolve;});
  const profile = createIpcProfileCollector(()=>promise);
  profile.begin('first'); profile.invoke('slow');
  assert.equal(profile.end().channels[0].inFlight,1);
  profile.begin('second'); complete({ok:true}); await promise;
  assert.equal(profile.end().calls,0);
});

test('synchronous IPC errors remain errors and are accounted for', () => {
  const error = new Error('transport unavailable');
  const profile = createIpcProfileCollector(()=>{throw error;});
  profile.begin('failure');
  assert.throws(()=>profile.invoke('channel'),value=>value===error);
  assert.equal(profile.end().channels[0].rejected,1);
});

test('dedicated build rejects missing or drifted boundaries and verifies the actual profiling reconciler', () => {
  const root = process.cwd(), emitted = [], plugin = rendererProfilingPlugin(root);
  assert.equal(plugin.transform('ordinary module',resolve(root,'src/renderer/other.tsx')),null);
  assert.throws(()=>plugin.transform('export const App = () => null',resolve(root,'src/renderer/App.tsx')),/profiling_export_changed/u);
  assert.throws(()=>plugin.generateBundle({},{}),/profiling_boundary_not_built/u);
  for (const [file,symbol,boundary] of profilingBoundaries) {
    const transformed = plugin.transform(`export function ${symbol}() {return null;}`,resolve(root,file));
    assert.ok(transformed.code.includes(`rocProfileComponent("${boundary}", RocOriginal_${symbol})`));
  }
  assert.throws(()=>plugin.generateBundle({},{}),/react_profiling_reconciler_missing/u);
  plugin.generateBundle.call({emitFile:file=>emitted.push(file)}, {}, {react:{type:'chunk',modules:{
    '/node_modules/react-dom/cjs/react-dom-profiling.profiling.js':{renderedLength:100}
  }}});
  const proof = JSON.parse(emitted[0].source);
  assert.equal(proof.reconciler,'react-dom-profiling.profiling.js');
  assert.equal(proof.boundaries.length,10);
  const preload = preloadProfilingPlugin(root);
  assert.throws(()=>preload.generateBundle(),/profiling_preload_not_built/u);
  const result = preload.transform('const reply = ipcRenderer.invoke("documents.read", input);',resolve(root,'src/preload/ipc-api-generated.ts'));
  assert.ok(result.code.includes('profileInvoke("documents.read", input)'));
  preload.generateBundle();
});

test('profile summaries use one total per independent workload run and keep zero-call channels', () => {
  const summary = summarizeProfileRuns([profileRun(5,2),profileRun(10,0)]);
  assert.deepEqual(summary[0].summary.rootActualRenderMs,{count:2,min:5,p50:5,p95:10,max:10});
  assert.equal(summary[0].ipcChannels[0].calls.p50,0);
  assert.equal(summary[0].ipcChannels[0].calls.count,2);
  assert.equal(summary[0].boundaries[0].actualRenderMs.count,2);
  assert.throws(()=>summarizeProfileRuns([profileRun(5,2),{...profileRun(),scenarios:[]}]),/profiling_scenario_mismatch/u);
});

test('profile summaries refuse source, host, fixture, build and protocol drift between rounds', () => {
  for (const [change, error] of [
    [run=>{run.source.gitSha='other';}, /profiling_source_mismatch:gitSha/u],
    [run=>{run.source.sourceSha256='other-build';}, /profiling_source_mismatch:sourceSha256/u],
    [run=>{run.source.lockSha256='other-lock';}, /profiling_source_mismatch:lockSha256/u],
    [run=>{run.protocolSha256='other';}, /profiling_identity_mismatch:protocolSha256/u],
    [run=>{run.fixtureSha256='other';}, /profiling_identity_mismatch:fixtureSha256/u],
    [run=>{run.host.display[0].scaleFactor=1;}, /profiling_host_mismatch/u],
    [run=>{run.host.identitySha256='other';}, /profiling_host_mismatch/u],
    [run=>{run.fixture.appBuildDir='.roc-profile-other';}, /profiling_fixture_mismatch/u],
    [run=>{run.rendererBuild={manifestSha256:'other'};}, /profiling_renderer_build_mismatch/u]
  ]) {
    const changed=profileRun(); change(changed);
    assert.throws(()=>summarizeProfileRuns([profileRun(),changed]),error);
  }
});

test('profile summaries reject failed, partial, unidentified or non-profiled input', () => {
  for (const [change, error] of [
    [run=>{run.failedWorkload={id:'workload'};}, /profiling_run_failed_or_incomplete/u],
    [run=>{run.failure={error:'failed'};}, /profiling_run_failed_or_incomplete/u],
    [run=>{run.status='incomplete';}, /profiling_run_failed_or_incomplete/u],
    [run=>{delete run.source.sourceSha256;}, /profiling_source_missing:sourceSha256/u],
    [run=>{run.protocolSha256='';}, /profiling_identity_missing:protocolSha256/u],
    [run=>{run.host.display=null;}, /profiling_display_missing/u],
    [run=>{run.kind='other';}, /profiling_kind_mismatch/u],
    [run=>{run.fixture.buildMode='production';}, /profiling_build_mode_mismatch/u],
    [run=>{run.fixture.samples=5;}, /profiling_child_samples_must_be_one/u],
    [run=>{run.fixture.idleMinutes=30;}, /profiling_run_contains_idle/u],
    [run=>{run.fixture.uiWorkloads.sustainedStream={minutes:30};}, /profiling_run_contains_soak/u]
  ]) {
    const changed=profileRun(); change(changed);
    assert.throws(()=>summarizeProfileRuns([changed]),error);
  }
});
