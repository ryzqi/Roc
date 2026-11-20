import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {_electron as electron} from '@playwright/test';
import Database from 'better-sqlite3';
import {applicationIdentity} from './database/verify-research-migration-startup.mjs';

// Diagnostic pilot only: real desktop Agent Runtime; no reference answers enter input.
const root=resolve(process.argv[2]), output=resolve(process.argv[3]), inputPath=resolve(process.argv[4]);
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const receipt=JSON.parse(readFileSync(join(root,'project-receipt.json'))), inputs=JSON.parse(readFileSync(inputPath));
mkdirSync(output,{recursive:false});
assert.equal(inputs.length,3);
assert.equal(new Set(inputs.map(i=>i.id)).size,inputs.length);
for(const item of inputs)assert.match(item.id,/^[a-zA-Z0-9_-]+$/u);
const backup=async(source,name)=>{
  const db=new Database(source,{readonly:true}),path=join(output,name);
  try{await db.backup(path);}finally{db.close();}
  return {path,sha256:digest(path)};
};
const before=await backup(receipt.database,'before.db');
const provider={id:'public-paper-local',name:'Public paper local model',type:'openai_compatible',
  endpoint:'http://127.0.0.1:3425/v1',credentialRef:'secret:public-paper-local',enabled:true,
  models:[{id:'group/deepseek',displayName:'group/deepseek',enabled:true,supportsStreaming:true,supportsToolCalls:true,supportsImages:false}]};
const manifest={version:1,kind:'diagnostic-pilot',input:{path:inputPath,sha256:digest(inputPath)},
  buildHash:applicationIdentity(),scriptHash:digest('scripts/run-scientific-agent-pilot.mjs'),provider,
  projectId:receipt.projectId,receipt:{path:join(root,'project-receipt.json'),sha256:digest(join(root,'project-receipt.json'))},
  before,trials:inputs,timeoutMs:240000,
  limitations:['One isolated project, fresh conversation per trial; not the complete paired scientific E2E suite.',
    'Controlled saved vectors with unavailable fixture transport; no semantic vector quality claim.',
    'Normal app background PaperCard generation may run after model configuration; retained in database snapshots.']};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const env={...process.env,ROC_DATA_ROOT:receipt.dataRoot};
for(const key of ['ROC_SMOKE','ROC_SMOKE_API_KEY','ELECTRON_RENDERER_URL','ELECTRON_RUN_AS_NODE']) delete env[key];
let app,active;
try {
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),
    args:[resolve('dist/main/index.js'),'--user-data-dir='+join(root,'chromium')],env,timeout:60000});
  app.process().stderr.on('data',d=>appendFileSync(join(output,'stderr.log'),d));
  const page=await app.firstWindow();await page.getByTestId('portal').waitFor({timeout:60000});
  const call=async(area,method,input)=>{
    const result=await page.evaluate(async({area,method,input})=>input===undefined
      ? await window.roc[area][method]() : await window.roc[area][method](input),{area,method,input});
    assert.equal(result.ok,true,area+'.'+method+':'+JSON.stringify(result.error));return result.data;
  };
  const settings=await call('settings','get');
  await call('settings','setProviderSecret',{providerId:provider.id,plaintext:'public-local-no-auth'});
  await call('settings','save',{settings:settings.settings,providers:[provider],
    defaultModelId:provider.id+':group/deepseek',permissions:settings.permissions});
  // Only the public fixture credential, never a user's provider key.
  const ciphertext=await app.evaluate(async({safeStorage})=>(await safeStorage.encryptStringAsync('fixture-key')).toString('base64'));
  const core=new Database(join(receipt.dataRoot,'plugin-data/data/core.db'));
  try{core.prepare('INSERT OR REPLACE INTO plugin_secrets(plugin_id,key,ciphertext_base64,updated_at) VALUES(?,?,?,?)')
    .run('@roc/plugin-research','fixture-secret',ciphertext,new Date().toISOString());}finally{core.close();}
  await page.getByTestId('portal-card-open-'+receipt.projectId).click();
  const trials=[];
  for(const item of inputs){
    const started=Date.now();let cursor=0,terminal=null;const events=[];
    active=await call('chat','startRun',{input:item.input,mode:'chat',researchProjectId:receipt.projectId,
      enabledCapabilities:{mcpServers:[],skills:[]},threadId:null});
    console.log(JSON.stringify({id:item.id,runId:active.runId,status:'started'}));
    const eventsPath=join(output,item.id.replaceAll(':','_')+'.events.jsonl');
    while(Date.now()-started<manifest.timeoutMs){
      const batch=await call('chat','replayRunEvents',{runId:active.runId,afterSequence:cursor,limit:1000});
      for(const record of batch.events){
        assert.ok(record.sequence>cursor);cursor=record.sequence;events.push(record);
        appendFileSync(eventsPath,JSON.stringify(record)+'\n');
        if(['run_completed','run_failed','run_cancelled','run_interrupted'].includes(record.event.type))terminal=record.event;
      }
      if(terminal)break;
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!terminal||terminal.type==='run_interrupted')await call('chat','cancelRun',{runId:active.runId});
    const trial={id:item.id,run:active,elapsedMs:Date.now()-started,terminal,eventsPath,
      eventCount:events.length,status:terminal?.type??'timeout'};
    trials.push(trial);writeFileSync(join(output,'trials.json'),JSON.stringify(trials,null,2)+'\n');
    console.log(JSON.stringify({id:item.id,status:trial.status,events:events.length,elapsedMs:trial.elapsedMs}));active=null;
  }
  await app.close();app=null;
  assert.equal(applicationIdentity(),manifest.buildHash);
  const after=await backup(receipt.database,'after.db');
  const agent=await backup(join(receipt.dataRoot,'plugin-data/data/plugins/@roc/plugin-agent.db'),'agent.db');
  writeFileSync(join(output,'report.json'),JSON.stringify({manifestSha256:digest(join(output,'manifest.json')),trials,
    after,agent,
    quality:{answerCorrectness:null,faithfulness:null,evidenceRecall:null,correctRefusal:null},
    status:'Recorded, pending independent review'},null,2)+'\n',{flag:'wx'});
}finally{await app?.close();}
