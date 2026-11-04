import {createReviewExtractionFixture} from './research-review-extraction.mjs';
import {fullTextActor as actor} from './research-review-fulltext-screening.mjs';
export async function createReviewQualityFixture(api,options={}) {
  const f=await createReviewExtractionFixture(api,options);
  f.extraction=await f.extractions.save(f.extract(),actor);
  f.qualityPlans=new api.ResearchReviewQualityPlanRepository(f.db,f.repository,f.extractions,f.fullFreezing,()=>f.time);
  f.qualityInput=(requestId='declare-quality')=>({...f.get,hitId:f.extraction.snapshot.request.hitId,requestId,
    extractionId:f.extraction.snapshot.id,expectedExtractionHash:f.extraction.snapshotHash,
    framework:f.protocol.version.body.qualityAssessment[0],
    definition:{origin:'user_declared',documentationNote:'Explicit synthetic engineering definition, with no validated official scientific completeness claim.',
      domains:[{id:'methods',label:'Declared methods',question:'Can the human judge the declared method from the selected original source?',
        judgements:['adequate','unclear','inadequate']},
      {id:'reporting',label:'Declared reporting',question:'Can the human judge the declared reporting from the selected original source?',
        judgements:['reported','unclear','not_reported']}],
      overallJudgements:['reviewed','concerns','unjudgeable']},
    reviewerId:f.reviewerIds[0],reviewNote:'Human explicitly selects and confirms this synthetic study-design framework definition.'});
  f.qualityGet=extractionId=>({...f.get,extractionId});
  return f;
}
