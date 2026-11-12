import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Annotation, Command, END, MemorySaver, START, StateGraph, interrupt} from '@langchain/langgraph';
import {ToolMessage} from '@langchain/core/messages';
import {z} from 'zod';
import {withResearchTestWorker, createResearchFixture, loadResearchTestApi, captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from './fixtures/research-production-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api.dispose());
const output={title:'Recorded plan',markdown:'Recorded synthetic output',claims:[],sections:[],verdict:'uncertain'};
function waiting(stage='planning') {
  const f=createResearchFixture(api,stage);
  const completed=withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, output));
  f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:stage,action:'complete'});
  return {...f,artifactId:completed.outputArtifactIds[0]};
}
const request=(f,action='approve')=>({projectId:f.project.id,expectedStage:f.repository.getProject(f.project.id).currentStage,
  action,expectedArtifactVersions:captureResearchArtifactVersions(f.repository,f.project.id)});
const changes=f=>f.db.prepare('SELECT total_changes()').pluck().get();

test('rejecting completed reading permits a replacement run while unreviewed outputs stay fenced',()=>{
  const f=createResearchFixture(api,'reading');
  try {
    const complete=id=>withResearchTestWorker(api,f.repository,id,f.project.id,workerId=>
      f.repository.runs.complete(workerId,f.project.id,output));
    const original=complete(f.run.id);
    const begin=requestId=>f.repository.runs.begin({projectId:f.project.id,expectedStage:'reading',
      instruction:'Correct the rejected reading notes',requestId});
    assert.throws(()=>begin('before-review'),/research_stage_awaiting_gate/u);
    f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:'reading',action:'complete'});
    f.repository.transitionWorkflow(request(f,'reject'));
    const rejected=f.repository.getWorkflow(f.project.id).stages.find(stage=>stage.stage==='reading');
    assert.equal(rejected.status,'running');
    assert.equal(rejected.activeRunId,null);
    const replacement=begin('after-reject');
    assert.notEqual(replacement.id,original.id);
    assert.equal(f.repository.runs.get(original.id,f.project.id).status,'completed');
    assert.deepEqual(f.repository.runs.get(original.id,f.project.id).outputArtifactIds,original.outputArtifactIds);
    assert.equal(f.repository.getArtifact(original.outputArtifactIds[0]).status,'superseded');
    assert.deepEqual(f.repository.getWorkflow(f.project.id).stages.find(stage=>stage.stage==='reading').artifactIds,[]);
    f.tasks.linkStage(replacement,null);
    f.repository.runs.bindTask(replacement.id,f.project.id);
    withResearchTestWorker(api,f.repository,replacement.id,f.project.id,id=>
      f.repository.runs.markRunning(id,f.project.id,{providerId:'fixture-provider',modelId:'fixture-model'}));
    const revised=complete(replacement.id);
    assert.throws(()=>begin('before-revised-review'),/research_stage_awaiting_gate/u);
    f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:'reading',action:'complete'});
    assert.deepEqual(captureResearchArtifactVersions(f.repository,f.project.id).map(entry=>entry.artifactId),revised.outputArtifactIds);
    f.repository.transitionWorkflow(request(f));
    assert.equal(f.repository.getProject(f.project.id).currentStage,'ideation');
  }finally{f.close();}
});

function effectMiddleware(f, name='research_approve_gate') {
  const store=new api.AgentToolEffectStore(f.agentDb);
  const request={toolCall:{id:'gate-call',name,args:{}},runtime:{configurable:{
    checkpoint_ns:'tools:gate',checkpoint_map:{'':'gate-checkpoint'},ls_agent_type:'root'
  }}};
  const middleware=api.createToolEffectIdempotencyMiddleware({runId:f.run.id,threadId:'effect-gate',store,
    capabilityManifest:{manifestHash:'gate-test',tools:[{modelVisibleName:name,canonicalIdentity:`research.${name}`,
      toolVersion:'1',effectClass:'external_call',idempotencyStrategy:'operation_key',reconcileStrategy:'manual_confirmation'}]}});
  return {store,request,middleware,status:()=>f.agentDb.prepare('SELECT status FROM agent_tool_effects WHERE run_id=?').pluck().get(f.run.id)};
}

test('real nested gate can suspend before effects, resume with reviewed versions, and replay once',async()=>{
  const f=waiting();
  try {
    const registry=new api.CapabilityRegistry();
    let transitions=0;
    for(const [name,handler] of [
      ['research.workflow.get',()=>f.repository.getWorkflow(f.project.id)],
      ['research.workflow.gateReview',input=>f.repository.readGateReviewContext(input)],
      ['research.workflow.transition',input=>{transitions++;return f.repository.transitionWorkflow(input);}]
    ]) {
      const descriptor={name,version:'1.0.0',inputSchema:z.unknown(),outputSchema:z.unknown()};
      registry.declare('research',descriptor);registry.register('research',descriptor,async input=>handler(input));
    }
    const tools=api.createResearchTools({projectId:f.project.id,signal:new AbortController().signal,capabilities:registry,
      dispatchStage:async()=>assert.fail('gate cannot run a model'),dispatchReviewQuery:async()=>assert.fail('unexpected search')});
    const gate=tools.find(tool=>tool.name==='research_approve_gate');
    const e=effectMiddleware(f);
    const handler=async()=>new ToolMessage({name:e.request.toolCall.name,tool_call_id:e.request.toolCall.id,
      content:JSON.stringify(await gate.invoke({}))});
    const graph=new StateGraph(Annotation.Root({done:Annotation()})).addNode('tool',async()=>{
      await e.middleware.wrapToolCall(e.request,handler);return {done:true};
    }).addEdge(START,'tool').addEdge('tool',END).compile({checkpointer:new MemorySaver()});
    const config={configurable:{thread_id:'effect-gate'}};
    const pending=await graph.invoke({done:false},config);
    assert.equal(transitions,0);
    assert.equal(pending.__interrupt__.length,1);
    assert.equal(e.status(),'failed_retryable','a graph suspension without a write must not require effect reconciliation');
    assert.equal(e.store.hasUnknown(f.run.id),false);
    e.store.markRestartedUnknown(f.run.id);
    assert.equal(e.status(),'failed_retryable','restarting a pre-effect suspension must preserve the pending gate');
    assert.equal(e.store.hasUnknown(f.run.id),false);
    const versions=pending.__interrupt__[0].value.request.actionRequests[0].args.artifactLinks
      .map(link=>({artifactId:link.artifactId,version:link.expectedVersion}));
    const result=await graph.invoke(new Command({resume:{decisions:[{type:'approve',reviewedArtifactVersions:versions}]}}),config);
    assert.equal(result.done,true);assert.equal(transitions,1);assert.equal(e.status(),'succeeded');
    await e.middleware.wrapToolCall(e.request,async()=>assert.fail('completed approval must replay'));
    assert.equal(transitions,1);
  }finally{f.close();}
});

test('interrupt after publishing an effect remains unknown and cannot repeat the handler',async()=>{
  const f=waiting();
  try {
    const registry=new api.CapabilityRegistry();
    const descriptor={name:'test.write',version:'1',inputSchema:z.unknown(),outputSchema:z.unknown()};
    registry.declare('test',descriptor);registry.register('test',descriptor,async()=>({written:true}));
    const e=effectMiddleware(f,'write_then_interrupt');
    let writes=0;
    const graph=new StateGraph(Annotation.Root({done:Annotation()})).addNode('tool',async()=>{
      await e.middleware.wrapToolCall(e.request,async()=>{
        await registry.invoke('test.write',{});writes++;
        interrupt({question:'unsafe to restart write'});
        return new ToolMessage({name:'write_then_interrupt',tool_call_id:'gate-call',content:'done'});
      });return {done:true};
    }).addEdge(START,'tool').addEdge('tool',END).compile({checkpointer:new MemorySaver()});
    const config={configurable:{thread_id:'published-effect'}};
    const pending=await graph.invoke({done:false},config);
    assert.equal(pending.__interrupt__.length,1);assert.equal(e.status(),'unknown');assert.equal(writes,1);
    await assert.rejects(graph.invoke(new Command({resume:true}),config),/agent_tool_effect_unknown_manual_confirmation/);
    assert.equal(writes,1);
  }finally{f.close();}
});

test('semantic gate validation can reinterrupt before a receipt, then approve exactly once after source review',async()=>{
  const f=createResearchFixture(api,'reading');
  try {
    f.repository.knowledge.upsertFromSource({id:'gate-source',projectId:f.project.id,sourceType:'file',sourceId:'gate.md',
      title:'Gate source',content:'Measured result.',chunks:[{content:'Measured result.',locator:'block:0'}],embeddingPolicy:'none'});
    const source=f.repository.evidence.capture({projectId:f.project.id,chunkId:'gate-source:chunk:0'});
    const completed=withResearchTestWorker(api,f.repository,f.run.id,f.project.id,id=>f.repository.runs.complete(id,f.project.id,{
      ...output,claims:[{subjectType:'claim',content:'Measured result.',status:'supported',evidenceIds:[source.id]}]}));
    f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:'reading',action:'complete'});
    const registry=new api.CapabilityRegistry();
    const humanGate=api.createResearchHumanGate({repository:f.repository});
    let transitions=0;
    for(const [name,handler] of [
      ['research.workflow.get',()=>f.repository.getWorkflow(f.project.id)],
      ['research.workflow.gateReview',input=>f.repository.readGateReviewContext(input)],
      ['research.workflow.transition',input=>{transitions++;return humanGate.approve(input);}]
    ]) {
      const descriptor={name,version:'1',inputSchema:z.unknown(),outputSchema:z.unknown(),
        ...(name==='research.workflow.transition'?{effectReceipt:'handler'}:{})};
      registry.declare('research',descriptor);registry.register('research',descriptor,async input=>handler(input));
    }
    const gate=api.createResearchTools({projectId:f.project.id,signal:new AbortController().signal,capabilities:registry,
      dispatchStage:async()=>assert.fail('gate cannot run a model'),dispatchReviewQuery:async()=>assert.fail('unexpected search')})
      .find(tool=>tool.name==='research_approve_gate');
    const e=effectMiddleware(f);
    const graph=new StateGraph(Annotation.Root({done:Annotation()})).addNode('tool',async()=>{
      await e.middleware.wrapToolCall(e.request,async()=>new ToolMessage({name:'research_approve_gate',tool_call_id:'gate-call',
        content:JSON.stringify(await gate.invoke({}))}));return {done:true};
    }).addEdge(START,'tool').addEdge('tool',END).compile({checkpointer:new MemorySaver()});
    const config={configurable:{thread_id:'semantic-gate'}};
    const pending=await graph.invoke({done:false},config);
    const versions=value=>value.__interrupt__[0].value.request.actionRequests[0].args.artifactLinks
      .map(link=>({artifactId:link.artifactId,version:link.expectedVersion}));
    const before=changes(f);
    const retry=await graph.invoke(new Command({resume:{decisions:[{type:'approve',reviewedArtifactVersions:versions(pending)}]}}),config);
    assert.match(retry.__interrupt__[0].value.request.actionRequests[0].args.reviewError,/人工支持确认/);
    assert.equal(changes(f),before,'semantic failure must not write research data');
    assert.equal(e.status(),'failed_retryable','validation before any write must remain resumable');
    assert.equal(f.agentDb.prepare('SELECT receipt_sequence FROM agent_tool_effects').pluck().get(),0);
    e.store.markRestartedUnknown(f.run.id);
    assert.equal(e.status(),'failed_retryable');
    const claim=f.repository.evidence.listClaims({projectId:f.project.id,artifactId:completed.outputArtifactIds[0]})[0];
    const relation=f.repository.evidence.relations.list({projectId:f.project.id,claimId:claim.id})[0];
    f.repository.evidence.relations.review({projectId:f.project.id,relationId:relation.id,expectedVersion:relation.version,
      expectedClaimVersion:relation.claimVersion,expectedSourceDigest:relation.sourceDigest,decision:'confirm',note:'Reviewed fixed source.'},
      {kind:'user',id:'test-reviewer'});
    const reviewed=captureResearchArtifactVersions(f.repository,f.project.id);
    const result=await graph.invoke(new Command({resume:{decisions:[{type:'approve',reviewedArtifactVersions:reviewed}]}}),config);
    assert.equal(result.done,true);assert.equal(e.status(),'succeeded');assert.equal(transitions,2);
    assert.equal(f.agentDb.prepare('SELECT receipt_sequence FROM agent_tool_effects').pluck().get(),1);
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'ideation');
    await e.middleware.wrapToolCall(e.request,async()=>assert.fail('committed approval must replay'));
  }finally{f.close();}
});

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

test('real interrupt replay refuses stale versions and rereading cannot authorize a tampered worker output',async()=>{
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
      await assert.rejects(graph.invoke(new Command({resume:{decisions:[{type,reviewedArtifactVersions:reviewed}]}}),config), /research_node_output_changed/u);
      assert.equal(changes(f),before);
      assert.equal(f.repository.getArtifact(f.artifactId).status,'draft');
    }finally{f.close();}
  }
});
