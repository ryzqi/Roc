/** Canonical pre-freeze records for migration tests; never bypass a current runtime write boundary. */
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');

export function seedPreFreezeReviewerDecision(api,f,input,actor) {
  const request=api.researchReviewScreeningDecisionSaveSchema.parse(input);
  const original=f.corpora.getHit({projectId:request.projectId,corpusId:request.corpusId,hitId:request.hitId});
  const reviewer=f.plan.snapshot.request.titleAbstractReviewers.find(value=>value.id===request.reviewerId);
  const abstract=original.record.record.abstract;
  const snapshot=api.researchReviewScreeningDecisionSnapshotSchema.parse({
    id:`pre_freeze_vote_${request.requestId}`,version:1,request,requestHash:hash(JSON.stringify(request)),reviewer,
    material:{hit:original.reference,source:original.source,abstractStatus:abstract===null||abstract.trim().length===0?'missing':'present'},
    actor,recordedAt:f.time
  });
  const json=JSON.stringify(snapshot);
  f.db.prepare(`INSERT INTO research_review_screening_decisions
    (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,request.reviewerId,
      snapshot.version,request.parentDecisionId,request.requestId,json,hash(json),snapshot.recordedAt);
  return {snapshot,snapshotHash:hash(json),isLatest:true};
}

export function seedPreFreezeArbitration(api,f,input,actor) {
  const request=api.researchReviewScreeningArbitrationSaveSchema.parse(input);
  const material=f.decisions.getPhase({...f.get,phase:request.phase}).items.find(item=>item.hit.id===request.hitId).decisions[0].snapshot.material;
  const snapshot=api.researchReviewScreeningArbitrationSnapshotSchema.parse({
    id:`pre_freeze_arbitration_${request.requestId}`,version:1,request,requestHash:hash(JSON.stringify(request)),
    adjudicator:f.plan.snapshot.request.adjudicator,material,actor,recordedAt:f.time
  });
  const json=JSON.stringify(snapshot);
  f.db.prepare(`INSERT INTO research_review_screening_arbitrations
    (id,project_id,corpus_id,phase,hit_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,
      snapshot.version,request.parentArbitrationId,request.requestId,json,hash(json),snapshot.recordedAt);
  return {snapshot,snapshotHash:hash(json),isLatest:true,currentDecisionSet:true};
}
