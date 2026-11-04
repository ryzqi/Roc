import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewStudiesSaveSchema,researchReviewStudiesGetSchema,researchReviewStudiesSnapshotSchema,researchReviewStudiesInspectionSchema,
  type ResearchReviewStudiesSave,type ResearchReviewStudiesInspection
} from '../../../shared/schemas/research-review-studies';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
type Selection={projectId:string;corpusId:string};
type Row={id:string;project_id:string;corpus_id:string;version:number;parent_id:string|null;
  request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Human-declared study/report memberships preserve distinct counts without inferring scientific study identity. */
export class ResearchReviewStudiesRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly freezing:ResearchReviewFullTextFreeze,private readonly bindings:ResearchReviewFullTextRepository,
    private readonly now:()=>string) {}
  async save(input:ResearchReviewStudiesSave,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewStudiesInspection> {
    const request=researchReviewStudiesSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const digest=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,digest,actor);
    const context=this.context(request);this.requireCurrent(request,context);this.validate(request,context);this.selected(context);
    for(const report of context.reports)await this.bindings.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      bindingId:report.binding.id,expectedBindingHash:report.binding.expectedHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,digest,actor);
      const current=this.context(request);this.requireCurrent(request,current);this.validate(request,current);
      const parent=this.selected(current);
      if(parent===null?request.parentGroupingId!==null:request.parentGroupingId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash) {
        throw new Error('research_review_studies_version_conflict');
      }
      const snapshot=researchReviewStudiesSnapshotSchema.parse({
        id:`review_studies_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,request,requestHash:digest,
        reports:current.reports,reviewer:this.reviewer(request,current),actor,recordedAt:this.now()
      }),json=JSON.stringify(snapshot),snapshotHash=hash(json);
      this.db.prepare(`INSERT INTO research_review_study_groupings
        (id,project_id,corpus_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(snapshot.id,request.projectId,request.corpusId,snapshot.version,request.parentGroupingId,request.requestId,json,snapshotHash,snapshot.recordedAt);
      const updated=this.db.prepare('UPDATE research_review_screening_plans SET study_group_head_hash=? WHERE corpus_id=? AND study_group_head_hash IS ?')
        .run(snapshotHash,request.corpusId,parent===null?null:parent.snapshotHash);
      if(updated.changes!==1)throw new Error('research_review_studies_snapshot_invalid');
      const fresh=this.context(request),saved=this.selected(fresh);this.requireCurrent(request,fresh);
      if(saved===null||saved.snapshotHash!==snapshotHash)throw new Error('research_review_studies_snapshot_invalid');
      return saved;
    })();
  }
  get(input:Selection):ResearchReviewStudiesInspection|null {
    return this.selected(this.context(researchReviewStudiesGetSchema.parse(input)));
  }
  history(input:Selection):ResearchReviewStudiesInspection[] {
    const request=researchReviewStudiesGetSchema.parse(input),context=this.context(request),latest=this.head(request.corpusId);
    if(latest===undefined)return [];
    return (this.db.prepare('SELECT * FROM research_review_study_groupings WHERE corpus_id=? ORDER BY version')
      .all(request.corpusId) as Row[]).map(row=>this.inspect(row,context,latest));
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private context(input:Selection) {
    const phase=this.freezing.getPhase({projectId:input.projectId,corpusId:input.corpusId,phase:'full_text'});
    if(phase.freeze===null)throw new Error('research_review_screening_not_frozen');
    const reports=phase.freeze.authority.items.filter(item=>item.status==='included').map(item=>{
      if(item.binding===null)throw new Error('research_review_studies_snapshot_invalid');
      return {hit:item.hit,binding:item.binding};
    });
    return {phase,reports};
  }
  private requireCurrent(request:ResearchReviewStudiesSave,context:ReturnType<ResearchReviewStudiesRepository['context']>):void {
    if(request.expectedFullFreezeHash!==context.phase.freezeHash)throw new Error('research_review_studies_version_conflict');
    if(!context.phase.plan.currentProtocol||!context.phase.sourcesCurrent)throw new Error('research_review_studies_source_changed');
  }
  private reviewer(request:ResearchReviewStudiesSave,context:ReturnType<ResearchReviewStudiesRepository['context']>) {
    const roster=context.phase.plan.snapshot.request,reviewer=[...roster.fullTextReviewers,roster.adjudicator].find(value=>value.id===request.reviewerId);
    if(reviewer===undefined)throw new Error('research_review_screening_reviewer_not_declared');
    return reviewer;
  }
  private validate(request:ResearchReviewStudiesSave,context:ReturnType<ResearchReviewStudiesRepository['context']>):void {
    this.reviewer(request,context);
    const covered=new Set<string>();
    for(const group of request.groups)for(const report of group.reports) {
      const selected=context.reports.find(value=>value.hit.id===report.hitId);
      if(selected===undefined)throw new Error('research_review_studies_report_not_included');
      if(selected.binding.expectedHash!==report.expectedBindingHash)throw new Error('research_review_studies_version_conflict');
      covered.add(report.hitId);
    }
    if(covered.size!==context.reports.length)throw new Error('research_review_studies_incomplete');
  }
  private head(corpusId:string):Row|undefined {
    const marker=this.db.prepare('SELECT study_group_head_hash FROM research_review_screening_plans WHERE corpus_id=?').pluck().get(corpusId) as string|null;
    const latest=this.db.prepare('SELECT * FROM research_review_study_groupings WHERE corpus_id=? ORDER BY version DESC LIMIT 1').get(corpusId) as Row|undefined;
    if((latest===undefined)!==(marker===null)||(latest!==undefined&&latest.snapshot_hash!==marker))throw new Error('research_review_studies_snapshot_invalid');
    return latest;
  }
  private selected(context:ReturnType<ResearchReviewStudiesRepository['context']>):ResearchReviewStudiesInspection|null {
    const latest=this.head(context.phase.plan.snapshot.request.corpusId);
    return latest===undefined?null:this.inspect(latest,context,latest);
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_study_groupings WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewStudiesSave,digest:string,actor:ResearchRelationReviewer):ResearchReviewStudiesInspection {
    if(row.corpus_id!==request.corpusId)throw new Error('research_review_request_conflict');
    const previous=this.history({projectId:request.projectId,corpusId:request.corpusId}).find(value=>value.snapshot.id===row.id);
    if(previous===undefined||previous.snapshot.requestHash!==digest||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private read(row:Row,context:ReturnType<ResearchReviewStudiesRepository['context']>):ResearchReviewStudiesInspection['snapshot'] {
    const snapshot=researchReviewStudiesSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    const plan=context.phase.plan.snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
      request.projectId!==row.project_id||request.corpusId!==row.corpus_id||request.projectId!==plan.projectId||request.corpusId!==plan.corpusId||
      snapshot.version!==row.version||request.parentGroupingId!==row.parent_id||request.requestId!==row.request_id||
      request.expectedFullFreezeHash!==context.phase.freezeHash||snapshot.recordedAt!==row.created_at||
      snapshot.requestHash!==hash(JSON.stringify(request))||(snapshot.version===1)!==(request.parentGroupingId===null)||
      JSON.stringify(snapshot.reports)!==JSON.stringify(context.reports)||JSON.stringify(snapshot.reviewer)!==JSON.stringify(this.reviewer(request,context))) {
      throw new Error('research_review_studies_snapshot_invalid');
    }
    this.validate(request,context);return snapshot;
  }
  private inspect(row:Row,context:ReturnType<ResearchReviewStudiesRepository['context']>,latest:Row):ResearchReviewStudiesInspection {
    const snapshot=this.read(row,context);let child=snapshot;
    while(child.request.parentGroupingId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_study_groupings WHERE id=?').get(child.request.parentGroupingId) as Row|undefined;
      if(parent===undefined)throw new Error('research_review_studies_snapshot_invalid');
      const previous=this.read(parent,context);
      if(previous.version!==child.version-1||parent.snapshot_hash!==child.request.expectedParentHash)throw new Error('research_review_studies_snapshot_invalid');
      child=previous;
    }
    return researchReviewStudiesInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,currentProtocol:context.phase.plan.currentProtocol,
      sourcesCurrent:context.phase.sourcesCurrent,includedReports:snapshot.reports.length,includedStudies:snapshot.request.groups.length
    });
  }
}
