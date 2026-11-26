import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {loadResearchTestApi,createResearchFixture,withResearchTestWorker,createResearchTestRoleTools} from './fixtures/research-test-kit.mjs';
let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const plain={title:'Approved input',markdown:'Fixed material.',claims:[],sections:[],verdict:'uncertain'};
function fixture(){
  const f=createResearchFixture(api,'reading');
  const completed=withResearchTestWorker(api,f.repository,f.run.id,f.project.id,id=>f.repository.runs.complete(id,f.project.id,plain));
  const artifactId=completed.outputArtifactIds[0];
  f.db.prepare("UPDATE research_artifacts SET status='approved',kind='manuscript' WHERE id=?").run(artifactId);
  f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
  f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(f.project.id);
  const queued=f.repository.runs.begin({projectId:f.project.id,expectedStage:'writing',instruction:'Read approved input',requestId:'writing'});
  const run=withResearchTestWorker(api,f.repository,queued.id,f.project.id,id=>f.repository.runs.markRunning(id,f.project.id,{providerId:'fixture',modelId:'fixture'}));
  return {...f,run,artifactId};
}

test('writing role binds project, input artifact and context receipts and rejects late cancellation or grant revocation',async()=>{
  const f=fixture(),controller=new AbortController();
  try{
    let calls=0,mutate=result=>result;
    const tools=createResearchTestRoleTools(api,{run:f.run,context:f.repository.runs.getContext(f.run.id),repository:f.repository,signal:controller.signal,
      capabilities:{invoke:async(name,request,signal)=>{
        calls++;assert.equal(request.projectId,f.project.id);assert.equal(signal,controller.signal);
        const result={...request,basisDigest:'0'.repeat(64),...(name.endsWith('checkGrounding')?
          {status:'ready',issues:[],checkedClaimIds:[]}:{status:'current',impacts:[],requiresHumanRevision:false})};
        return mutate(result);
      }}});
    const request={artifactId:f.artifactId,contextId:'writing-context:fixture'};
    for(const name of ['check_draft_grounding','review_writing_impact']){
      const tool=tools.find(tool=>tool.name===name);
      assert.equal((await tool.invoke(request)).projectId,f.project.id);
      const previous=calls;
      await assert.rejects(tool.invoke({...request,artifactId:'another-project-artifact'}),/not_in_run_inputs/);
      assert.equal(calls,previous);
      for(const field of ['projectId','artifactId','contextId']){
        mutate=result=>({...result,[field]:'foreign'});
        await assert.rejects(tool.invoke(request),/tool_binding_invalid/,field);
      }
      mutate=result=>result;
    }
    const check=tools.find(tool=>tool.name==='check_draft_grounding');
    mutate=result=>{f.tasks.setStatus(f.run.taskId,f.project.id,'paused','fixture',['active']);return result;};
    await assert.rejects(check.invoke(request),/task_not_active/);
    f.tasks.setStatus(f.run.taskId,f.project.id,'active','fixture',['paused']);
    mutate=result=>{controller.abort(new Error('writing_role_cancelled'));return result;};
    await assert.rejects(check.invoke(request),/writing_role_cancelled/);
  }finally{await f.close();}
});
