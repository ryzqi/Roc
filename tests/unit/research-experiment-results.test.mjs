import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const missing={kind:'unavailable',reason:'The analysis did not estimate this quantity'};
const metric={id:'mean',value:-2,unit:'ms',sampleSize:3,uncertainty:{kind:'recorded',type:'standard_error',value:0.5},
  confidenceInterval:{kind:'recorded',lower:-3,upper:-1,confidence:0.95},effect:missing};

test('result schema preserves negative estimates and explicit unavailable quantities, rejecting omitted, invented and nonfinite measurements',()=>{
  const result={schemaVersion:1,metrics:[metric]};
  assert.deepEqual(api.researchExperimentResultFileSchema.parse(result),result);
  for(const invalid of [
    {...metric,value:Infinity},{...metric,sampleSize:0},{...metric,sampleSize:3.2},
    {...metric,uncertainty:{kind:'recorded',type:'standard_error',value:-1}},
    {...metric,confidenceInterval:{kind:'recorded',lower:2,upper:1,confidence:0.95}},
    {...metric,confidenceInterval:{kind:'recorded',lower:1,upper:2,confidence:1}},
    {...metric,effect:{kind:'unavailable',reason:''}},{...metric,significant:true}
  ]) assert.equal(api.researchExperimentResultFileSchema.safeParse({schemaVersion:1,metrics:[invalid]}).success,false);
  for(const field of ['value','unit','sampleSize','uncertainty','confidenceInterval','effect']) {
    const {[field]:_value,...incomplete}=metric;
    assert.equal(api.researchExperimentResultFileSchema.safeParse({schemaVersion:1,metrics:[incomplete]}).success,false);
  }
  assert.equal(api.researchExperimentResultFileSchema.safeParse({...result,metrics:[metric,metric]}).success,false);
  assert.equal(api.researchExperimentResultFileSchema.safeParse({...result,schemaVersion:2}).success,false);
});

function receipt(id,changes={}) {
  return {snapshotHash:id.repeat(64),snapshot:{
    request:{definitions:[{id:'mean',label:'Mean',definition:'Arithmetic mean of declared observations',unit:'ms',direction:'lower'}],
      method:{name:'Sample mean',rationale:'All observations',assumptions:'Independent samples',limitations:'Engineering fixture'}},
    result:{metrics:[metric]},
    execution:{inputs:[{area:'input',path:'data.txt',sha256:'0'.repeat(64),size:5}],environmentHash:'e'.repeat(64),
      engine:'python',parameters:{alpha:'1',beta:'2'},arguments:[],seed:73},
    ...changes
  }};
}
test('comparison refuses every changed dimension and compares canonical parameter and data ordering without choosing a winner',async()=>{
  const left=receipt('a'),right=structuredClone(left);right.snapshotHash='b'.repeat(64);
  const service=new api.ResearchExperimentResultService({},{}),request={projectId:'project',
    left:{resultId:'left',expectedHash:left.snapshotHash},right:{resultId:'right',expectedHash:right.snapshotHash}};
  service.get=async input=>input.resultId==='left'?left:right;
  assert.deepEqual((await service.compare(request)).differences,[]);
  right.snapshot.execution.parameters={beta:'2',alpha:'1'};
  assert.equal((await service.compare(request)).comparable,true);
  const cases=[
    ['data',s=>s.execution.inputs[0].sha256='f'.repeat(64)],
    ['metric_definitions',s=>s.request.definitions[0].definition='Median of declared observations'],
    ['units',s=>s.result.metrics[0].unit='s'],
    ['environment',s=>s.execution.environmentHash='f'.repeat(64)],
    ['environment',s=>s.execution.engine='r'],
    ['parameters',s=>s.execution.parameters.alpha='3'],
    ['parameters',s=>s.execution.arguments=['changed']],
    ['seed',s=>s.execution.seed=74],
    ['method',s=>s.request.method.name='Changed statistical method']
  ];
  for(const [dimension,change] of cases) {
    right.snapshot=structuredClone(left.snapshot);change(right.snapshot);
    const result=await service.compare(request);
    assert.equal(result.comparable,false);assert.deepEqual(result.differences,[dimension]);
    assert.equal('winner' in result,false);
  }
});

test('result capabilities preserve explicit contract and source failures over IPC while unknown failures remain internal',async()=>{
  const handlers=new Map();
  let failure=new Error('research_result_output_changed');
  const action=()=>{throw failure;};
  api.registerResearchExperimentResultCapabilities({
    pluginId:'fixture',capabilities:{register(_id,descriptor,handler){handlers.set(descriptor.name,handler);}}
  },{list:action},{review:action,get:action,compare:async()=>action()});
  const bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>handlers.get(name)(input)});
  const request={projectId:'project',resultId:'result',expectedHash:'a'.repeat(64)};
  for(const [error,code,category] of [
    [new Error('research_result_output_changed'),'research_result_output_changed','conflict'],
    [new Error('research_experiment_snapshot_changed'),'research_experiment_snapshot_changed','degraded'],
    [new Error('research_human_required'),'research_human_required','permission'],
    [new Error('research_result_not_found'),'research_result_not_found','not_found'],
    [new Error('research_result_definition_mismatch'),'research_result_definition_mismatch','validation'],
    [new SyntaxError('invalid JSON'),'research_result_contract_invalid','validation'],
    [Object.assign(new Error('missing'),{code:'ENOENT'}),'research_result_file_missing','not_found'],
    [Object.assign(new Error('denied'),{code:'EPERM'}),'research_result_file_denied','permission'],
    [new Error('unexpected implementation defect'),'internal_error','internal']
  ]) {
    failure=error;
    const response=await bridge.invoke('research.getExperimentResult',[request],72);
    assert.equal(response.ok,false);
    assert.equal(response.error.code,code);
    assert.equal(response.error.category,category);
    assert.equal(response.error.retryable,false);
  }
  await assert.rejects(()=>handlers.get('research.experimentResults.get')({projectId:'project'}),
    {code:'research_result_contract_invalid',category:'validation'});
});
