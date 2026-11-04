import {spawn} from 'node:child_process';
import {realpath, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import electronPath from 'electron';

const {values}=parseArgs({options:{'models-root':{type:'string'},'evidence-root':{type:'string'}}});
if (values['models-root']===undefined||values['evidence-root']===undefined) throw new Error('scanned_acceptance_requires_models_and_evidence_roots');
const modelsRoot=await realpath(values['models-root']),evidenceRoot=resolve(values['evidence-root']);
await mkdir(evidenceRoot,{recursive:true});
const child=spawn(electronPath,['--test','tests/acceptance/research-pdf-scanned-native.test.mjs'],{
  env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LANGSMITH_TRACING:'false',LANGCHAIN_TRACING_V2:'false',
    ROC_SCAN_MODELS_ROOT:modelsRoot,ROC_SCAN_EVIDENCE_ROOT:await realpath(evidenceRoot)},stdio:'inherit'
});
const {code,signal}=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
});
if(signal!==null) throw new Error(`scanned_acceptance_native_terminated:${signal}`);
process.exitCode=code;
