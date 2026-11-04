import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewQualityPlanCreateSchema,researchReviewQualityPlanSnapshotSchema,researchReviewQualityPlanInspectionSchema,
  researchReviewQualityPlanGetSchema,researchReviewQualityPlansListSchema,
  type ResearchReviewQualityPlanCreate,type ResearchReviewQualityPlanInspection
} from '../../../shared/schemas/research-review-quality';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewExtractionRepository} from './review-extraction-repository';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
type Row={id:string;project_id:string;corpus_id:string;hit_id:string;extraction_id:string;request_id:string;
  snapshot_json:string;snapshot_hash:string;created_at:string};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Freeze a human-declared framework definition for the exact extracted study design and source version. */
export class ResearchReviewQualityPlanRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly extractions:ResearchReviewExtractionRepository,private readonly freezing:ResearchReviewFullTextFreeze,
    private readonly now:()=>string) {}

  async create(input:ResearchReviewQualityPlanCreate,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewQualityPlanInspection> {
    const request=researchReviewQualityPlanCreateSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    if(this.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:request.extractionId})!==null) {
      throw new Error('research_review_quality_plan_already_frozen');
    }
    const context=this.context(request);this.requireCurrent(context);
    await this.extractions.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      extractionId:request.extractionId,expectedExtractionHash:request.expectedExtractionHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      if(this.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:request.extractionId})!==null) {
        throw new Error('research_review_quality_plan_already_frozen');
      }
      const current=this.context(request);this.requireCurrent(current);
      const snapshot=researchReviewQualityPlanSnapshotSchema.parse({
        id:`review_quality_plan_${randomUUID()}`,request,requestHash,
        protocolVersionId:current.protocol.version.id,protocolVersionHash:current.protocol.versionHash,
        reviewer:current.reviewer,actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_quality_plans
        (id,project_id,corpus_id,hit_id,extraction_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(snapshot.id,request.projectId,request.corpusId,request.hitId,request.extractionId,request.requestId,json,hash(json),snapshot.recordedAt);
      this.db.prepare('UPDATE research_review_extractions SET quality_plan_hash=? WHERE id=? AND quality_plan_hash IS NULL')
        .run(hash(json),request.extractionId);
      const saved=this.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:request.extractionId});
      if(saved===null||saved.snapshotHash!==hash(json))throw new Error('research_review_quality_snapshot_invalid');
      if(!saved.currentExtraction||!saved.currentProtocol||saved.referenceStatus!=='current')throw new Error('research_review_quality_source_changed');
      return saved;
    })();
  }
  get(input:{projectId:string;corpusId:string;extractionId:string}):ResearchReviewQualityPlanInspection|null {
    const request=researchReviewQualityPlanGetSchema.parse(input);
    this.extractions.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:request.extractionId});
    const marker=this.db.prepare('SELECT quality_plan_hash FROM research_review_extractions WHERE id=?').pluck().get(request.extractionId) as string|null;
    const row=this.db.prepare('SELECT * FROM research_review_quality_plans WHERE extraction_id=?').get(request.extractionId) as Row|undefined;
    if((row===undefined)!==(marker===null)||(row!==undefined&&row.snapshot_hash!==marker))throw new Error('research_review_quality_snapshot_invalid');
    return row===undefined?null:this.inspect(row);
  }
  list(input:{projectId:string;corpusId:string}):ResearchReviewQualityPlanInspection[] {
    const request=researchReviewQualityPlansListSchema.parse(input);
    this.freezing.getPhase({...request,phase:'full_text'});
    const markers=this.db.prepare(`SELECT e.quality_plan_hash AS marker,p.snapshot_hash AS receipt
      FROM research_review_extractions e LEFT JOIN research_review_quality_plans p ON p.extraction_id=e.id
      WHERE e.project_id=? AND e.corpus_id=? AND (e.quality_plan_hash IS NOT NULL OR p.id IS NOT NULL)`)
      .all(request.projectId,request.corpusId) as {marker:string|null;receipt:string|null}[];
    if(markers.some(row=>row.marker===null||row.receipt===null||row.marker!==row.receipt))throw new Error('research_review_quality_snapshot_invalid');
    return (this.db.prepare('SELECT * FROM research_review_quality_plans WHERE project_id=? AND corpus_id=? ORDER BY rowid')
      .all(request.projectId,request.corpusId) as Row[]).map(row=>this.inspect(row));
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private context(request:ResearchReviewQualityPlanCreate) {
    const extraction=this.extractions.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:request.extractionId});
    if(extraction.snapshotHash!==request.expectedExtractionHash||extraction.snapshot.request.hitId!==request.hitId) {
      throw new Error('research_review_quality_version_conflict');
    }
    const design=extraction.snapshot.request.studyDesign.value;
    if(design.kind!=='text')throw new Error('research_review_quality_study_design_unjudgeable');
    if(design.text!==request.framework.studyDesign)throw new Error('research_review_quality_study_design_mismatch');
    const protocol=this.repository.systematicReviews.get({projectId:request.projectId,versionId:extraction.snapshot.protocolVersionId});
    if(!protocol.version.body.qualityAssessment.some(framework=>framework.studyDesign===request.framework.studyDesign&&
      framework.framework===request.framework.framework&&framework.version===request.framework.version)) {
      throw new Error('research_review_quality_framework_not_declared');
    }
    const plan=this.freezing.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'full_text'}).plan;
    const reviewer=[...plan.snapshot.request.fullTextReviewers,plan.snapshot.request.adjudicator].find(value=>value.id===request.reviewerId);
    if(reviewer===undefined)throw new Error('research_review_screening_reviewer_not_declared');
    return {extraction,protocol,reviewer};
  }
  private requireCurrent(context:ReturnType<ResearchReviewQualityPlanRepository['context']>):void {
    if(!context.extraction.isLatest||!context.extraction.currentProtocol||context.extraction.referenceStatus!=='current') {
      throw new Error('research_review_quality_source_changed');
    }
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_quality_plans WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewQualityPlanCreate,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewQualityPlanInspection {
    if(row.corpus_id!==request.corpusId)throw new Error('research_review_request_conflict');
    const previous=this.get({projectId:request.projectId,corpusId:request.corpusId,extractionId:row.extraction_id});
    if(previous===null||previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private inspect(row:Row):ResearchReviewQualityPlanInspection {
    const snapshot=researchReviewQualityPlanSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    const context=this.context(request);
    const marker=this.db.prepare('SELECT quality_plan_hash FROM research_review_extractions WHERE id=?').pluck().get(request.extractionId) as string|null;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||marker!==row.snapshot_hash||
      snapshot.id!==row.id||request.projectId!==row.project_id||request.corpusId!==row.corpus_id||request.hitId!==row.hit_id||
      request.extractionId!==row.extraction_id||request.requestId!==row.request_id||snapshot.recordedAt!==row.created_at||
      snapshot.requestHash!==hash(JSON.stringify(request))||snapshot.protocolVersionId!==context.protocol.version.id||
      snapshot.protocolVersionHash!==context.protocol.versionHash||JSON.stringify(snapshot.reviewer)!==JSON.stringify(context.reviewer)) {
      throw new Error('research_review_quality_snapshot_invalid');
    }
    return researchReviewQualityPlanInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,currentExtraction:context.extraction.isLatest,
      currentProtocol:context.extraction.currentProtocol,referenceStatus:context.extraction.referenceStatus
    });
  }
}
