import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewQualityAssessmentSaveSchema,researchReviewQualityAssessmentGetSchema,
  researchReviewQualityAssessmentSnapshotSchema,researchReviewQualityAssessmentInspectionSchema,
  type ResearchReviewQualityAssessmentSave,type ResearchReviewQualityAssessmentInspection
} from '../../../shared/schemas/research-review-quality';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewExtractionRepository} from './review-extraction-repository';
import type {ResearchReviewQualityPlanRepository} from './review-quality-plan-repository';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
type Selection={projectId:string;corpusId:string;extractionId:string;qualityPlanId:string};
type Row={id:string;project_id:string;corpus_id:string;plan_id:string;version:number;parent_id:string|null;
  request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Explicit human judgements use the frozen categories and exact existing extraction Evidence; no score aggregation. */
export class ResearchReviewQualityAssessmentRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly plans:ResearchReviewQualityPlanRepository,private readonly extractions:ResearchReviewExtractionRepository,
    private readonly freezing:ResearchReviewFullTextFreeze,private readonly now:()=>string) {}

  async save(input:ResearchReviewQualityAssessmentSave,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewQualityAssessmentInspection> {
    const request=researchReviewQualityAssessmentSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    const context=this.context(request);this.requireCurrent(request,context);this.validate(request,context);
    this.selected(context);
    await this.extractions.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      extractionId:request.extractionId,expectedExtractionHash:request.expectedExtractionHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      const current=this.context(request);this.requireCurrent(request,current);this.validate(request,current);
      const parent=this.selected(current);
      if(parent===null?request.parentAssessmentId!==null:
        request.parentAssessmentId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash) {
        throw new Error('research_review_quality_assessment_version_conflict');
      }
      const snapshot=researchReviewQualityAssessmentSnapshotSchema.parse({
        id:`review_quality_assessment_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,
        request,requestHash,reviewer:this.reviewer(request,current),actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot),digest=hash(json);
      this.db.prepare(`INSERT INTO research_review_quality_assessments
        (id,project_id,corpus_id,plan_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(snapshot.id,request.projectId,request.corpusId,request.qualityPlanId,snapshot.version,request.parentAssessmentId,
          request.requestId,json,digest,snapshot.recordedAt);
      const updated=this.db.prepare('UPDATE research_review_quality_plans SET assessment_head_hash=? WHERE id=? AND assessment_head_hash IS ?')
        .run(digest,request.qualityPlanId,parent===null?null:parent.snapshotHash);
      if(updated.changes!==1)throw new Error('research_review_quality_assessment_snapshot_invalid');
      const fresh=this.context(request),saved=this.selected(fresh);
      if(saved===null||saved.snapshotHash!==digest)throw new Error('research_review_quality_assessment_snapshot_invalid');
      this.requireCurrent(request,fresh);
      return saved;
    })();
  }
  get(input:Selection):ResearchReviewQualityAssessmentInspection|null {
    const request=researchReviewQualityAssessmentGetSchema.parse(input),context=this.context(request);
    return this.selected(context);
  }
  private selected(context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>):ResearchReviewQualityAssessmentInspection|null {
    const latest=this.head(context.plan.snapshot.id);
    return latest===undefined?null:this.inspect(latest,context,latest);
  }
  history(input:Selection):ResearchReviewQualityAssessmentInspection[] {
    const request=researchReviewQualityAssessmentGetSchema.parse(input),context=this.context(request),latest=this.head(request.qualityPlanId);
    if(latest===undefined)return [];
    return (this.db.prepare('SELECT * FROM research_review_quality_assessments WHERE plan_id=? ORDER BY version')
      .all(request.qualityPlanId) as Row[]).map(row=>this.inspect(row,context,latest));
  }
  private selection(input:Selection):Selection {
    return {projectId:input.projectId,corpusId:input.corpusId,extractionId:input.extractionId,qualityPlanId:input.qualityPlanId};
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private context(input:Selection) {
    const plan=this.plans.get({projectId:input.projectId,corpusId:input.corpusId,extractionId:input.extractionId});
    if(plan===null||plan.snapshot.id!==input.qualityPlanId)throw new Error('research_review_quality_plan_not_found');
    const extraction=this.extractions.get({projectId:input.projectId,corpusId:input.corpusId,extractionId:input.extractionId});
    const phase=this.freezing.getPhase({projectId:input.projectId,corpusId:input.corpusId,phase:'full_text'});
    return {plan,extraction,phase};
  }
  private requireCurrent(request:ResearchReviewQualityAssessmentSave,context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>):void {
    if(context.plan.snapshotHash!==request.expectedPlanHash||context.extraction.snapshotHash!==request.expectedExtractionHash) {
      throw new Error('research_review_quality_assessment_version_conflict');
    }
    if(!context.plan.currentExtraction||!context.plan.currentProtocol||context.plan.referenceStatus!=='current'||!context.phase.sourcesCurrent) {
      throw new Error('research_review_quality_source_changed');
    }
  }
  private reviewer(request:ResearchReviewQualityAssessmentSave,context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>) {
    const roster=context.phase.plan.snapshot.request;
    const reviewer=[...roster.fullTextReviewers,roster.adjudicator].find(value=>value.id===request.reviewerId);
    if(reviewer===undefined)throw new Error('research_review_screening_reviewer_not_declared');
    return reviewer;
  }
  private validate(request:ResearchReviewQualityAssessmentSave,context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>):void {
    this.reviewer(request,context);
    const definition=context.plan.snapshot.request.definition;
    if(request.domains.length!==definition.domains.length)throw new Error('research_review_quality_domains_incomplete');
    for(const domain of request.domains) {
      const declared=definition.domains.find(value=>value.id===domain.domainId);
      if(declared===undefined)throw new Error('research_review_quality_domain_not_declared');
      if(domain.value.kind==='judged'&&!declared.judgements.includes(domain.value.judgement))throw new Error('research_review_quality_judgement_not_declared');
    }
    if(request.overall.value.kind==='judged'&&!definition.overallJudgements.includes(request.overall.value.judgement)) {
      throw new Error('research_review_quality_judgement_not_declared');
    }
    for(const ref of [...request.domains.flatMap(domain=>domain.evidence),...request.overall.evidence]) {
      const source=context.extraction.snapshot.sources.find(value=>value.evidence.id===ref.id);
      if(source===undefined||source.digest!==ref.expectedHash)throw new Error('research_review_quality_evidence_mismatch');
    }
  }
  private head(planId:string):Row|undefined {
    const marker=this.db.prepare('SELECT assessment_head_hash FROM research_review_quality_plans WHERE id=?').pluck().get(planId) as string|null;
    const latest=this.db.prepare('SELECT * FROM research_review_quality_assessments WHERE plan_id=? ORDER BY version DESC LIMIT 1').get(planId) as Row|undefined;
    if((latest===undefined)!==(marker===null)||(latest!==undefined&&latest.snapshot_hash!==marker)) {
      throw new Error('research_review_quality_assessment_snapshot_invalid');
    }
    return latest;
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_quality_assessments WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewQualityAssessmentSave,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewQualityAssessmentInspection {
    if(row.corpus_id!==request.corpusId||row.plan_id!==request.qualityPlanId)throw new Error('research_review_request_conflict');
    const previous=this.history(this.selection(request)).find(value=>value.snapshot.id===row.id);
    if(previous===undefined||previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private read(row:Row,context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>):ResearchReviewQualityAssessmentInspection['snapshot'] {
    const snapshot=researchReviewQualityAssessmentSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    const selected=context.plan.snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
      request.projectId!==row.project_id||request.corpusId!==row.corpus_id||request.qualityPlanId!==row.plan_id||
      request.projectId!==selected.projectId||request.corpusId!==selected.corpusId||request.extractionId!==selected.extractionId||
      request.qualityPlanId!==context.plan.snapshot.id||request.expectedPlanHash!==context.plan.snapshotHash||
      request.expectedExtractionHash!==context.extraction.snapshotHash||snapshot.version!==row.version||
      request.parentAssessmentId!==row.parent_id||request.requestId!==row.request_id||snapshot.recordedAt!==row.created_at||
      snapshot.requestHash!==hash(JSON.stringify(request))||(snapshot.version===1)!==(request.parentAssessmentId===null)||
      JSON.stringify(snapshot.reviewer)!==JSON.stringify(this.reviewer(request,context))) {
      throw new Error('research_review_quality_assessment_snapshot_invalid');
    }
    this.validate(request,context);return snapshot;
  }
  private inspect(row:Row,context:ReturnType<ResearchReviewQualityAssessmentRepository['context']>,latest:Row):ResearchReviewQualityAssessmentInspection {
    const snapshot=this.read(row,context);let child=snapshot;
    while(child.request.parentAssessmentId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_quality_assessments WHERE id=?').get(child.request.parentAssessmentId) as Row|undefined;
      if(parent===undefined)throw new Error('research_review_quality_assessment_snapshot_invalid');
      const previous=this.read(parent,context);
      if(previous.version!==child.version-1||parent.snapshot_hash!==child.request.expectedParentHash)throw new Error('research_review_quality_assessment_snapshot_invalid');
      child=previous;
    }
    return researchReviewQualityAssessmentInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,currentExtraction:context.plan.currentExtraction,
      currentProtocol:context.plan.currentProtocol,referenceStatus:context.plan.referenceStatus
    });
  }
}
