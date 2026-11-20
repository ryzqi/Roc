import {createHash} from 'node:crypto';
import {createReviewFullTextScreeningFixture,fullTextActor as actor,fullTextInclude as include} from './research-review-fulltext-screening.mjs';
export const extractionDigest=source=>createHash('sha256').update(JSON.stringify({evidence:source.evidence,sourceLocator:source.sourceLocator})).digest('hex');
export async function createReviewExtractionFixture(api,{sourceOnly=false,freeze=true,...options}={}) {
  const f=await createReviewFullTextScreeningFixture(api,options);
  f.binding=await f.bind(0,sourceOnly?{...f.selection,parseId:null,parseHash:null}:f.selection);
  for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(0,reviewer,`included-${reviewer}`),actor);
  for(const index of [2,3,4,5,6,7])await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  f.fullFrozen=freeze?await f.fullFreezing.freeze({...f.fullPhase,requestId:'freeze-for-extraction',
    expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,reviewNote:'Human confirms explicit synthetic included report and retrieval gaps.'},actor):null;
  f.evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:`document:${f.selection.parseId}:chunk:0`});
  f.source=f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id);
  f.reference={id:f.evidence.id,expectedHash:extractionDigest(f.source)};
  f.extractions=new api.ResearchReviewExtractionRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,f.service,()=>f.time);
  f.extract=(requestId='extract-original')=>({...f.get,hitId:f.corpus.snapshot.hits[0].id,requestId,
    expectedFullFreezeHash:f.fullFrozen===null?'a'.repeat(64):f.fullFrozen.freezeHash,bindingId:f.binding.snapshot.id,
    expectedBindingHash:f.binding.snapshotHash,reviewerId:f.reviewerIds[0],reviewNote:'Human confirms explicit synthetic values and units, with no scientific accuracy claim.',
    studyDesign:{value:{kind:'text',text:f.protocol.version.body.qualityAssessment[0].studyDesign},evidence:[f.reference]},
    fields:[{fieldId:f.protocol.version.body.extractionFields[0].id,unit:f.protocol.version.body.extractionFields[0].unit,
      value:{kind:'number',number:1},evidence:[f.reference]}],
    parentExtractionId:null,expectedParentHash:null,revisionReason:null});
  f.extractionGet=extractionId=>({...f.get,extractionId});
  f.extractionHistory={...f.get,hitId:f.corpus.snapshot.hits[0].id};
  return f;
}
