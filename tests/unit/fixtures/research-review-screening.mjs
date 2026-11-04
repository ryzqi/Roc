/** Explicit reviewer declarations over the actual offline corpus/deduplication services. */
import {createReviewDeduplicationFixture} from './research-review-deduplication.mjs';
export const reviewScreeningActorFixture={kind:'user',id:'synthetic-screening-plan-declarer'};
export const reviewScreeningReviewerAFixture={id:'declared-researcher-a',name:'Researcher A'};
export const reviewScreeningReviewerBFixture={id:'declared-researcher-b',name:'Researcher B'};
export const reviewScreeningAdjudicatorFixture={id:'declared-adjudicator',name:'Adjudicator C'};
export async function createReviewScreeningPlanFixture(api,{freeze=true,...options}={},selectedApi=api) {
  const f=await createReviewDeduplicationFixture(api,options,selectedApi);
  f.frozen=freeze?f.dedup.freeze(f.freeze(),reviewScreeningActorFixture):null;
  f.screening=new api.ResearchReviewScreeningRepository(f.db,f.repository,f.corpora,f.dedup,()=>f.time);
  f.decisions=new api.ResearchReviewScreeningDecisions(f.db,f.repository,f.corpora,f.dedup,f.screening,()=>f.time);
  f.arbitration=new api.ResearchReviewScreeningArbitration(f.db,f.repository,f.decisions,()=>f.time);
  f.freezing=new api.ResearchReviewScreeningFreeze(f.db,f.repository,f.arbitration,()=>f.time);
  const counts=f.protocol.version.body.screening;
  f.input={...f.get,requestId:'declare-reviewers',expectedCorpusHash:f.corpus.snapshotHash,
    expectedDedupFreezeHash:f.frozen===null?'a'.repeat(64):f.frozen.freezeHash,
    titleAbstractReviewers:[reviewScreeningReviewerAFixture,reviewScreeningReviewerBFixture].slice(0,counts.titleAbstractReviewers),
    fullTextReviewers:[reviewScreeningReviewerBFixture,reviewScreeningReviewerAFixture].slice(0,counts.fullTextReviewers),adjudicator:reviewScreeningAdjudicatorFixture,
    reviewNote:'These are user-declared identities; main caller provenance is recorded separately.'};
  return f;
}
