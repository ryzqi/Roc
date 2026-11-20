import {createReviewFullTextFixture} from './research-review-fulltext.mjs';
export const fullTextActor={kind:'user',id:'synthetic-fulltext-reviewer'};
export const fullTextInclude={decision:'include',inclusionCriterionIds:['controlled'],reason:'Human examined the explicitly bound original source.'};
export const fullTextExclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Human records the declared primary exclusion reason from the bound source.'};
export const fullTextUncertain={decision:'uncertain',reason:'Human cannot judge eligibility from the captured original source.'};
export const fullTextOrigin={kind:'agent_tool',operationId:'fulltext-proposal-operation',idempotencyKey:'fulltext-idempotency',
  toolCallId:'fulltext-tool-call',canonicalToolIdentity:'capability:research.reviewFullTextScreening.suggest',toolVersion:'1',
  attemptId:'first-attempt',capabilityName:'research.reviewFullTextScreening.suggest',capabilityVersion:'1.0.0'};
export async function createReviewFullTextScreeningFixture(api,options={}) {
  const f=await createReviewFullTextFixture(api,options);
  f.fullScreening=new api.ResearchReviewFullTextScreening(f.db,f.repository,f.freezing,f.fulltexts,()=>f.time);
  f.fullArbitration=new api.ResearchReviewFullTextArbitration(f.db,f.repository,f.fullScreening,f.fulltexts,()=>f.time);
  f.fullFreezing=new api.ResearchReviewFullTextFreeze(f.db,f.repository,f.fullArbitration,f.fulltexts,()=>f.time);
  f.fullPhase={...f.get,phase:'full_text'};
  f.reviewerIds=f.plan.snapshot.request.fullTextReviewers.map(reviewer=>reviewer.id);
  f.bound=new Map();
  f.bind=async(index=0,selection=f.selection)=>{
    const binding=await f.fulltexts.save(f.retrieved(index,`fulltext-source-${index}`,selection),fullTextActor);
    f.bound.set(index,binding);return binding;
  };
  f.target=(index,requestId,binding=f.bound.get(index))=>({...f.fullPhase,expectedPlanHash:f.plan.snapshotHash,
    expectedTitleFreezeHash:f.title.freezeHash,hitId:f.corpus.snapshot.hits[index].id,requestId,
    bindingId:binding.snapshot.id,expectedBindingHash:binding.snapshotHash});
  f.vote=(index,reviewerId,requestId,outcome=fullTextInclude,extra={})=>({...f.target(index,requestId),reviewerId,outcome,
    consideredSuggestion:null,parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  return f;
}
