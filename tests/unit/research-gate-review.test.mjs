import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Annotation, Command, END, MemorySaver, START, StateGraph} from '@langchain/langgraph';
import {createResearchFixture, loadResearchTestApi, captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from './fixtures/research-production-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const output={title:'Recorded plan',markdown:'Recorded synthetic output',claims:[],sections:[],verdict:'uncertain'};
function waiting(stage='planning') {
  const f=createResearchFixture(api,stage);
  const completed=f.repository.runs.complete(f.run.id,f.project.id,output);
  f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:stage,action:'complete'});
  return {...f,artifactId:completed.outputArtifactIds[0]};
}
const request=(f,action='approve')=>({projectId:f.project.id,expectedStage:f.repository.getProject(f.project.id).currentStage,
  action,expectedArtifactVersions:captureResearchArtifactVersions(f.repository,f.project.id)});
const changes=f=>f.db.prepare('SELECT total_changes()').pluck().get();

test('approve and reject require unique complete current versions at wire and repository boundaries',()=>{
  for(const action of ['approve','reject']) {
    const f=waiting();
    try {
      const valid=request(f,action),before=changes(f);
      const invalid=[
        {value:undefined,code:/research_artifact_review_required/u},
        {value:[],code:/research_artifact_review_required/u},
        {value:[...valid.expectedArtifactVersions,...valid.expectedArtifactVersions],code:/research_artifact_review_required/u},
        {value:[{artifactId:f.artifactId,version:'old timestamp'}],code:/research_artifact_review_required/u},
        {value:[{artifactId:'foreign-artifact',version:'a'.repeat(64)}],code:/research_artifact_review_set_changed/u},
        {value:[...valid.expectedArtifactVersions,{artifactId:'extra',version:'a'.repeat(64)}],code:/research_artifact_review_set_changed/u},
        {value:[{artifactId:f.artifactId,version:'a'.repeat(64)}],code:/research_artifact_review_changed/u}
      ];
      for(const {value,code} of invalid) {
        const bad={...valid,expectedArtifactVersions:value};
        assert.throws(()=>f.repository.transitionWorkflow(bad),code);
        if(code.source.includes('required')) assert.equal(api.researchWorkflowTransitionRequestSchema.safeParse(bad).success,false);
        assert.equal(changes(f),before);
      }
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
      assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'planning');
    }finally{f.close();}
  }
});

test('same-clock content, source invalidation and stage-set changes refuse every reviewed decision without writes',()=>{
  for(const action of ['approve','reject']) for(const change of ['content','evidence','set']) {
    const f=waiting();
    try {
      if(change==='evidence') {
        const excerpt='Retained source excerpt';
        f.db.prepare(`INSERT INTO research_evidence
          (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('evidence',f.project.id,'document','document:chunk:0','file','source','parse-1',
          'Source','page:2',excerpt,createHash('sha256').update(excerpt).digest('hex'),f.project.createdAt);
        f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='planning'").run(f.project.id);
        f.repository.evidence.createClaim({projectId:f.project.id,artifactId:f.artifactId,
          subjectType:'claim',content:'Recorded claim',status:'pending',evidenceIds:['evidence']});
        f.db.prepare("UPDATE research_stage_states SET status='waiting_approval' WHERE project_id=? AND stage='planning'").run(f.project.id);
      }
      const original=request(f,action),updatedAt=f.repository.getArtifact(f.artifactId).updatedAt;
      if(change==='content') f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Changed') WHERE artifact_id=?").run(f.artifactId);
      if(change==='evidence') f.repository.evidence.invalidateChunksOf('document');
      if(change==='set') f.db.prepare("UPDATE research_stage_states SET artifact_ids_json='[]' WHERE project_id=? AND stage='planning'").run(f.project.id);
      assert.equal(f.repository.getArtifact(f.artifactId).updatedAt,updatedAt);
      const before=changes(f);
      assert.throws(()=>f.repository.transitionWorkflow(original),change==='set' ? /research_artifact_review_set_changed/u : /research_artifact_review_changed/u);
      assert.equal(changes(f),before);
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
    }finally{f.close();}
  }
});

test('whole gate context is readonly, scoped to the current stage, and includes every actual artifact',async()=>{
  const f=waiting();
  try {
    f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='planning'").run(f.project.id);
    const second=f.repository.createArtifact({projectId:f.project.id,stage:'planning',kind:'research_plan',title:'Second plan',path:null});
    f.db.prepare("UPDATE research_stage_states SET status='waiting_approval' WHERE project_id=? AND stage='planning'").run(f.project.id);
    const handlers=new Map();
    api.registerResearchArtifactInspectorCapability({pluginId:'fixture',capabilities:{register(_id,descriptor,handler){
      handlers.set(descriptor.name,handler);
    }}},f.repository);
    const bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
    const input={projectId:f.project.id,expectedStage:'planning',artifactId:f.artifactId},before=changes(f);
    const result=await bridge.invoke('research.getGateReviewContext',[input],21);
    assert.equal(result.ok,true);
    assert.deepEqual(result.data.artifactLinks.map(link=>link.artifactId),[f.artifactId,second.id]);
    assert.deepEqual(result.data.artifactLinks.map(link=>({artifactId:link.artifactId,version:link.expectedVersion})),request(f).expectedArtifactVersions);
    assert.equal(result.data.searchPlan,null);
    assert.equal(result.data.searchPlanHash,null);
    assert.ok(f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifactId,expectedVersion:null}).snapshot.availableActions.includes('review_gate'));
    assert.equal(changes(f),before);
    const other=f.repository.createProject({title:'Other',description:'Other scope',workspacePath:'/tmp/other-gate'});
    const foreign=f.repository.createArtifact({projectId:other.id,stage:'discovery',kind:'search_strategy',title:'Other plan',path:null});
    f.db.prepare("UPDATE research_projects SET current_stage='reading' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='reading'").run(f.project.id);
    const inactive=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Other stage',path:null});
    f.db.prepare("UPDATE research_projects SET current_stage='planning' WHERE id=?").run(f.project.id);
    const start=changes(f);
    for(const [bad,code] of [
      [{...input,artifactId:foreign.id},/research_artifact_project_mismatch/u],
      [{...input,artifactId:inactive.id},/research_gate_artifact_inactive/u],
      [{...input,expectedStage:'reading'},/research_workflow_stage_conflict/u],
      [{...input,artifactId:'missing'},/research_artifact_not_found/u],
      [{...input,projectId:'missing'},/research_project_not_found/u]
    ]) assert.throws(()=>f.repository.readGateReviewContext(bad),code);
    assert.equal((await bridge.invoke('research.getGateReviewContext',[{...input,artifactId:undefined}],21)).ok,false);
    assert.equal(changes(f),start);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.throws(()=>f.repository.readGateReviewContext(input),/research_project_archived/u);
    f.db.prepare("UPDATE research_projects SET status='active' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='planning'").run(f.project.id);
    assert.throws(()=>f.repository.readGateReviewContext(input),/research_stage_not_waiting_approval/u);
    f.db.prepare("UPDATE research_stage_states SET status='waiting_approval',artifact_ids_json='[]' WHERE project_id=? AND stage='planning'").run(f.project.id);
    assert.throws(()=>f.repository.readGateReviewContext({...input,artifactId:null}),/research_stage_artifact_required/u);
  }finally{f.close();}
});

test('successful approve and reject audits preserve the exact human-reviewed versions',()=>{
  for(const action of ['approve','reject']) {
    const f=waiting();
    try {
      const reviewed=request(f,action);
      f.repository.transitionWorkflow(reviewed);
      const event=f.db.prepare('SELECT payload_json FROM research_workflow_events WHERE project_id=? AND type=?')
        .pluck().get(f.project.id,action==='approve'?'approval_granted':'approval_rejected');
      assert.deepEqual(JSON.parse(event).expectedArtifactVersions,reviewed.expectedArtifactVersions);
      assert.equal(f.repository.getWorkflow(f.project.id).currentStage,action==='approve'?'experiment':'planning');
    }finally{f.close();}
  }
});

test('human gate refuses stale versions before production IO and rechecks after asynchronous verification',async()=>{
  for(const timing of ['before','during','archived','running']) {
    const f=await createPublishedFigureFixture(api);
    try {
      const reviewed=request(f);
      let calls=0;
      const edit=()=>f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Changed during review') WHERE artifact_id=?").run(f.artifactId);
      if(timing==='before') edit();
      if(timing==='archived') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
      if(timing==='running') f.db.prepare("UPDATE research_stage_states SET status='running' WHERE project_id=? AND stage='figure'").run(f.project.id);
      const gate=api.createResearchHumanGate({repository:f.repository,production:{async verifyStage(){
        calls++;
        await Promise.resolve();
        edit();
      }}});
      await assert.rejects(gate.approve(reviewed),timing==='archived' ? /research_project_archived/u : timing==='running' ? /research_stage_not_waiting_approval/u : /research_artifact_review_changed/u);
      assert.equal(calls,timing==='during'?1:0);
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
      assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'figure');
      assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_workflow_events WHERE type='approval_granted'").pluck().get(),0);
    }finally{await f.dispose();}
  }
});

test('real interrupt replay refuses original versions and needs explicit whole-stage reread for a new decision',async()=>{
  for(const type of ['approve','reject','revise']) {
    const f=waiting();
    try {
      if(type==='revise') {
        // Only the stale-version boundary is exercised here; native tests cover the actual review cycle.
        f.db.prepare("UPDATE research_projects SET current_stage='review' WHERE id=?").run(f.project.id);
        f.db.prepare("UPDATE research_artifacts SET stage='review',kind='review_report' WHERE id=?").run(f.artifactId);
        f.db.prepare("UPDATE research_stage_states SET status='waiting_approval',gate_required=1,artifact_ids_json=? WHERE project_id=? AND stage='review'")
          .run(JSON.stringify([f.artifactId]),f.project.id);
      }
      const tools=api.createResearchTools({projectId:f.project.id,signal:new AbortController().signal,
        dispatchReviewQuery: async () => assert.fail('unexpected owned query dispatch'), dispatchStage:async()=>assert.fail('gate cannot dispatch a model'),capabilities:{invoke:async(name,input)=>{
          if(name==='research.workflow.get') return f.repository.getWorkflow(f.project.id);
          if(name==='research.workflow.gateReview') return f.repository.readGateReviewContext(input);
          if(name==='research.workflow.transition') return f.repository.transitionWorkflow(input);
          assert.fail(name);
        }}});
      const tool=tools.find(tool=>tool.name==='research_approve_gate');
      const graph=new StateGraph(Annotation.Root({done:Annotation()})).addNode('gate',async()=>{
        await tool.invoke({});return{done:true};
      }).addEdge(START,'gate').addEdge('gate',END).compile({checkpointer:new MemorySaver()});
      const config={configurable:{thread_id:`versions-${type}`}};
      const pending=await graph.invoke({done:false},config);
      const args=pending.__interrupt__[0].value.request.actionRequests[0].args;
      const original=args.artifactLinks.map(link=>({artifactId:link.artifactId,version:link.expectedVersion}));
      f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Changed after interrupt') WHERE artifact_id=?").run(f.artifactId);
      const before=changes(f);
      const retry=await graph.invoke(new Command({resume:{decisions:[{type,reviewedArtifactVersions:original}]}}),config);
      assert.equal(retry.done,false);
      assert.equal(retry.__interrupt__[0].value.request.actionRequests[0].args.reviewError,'research_artifact_review_changed');
      assert.notEqual(retry.__interrupt__[0].id,pending.__interrupt__[0].id);
      assert.equal(changes(f),before);
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
      if(type==='revise') continue; // Domain-specific review cycle requires an actual saved manuscript.
      const fresh=f.repository.readGateReviewContext({projectId:f.project.id,expectedStage:'planning',artifactId:f.artifactId});
      const reviewed=fresh.artifactLinks.map(link=>({artifactId:link.artifactId,version:link.expectedVersion}));
      assert.notDeepEqual(reviewed,original);
      assert.equal((await graph.invoke(new Command({resume:{decisions:[{type,reviewedArtifactVersions:reviewed}]}}),config)).done,true);
    }finally{f.close();}
  }
});
