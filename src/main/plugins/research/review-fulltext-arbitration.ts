import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewFullTextArbitrationSaveSchema,researchReviewFullTextArbitrationSnapshotSchema,researchReviewFullTextArbitrationInspectionSchema,
  researchReviewFullTextArbitrationHistorySchema,researchReviewFullTextResolvedPhaseSchema,
  type ResearchReviewFullTextArbitrationSave,type ResearchReviewFullTextArbitrationInspection,
  type ResearchReviewFullTextPhaseInspection,type ResearchReviewFullTextResolvedPhase
} from '../../../shared/schemas/research-review-fulltext-screening';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextScreening} from './review-fulltext-screening';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
type Row={
  id:string;project_id:string;corpus_id:string;phase:string;hit_id:string;version:number;parent_id:string|null;
  request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string
};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');
const sameReferences=(left:ResearchReviewFullTextArbitrationSave['decisions'],right:typeof left):boolean=>{
  const sorted=(refs:typeof left):string=>JSON.stringify([...refs].sort((a,b)=>a.id.localeCompare(b.id)));
  return sorted(left)===sorted(right);
};

/** Adjudication binds the complete current reviewer set and actual verified full-text source. */
export class ResearchReviewFullTextArbitration {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly decisions:ResearchReviewFullTextScreening,private readonly bindings:ResearchReviewFullTextRepository,
    private readonly now:()=>string) {}

  async save(input:ResearchReviewFullTextArbitrationSave,resolvedBy:ResearchRelationReviewer):Promise<ResearchReviewFullTextArbitrationInspection> {
    const request=researchReviewFullTextArbitrationSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(resolvedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    this.validateTarget(request,this.decisions.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase}));
    await this.bindings.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      bindingId:request.bindingId,expectedBindingHash:request.expectedBindingHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      const phase=this.decisions.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
      const item=this.validateTarget(request,phase);
      const latest=this.latest(request.corpusId,request.hitId),parent=latest===undefined?null:this.inspect(latest,phase);
      if(parent===null?request.parentArbitrationId!==null:
        request.parentArbitrationId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash) {
        throw new Error('research_review_screening_version_conflict');
      }
      const snapshot=researchReviewFullTextArbitrationSnapshotSchema.parse({
        id:`review_fulltext_arbitration_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,
        request,requestHash,adjudicator:phase.plan.snapshot.request.adjudicator,material:item.decisions[0].snapshot.material,
        actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_arbitrations
        (id,project_id,corpus_id,phase,hit_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,
          snapshot.version,request.parentArbitrationId,request.requestId,json,hash(json),snapshot.recordedAt);
      const row=this.latest(request.corpusId,request.hitId);
      if(row===undefined||row.id!==snapshot.id)throw new Error('research_review_screening_snapshot_invalid');
      const current=this.decisions.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
      this.validateTarget(request,current);
      const saved=this.inspect(row,current);
      if(!saved.currentDecisionSet)throw new Error('research_review_screening_arbitration_decisions_changed');
      return saved;
    })();
  }

  getPhase(input:{projectId:string;corpusId:string;phase:'full_text'}):ResearchReviewFullTextResolvedPhase {
    const phase=this.decisions.getPhase(input),counts={...phase.counts};
    const items=phase.items.map(item=>{
      const row=this.latest(input.corpusId,item.hit.id),arbitration=row===undefined?null:this.inspect(row,phase);
      let status=item.status;
      if(arbitration!==null&&arbitration.isLatest&&arbitration.currentDecisionSet&&(status==='conflict'||status==='uncertain')) {
        counts[status]--;status=arbitration.snapshot.request.outcome.decision==='include'?'included':'excluded';counts[status]++;
      }
      return {...item,status,arbitration};
    });
    return researchReviewFullTextResolvedPhaseSchema.parse({...phase,items,counts});
  }
  history(input:{projectId:string;corpusId:string;arbitrationId:string}):ResearchReviewFullTextArbitrationInspection[] {
    const request=researchReviewFullTextArbitrationHistorySchema.parse(input);
    const row=this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?').get(request.arbitrationId) as Row|undefined;
    if(row===undefined||row.phase!=='full_text')throw new Error('research_review_screening_arbitration_not_found');
    if(row.project_id!==request.projectId||row.corpus_id!==request.corpusId)throw new Error('research_review_project_mismatch');
    const phase=this.decisions.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'full_text'});
    return (this.db.prepare("SELECT * FROM research_review_screening_arbitrations WHERE corpus_id=? AND phase='full_text' AND hit_id=? ORDER BY version")
      .all(request.corpusId,row.hit_id) as Row[]).map(value=>this.inspect(value,phase));
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private latest(corpusId:string,hitId:string):Row|undefined {
    return this.db.prepare("SELECT * FROM research_review_screening_arbitrations WHERE corpus_id=? AND phase='full_text' AND hit_id=? ORDER BY version DESC LIMIT 1")
      .get(corpusId,hitId) as Row|undefined;
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewFullTextArbitrationSave,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewFullTextArbitrationInspection {
    if(row.corpus_id!==request.corpusId||row.phase!=='full_text')throw new Error('research_review_request_conflict');
    const phase=this.decisions.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
    const previous=this.inspect(row,phase);
    if(previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private validateTarget(request:ResearchReviewFullTextArbitrationSave,phase:ResearchReviewFullTextPhaseInspection):
    ResearchReviewFullTextPhaseInspection['items'][number] {
    if(!phase.plan.currentProtocol||phase.plan.snapshotHash!==request.expectedPlanHash||phase.titleFreezeHash!==request.expectedTitleFreezeHash) {
      throw new Error('research_review_screening_version_conflict');
    }
    if(phase.plan.snapshot.request.adjudicator.id!==request.reviewerId)throw new Error('research_review_screening_adjudicator_not_declared');
    const item=phase.items.find(item=>item.hit.id===request.hitId);
    if(item===undefined)throw new Error('research_review_fulltext_hit_not_included');
    if(item.binding===null||item.binding.referenceStatus==='not_retrieved')throw new Error('research_review_fulltext_not_retrieved');
    if(item.binding.snapshot.id!==request.bindingId||item.binding.snapshotHash!==request.expectedBindingHash||
      item.binding.referenceStatus!=='current'||item.decisions.some(decision=>!decision.sourceCurrent)) {
      throw new Error('research_review_fulltext_version_conflict');
    }
    if(item.decisions.length!==phase.plan.snapshot.request.fullTextReviewers.length)throw new Error('research_review_screening_arbitration_incomplete');
    if(!sameReferences(request.decisions,item.decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})))) {
      throw new Error('research_review_screening_arbitration_decisions_changed');
    }
    if(item.status!=='conflict'&&item.status!=='uncertain')throw new Error('research_review_screening_arbitration_not_needed');
    this.validateOutcome(phase,request.outcome);
    return item;
  }
  private validateOutcome(phase:ResearchReviewFullTextPhaseInspection,outcome:ResearchReviewFullTextArbitrationSave['outcome']):void {
    const body=this.repository.systematicReviews.get({projectId:phase.plan.snapshot.request.projectId,versionId:phase.plan.snapshot.protocolVersionId}).version.body;
    if(outcome.decision==='include'?outcome.inclusionCriterionIds.some(id=>!body.inclusionCriteria.some(criterion=>criterion.id===id)):
      !body.exclusionCriteria.some(criterion=>criterion.id===outcome.exclusionCriterionId))throw new Error('research_review_screening_criterion_not_declared');
  }
  private read(row:Row,phase:ResearchReviewFullTextPhaseInspection):ResearchReviewFullTextArbitrationInspection['snapshot'] {
    const snapshot=researchReviewFullTextArbitrationSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
      request.projectId!==row.project_id||row.project_id!==phase.plan.snapshot.request.projectId||request.corpusId!==row.corpus_id||
      row.corpus_id!==phase.plan.snapshot.request.corpusId||request.phase!==row.phase||request.phase!==phase.phase||
      request.hitId!==row.hit_id||request.requestId!==row.request_id||request.expectedPlanHash!==phase.plan.snapshotHash||
      request.expectedTitleFreezeHash!==phase.titleFreezeHash||request.parentArbitrationId!==row.parent_id||
      snapshot.version!==row.version||snapshot.recordedAt!==row.created_at||snapshot.requestHash!==hash(JSON.stringify(request))||
      (snapshot.version===1)!==(request.parentArbitrationId===null)||request.reviewerId!==phase.plan.snapshot.request.adjudicator.id||
      JSON.stringify(snapshot.adjudicator)!==JSON.stringify(phase.plan.snapshot.request.adjudicator)||
      snapshot.material.binding.id!==request.bindingId||snapshot.material.binding.expectedHash!==request.expectedBindingHash) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    const item=phase.items.find(item=>item.hit.id===request.hitId);
    if(item===undefined)throw new Error('research_review_screening_snapshot_invalid');
    const captured=request.decisions.map(ref=>{
      let decision=item.decisions.find(decision=>decision.snapshot.id===ref.id);
      if(decision===undefined)decision=this.decisions.history({projectId:request.projectId,corpusId:request.corpusId,decisionId:ref.id})
        .find(decision=>decision.snapshot.id===ref.id);
      if(decision===undefined||decision.snapshotHash!==ref.expectedHash||decision.snapshot.request.hitId!==request.hitId||
        decision.snapshot.request.phase!==request.phase)throw new Error('research_review_screening_snapshot_invalid');
      return decision;
    });
    if(captured.length!==phase.plan.snapshot.request.fullTextReviewers.length||
      new Set(captured.map(decision=>decision.snapshot.reviewer.id)).size!==captured.length||
      captured.some(decision=>JSON.stringify(decision.snapshot.material)!==JSON.stringify(snapshot.material))) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    this.validateOutcome(phase,request.outcome);
    return snapshot;
  }
  private inspect(row:Row,phase:ResearchReviewFullTextPhaseInspection):ResearchReviewFullTextArbitrationInspection {
    const snapshot=this.read(row,phase);let child=snapshot;
    while(child.request.parentArbitrationId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?').get(child.request.parentArbitrationId) as Row|undefined;
      if(parent===undefined)throw new Error('research_review_screening_snapshot_invalid');
      const previous=this.read(parent,phase);
      if(previous.version!==child.version-1||previous.request.hitId!==child.request.hitId||parent.snapshot_hash!==child.request.expectedParentHash) {
        throw new Error('research_review_screening_snapshot_invalid');
      }
      child=previous;
    }
    const item=phase.items.find(item=>item.hit.id===row.hit_id),latest=this.latest(row.corpus_id,row.hit_id);
    if(item===undefined||latest===undefined)throw new Error('research_review_screening_snapshot_invalid');
    return researchReviewFullTextArbitrationInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,
      currentDecisionSet:item.binding!==null&&item.binding.snapshot.id===snapshot.request.bindingId&&
        item.binding.snapshotHash===snapshot.request.expectedBindingHash&&item.binding.referenceStatus==='current'&&
        item.decisions.every(decision=>decision.sourceCurrent)&&
        sameReferences(snapshot.request.decisions,item.decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})))
    });
  }
}
