import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewFullTextDecisionSaveSchema,researchReviewFullTextDecisionSnapshotSchema,researchReviewFullTextDecisionInspectionSchema,
  researchReviewFullTextSuggestionCreateSchema,researchReviewFullTextSuggestionOriginSchema,
  researchReviewFullTextSuggestionSnapshotSchema,researchReviewFullTextSuggestionInspectionSchema,
  researchReviewFullTextDecisionHistorySchema,researchReviewFullTextSuggestionListSchema,
  researchReviewFullTextPhaseGetSchema,researchReviewFullTextPhaseInspectionSchema,
  type ResearchReviewFullTextDecisionSave,type ResearchReviewFullTextDecisionInspection,
  type ResearchReviewFullTextSuggestionCreate,type ResearchReviewFullTextSuggestionOrigin,
  type ResearchReviewFullTextSuggestionInspection,type ResearchReviewFullTextPhaseInspection
} from '../../../shared/schemas/research-review-fulltext-screening';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchReviewScreeningPlanInspection} from '../../../shared/schemas/research-review-screening';
import type {ResearchReviewFullTextBindingInspection} from '../../../shared/schemas/research-review-fulltext';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
import type {ResearchReviewScreeningFreeze} from './review-screening-freeze';

type Target=ResearchReviewFullTextSuggestionCreate;
type Row={
  id:string;project_id:string;corpus_id:string;phase:string;hit_id:string;request_id:string;
  snapshot_json:string;snapshot_hash:string;created_at:string
};
type DecisionRow=Row&{reviewer_id:string;version:number;parent_id:string|null};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Full-text votes share phase-keyed screening storage, while explicit source bindings retain retrieval provenance. */
export class ResearchReviewFullTextScreening {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly titles:ResearchReviewScreeningFreeze,private readonly bindings:ResearchReviewFullTextRepository,
    private readonly now:()=>string) {}

  async save(input:ResearchReviewFullTextDecisionSave,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewFullTextDecisionInspection> {
    const request=researchReviewFullTextDecisionSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request));
    const replay=this.requestRow('research_review_screening_decisions',request);
    if(replay!==undefined)return this.replayDecision(replay,request,requestHash,actor);
    this.validateTarget(request);
    await this.bindings.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      bindingId:request.bindingId,expectedBindingHash:request.expectedBindingHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow('research_review_screening_decisions',request);
      if(repeated!==undefined)return this.replayDecision(repeated,request,requestHash,actor);
      const plan=this.validateTarget(request);
      const reviewer=plan.snapshot.request.fullTextReviewers.find(value=>value.id===request.reviewerId);
      if(reviewer===undefined)throw new Error('research_review_screening_reviewer_not_declared');
      const previous=this.latest(request.corpusId,request.hitId,request.reviewerId);
      const parent=previous===undefined?null:this.inspectDecision(previous,plan);
      if(parent===null?request.parentDecisionId!==null:
        request.parentDecisionId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash) {
        throw new Error('research_review_screening_version_conflict');
      }
      this.validateSuggestion(request,plan);
      const snapshot=researchReviewFullTextDecisionSnapshotSchema.parse({
        id:`review_fulltext_decision_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,
        request,requestHash,reviewer,material:this.material(request),actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_decisions
        (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,
          request.reviewerId,snapshot.version,request.parentDecisionId,request.requestId,json,hash(json),snapshot.recordedAt);
      this.validateTarget(request);
      const row=this.latest(request.corpusId,request.hitId,request.reviewerId);
      if(row===undefined||row.id!==snapshot.id)throw new Error('research_review_screening_snapshot_invalid');
      return this.inspectDecision(row,plan);
    })();
  }

  async suggest(input:ResearchReviewFullTextSuggestionCreate,proposedBy:ResearchReviewFullTextSuggestionOrigin):Promise<ResearchReviewFullTextSuggestionInspection> {
    const request=researchReviewFullTextSuggestionCreateSchema.parse(input),origin=researchReviewFullTextSuggestionOriginSchema.parse(proposedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow('research_review_screening_suggestions',request);
    if(replay!==undefined)return this.replaySuggestion(replay,request,requestHash,origin);
    this.validateTarget(request);
    await this.bindings.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      bindingId:request.bindingId,expectedBindingHash:request.expectedBindingHash});
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow('research_review_screening_suggestions',request);
      if(repeated!==undefined)return this.replaySuggestion(repeated,request,requestHash,origin);
      const plan=this.validateTarget(request);
      const snapshot=researchReviewFullTextSuggestionSnapshotSchema.parse({
        id:`review_fulltext_suggestion_${randomUUID()}`,request,requestHash,material:this.material(request),origin,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_suggestions
        (id,project_id,corpus_id,phase,hit_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(snapshot.id,request.projectId,request.corpusId,request.phase,request.hitId,request.requestId,json,hash(json),snapshot.recordedAt);
      this.validateTarget(request);
      const row=this.requestRow('research_review_screening_suggestions',request);
      if(row===undefined||row.id!==snapshot.id)throw new Error('research_review_screening_snapshot_invalid');
      return this.inspectSuggestion(row,plan);
    })();
  }

  history(input:{projectId:string;corpusId:string;decisionId:string}):ResearchReviewFullTextDecisionInspection[] {
    const request=researchReviewFullTextDecisionHistorySchema.parse(input),plan=this.plan(request);
    const row=this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?').get(request.decisionId) as DecisionRow|undefined;
    if(row===undefined||row.phase!=='full_text')throw new Error('research_review_screening_decision_not_found');
    if(row.project_id!==request.projectId||row.corpus_id!==request.corpusId)throw new Error('research_review_project_mismatch');
    return (this.db.prepare("SELECT * FROM research_review_screening_decisions WHERE corpus_id=? AND phase='full_text' AND hit_id=? AND reviewer_id=? ORDER BY version")
      .all(request.corpusId,row.hit_id,row.reviewer_id) as DecisionRow[]).map(value=>this.inspectDecision(value,plan));
  }
  listSuggestions(input:{projectId:string;corpusId:string;phase:'full_text';hitId:string;offset:number;limit:number}):ResearchReviewFullTextSuggestionInspection[] {
    const request=researchReviewFullTextSuggestionListSchema.parse(input),plan=this.plan(request);
    this.requireIncluded(request);
    return (this.db.prepare("SELECT * FROM research_review_screening_suggestions WHERE corpus_id=? AND phase='full_text' AND hit_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(request.corpusId,request.hitId,request.limit,request.offset) as Row[]).map(row=>this.inspectSuggestion(row,plan));
  }
  getPhase(input:{projectId:string;corpusId:string;phase:'full_text'}):ResearchReviewFullTextPhaseInspection {
    const request=researchReviewFullTextPhaseGetSchema.parse(input),title=this.title(request),plan=title.plan;
    const bindings=new Map(this.bindings.list({projectId:request.projectId,corpusId:request.corpusId})
      .map(binding=>[binding.snapshot.request.hitId,binding]));
    const counts:ResearchReviewFullTextPhaseInspection['counts']={
      reportsToSeek:0,retrieval_pending:0,not_retrieved:0,source_changed:0,pending:0,uncertain:0,conflict:0,included:0,excluded:0
    };
    const items=title.freeze.authority.items.filter(item=>item.status==='included').map(item=>{
      const binding=bindings.get(item.hit.id)??null;
      const decisions=plan.snapshot.request.fullTextReviewers.flatMap(reviewer=>{
        const row=this.latest(request.corpusId,item.hit.id,reviewer.id);
        return row===undefined?[]:[this.inspectDecision(row,plan)];
      });
      let status:ResearchReviewFullTextPhaseInspection['items'][number]['status'];
      if(binding===null)status='retrieval_pending';
      else if(binding.referenceStatus==='not_retrieved')status='not_retrieved';
      else if(binding.referenceStatus==='superseded'||decisions.some(decision=>!decision.sourceCurrent))status='source_changed';
      else if(decisions.length!==plan.snapshot.request.fullTextReviewers.length)status='pending';
      else if(decisions.some(decision=>decision.snapshot.request.outcome.decision==='uncertain'))status='uncertain';
      else if(new Set(decisions.map(decision=>decision.snapshot.request.outcome.decision)).size>1||
        new Set(decisions.flatMap(decision=>{
          const outcome=decision.snapshot.request.outcome;return outcome.decision==='exclude'?[outcome.exclusionCriterionId]:[];
        })).size>1)status='conflict';
      else status=decisions[0].snapshot.request.outcome.decision==='include'?'included':'excluded';
      const suggestions=this.db.prepare("SELECT * FROM research_review_screening_suggestions WHERE corpus_id=? AND phase='full_text' AND hit_id=?")
        .all(request.corpusId,item.hit.id) as Row[];
      for(const suggestion of suggestions)this.inspectSuggestion(suggestion,plan);
      counts.reportsToSeek++;counts[status]++;
      return {hit:item.hit,binding,decisions,status,suggestionCount:suggestions.length};
    });
    return researchReviewFullTextPhaseInspectionSchema.parse({plan,phase:request.phase,titleFreezeHash:title.freezeHash,items,counts});
  }

  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private title(request:{projectId:string;corpusId:string}) {
    const title=this.titles.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'title_abstract'});
    if(title.freeze===null||title.freezeHash===null)throw new Error('research_review_screening_not_frozen');
    return {...title,freeze:title.freeze,freezeHash:title.freezeHash};
  }
  private plan(request:{projectId:string;corpusId:string}):ResearchReviewScreeningPlanInspection {return this.title(request).plan;}
  private requireIncluded(request:{projectId:string;corpusId:string;hitId:string}):void {
    if(!this.title(request).freeze.authority.items.some(item=>item.hit.id===request.hitId&&item.status==='included')) {
      throw new Error('research_review_fulltext_hit_not_included');
    }
  }
  private validateTarget(request:Target):ResearchReviewScreeningPlanInspection {
    const title=this.title({projectId:request.projectId,corpusId:request.corpusId});
    if(!title.plan.currentProtocol||title.plan.snapshotHash!==request.expectedPlanHash||title.freezeHash!==request.expectedTitleFreezeHash) {
      throw new Error('research_review_screening_version_conflict');
    }
    const binding=this.binding(request);
    if(!binding.isLatest||binding.referenceStatus==='superseded')throw new Error('research_review_fulltext_version_conflict');
    this.validateOutcome(title.plan,request.outcome);
    return title.plan;
  }
  private binding(request:Target):ResearchReviewFullTextBindingInspection {
    const binding=this.bindings.get({projectId:request.projectId,corpusId:request.corpusId,bindingId:request.bindingId});
    if(binding.snapshotHash!==request.expectedBindingHash||binding.snapshot.request.hitId!==request.hitId||
      binding.snapshot.request.expectedTitleFreezeHash!==request.expectedTitleFreezeHash)throw new Error('research_review_fulltext_version_conflict');
    if(binding.snapshot.request.outcome.kind!=='retrieved')throw new Error('research_review_fulltext_not_retrieved');
    return binding;
  }
  private material(request:Target):ResearchReviewFullTextDecisionInspection['snapshot']['material'] {
    const binding=this.binding(request);
    return {hit:binding.snapshot.hit,binding:{id:binding.snapshot.id,expectedHash:binding.snapshotHash}};
  }
  private validateOutcome(plan:ResearchReviewScreeningPlanInspection,outcome:Target['outcome']):void {
    const body=this.repository.systematicReviews.get({projectId:plan.snapshot.request.projectId,versionId:plan.snapshot.protocolVersionId}).version.body;
    if(outcome.decision==='include'&&outcome.inclusionCriterionIds.some(id=>!body.inclusionCriteria.some(criterion=>criterion.id===id))||
      outcome.decision==='exclude'&&!body.exclusionCriteria.some(criterion=>criterion.id===outcome.exclusionCriterionId)) {
      throw new Error('research_review_screening_criterion_not_declared');
    }
  }
  private validateSuggestion(request:ResearchReviewFullTextDecisionSave,plan:ResearchReviewScreeningPlanInspection):void {
    if(request.consideredSuggestion===null)return;
    const row=this.db.prepare('SELECT * FROM research_review_screening_suggestions WHERE id=?').get(request.consideredSuggestion.id) as Row|undefined;
    if(row===undefined||row.phase!=='full_text')throw new Error('research_review_screening_suggestion_not_found');
    const suggestion=this.inspectSuggestion(row,plan);
    if(suggestion.snapshotHash!==request.consideredSuggestion.expectedHash||suggestion.snapshot.request.hitId!==request.hitId||
      suggestion.snapshot.request.bindingId!==request.bindingId||suggestion.snapshot.request.expectedBindingHash!==request.expectedBindingHash) {
      throw new Error('research_review_screening_version_conflict');
    }
  }
  private requestRow(table:'research_review_screening_decisions',request:Target):DecisionRow|undefined;
  private requestRow(table:'research_review_screening_suggestions',request:Target):Row|undefined;
  private requestRow(table:'research_review_screening_decisions'|'research_review_screening_suggestions',request:Target):Row|undefined {
    return this.db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND request_id=?`).get(request.projectId,request.requestId) as Row|undefined;
  }
  private latest(corpusId:string,hitId:string,reviewerId:string):DecisionRow|undefined {
    return this.db.prepare("SELECT * FROM research_review_screening_decisions WHERE corpus_id=? AND phase='full_text' AND hit_id=? AND reviewer_id=? ORDER BY version DESC LIMIT 1")
      .get(corpusId,hitId,reviewerId) as DecisionRow|undefined;
  }
  private replayDecision(row:DecisionRow,request:ResearchReviewFullTextDecisionSave,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewFullTextDecisionInspection {
    if(row.corpus_id!==request.corpusId||row.phase!=='full_text')throw new Error('research_review_request_conflict');
    const previous=this.inspectDecision(row,this.plan({projectId:request.projectId,corpusId:request.corpusId}));
    if(previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private replaySuggestion(row:Row,request:Target,requestHash:string,origin:ResearchReviewFullTextSuggestionOrigin):ResearchReviewFullTextSuggestionInspection {
    if(row.corpus_id!==request.corpusId||row.phase!=='full_text')throw new Error('research_review_request_conflict');
    const previous=this.inspectSuggestion(row,this.plan({projectId:request.projectId,corpusId:request.corpusId})),existing=previous.snapshot.origin;
    if(previous.snapshot.requestHash!==requestHash||existing.operationId!==origin.operationId||existing.idempotencyKey!==origin.idempotencyKey||
      existing.toolCallId!==origin.toolCallId||existing.canonicalToolIdentity!==origin.canonicalToolIdentity||
      existing.toolVersion!==origin.toolVersion||existing.capabilityVersion!==origin.capabilityVersion)throw new Error('research_review_request_conflict');
    return previous;
  }
  private validateRow(row:Row,request:Target,requestHash:string,recordedAt:string,material:ResearchReviewFullTextDecisionInspection['snapshot']['material'],
    plan:ResearchReviewScreeningPlanInspection):ResearchReviewFullTextBindingInspection {
    const binding=this.binding(request);
    if(row.project_id!==request.projectId||row.project_id!==plan.snapshot.request.projectId||row.corpus_id!==request.corpusId||
      row.corpus_id!==plan.snapshot.request.corpusId||row.phase!==request.phase||row.hit_id!==request.hitId||
      row.request_id!==request.requestId||row.created_at!==recordedAt||request.expectedPlanHash!==plan.snapshotHash||
      requestHash!==hash(JSON.stringify(request))||JSON.stringify(material)!==JSON.stringify({
        hit:binding.snapshot.hit,binding:{id:binding.snapshot.id,expectedHash:binding.snapshotHash}
      })) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    this.validateOutcome(plan,request.outcome);
    return binding;
  }
  private readDecision(row:DecisionRow,plan:ResearchReviewScreeningPlanInspection):
    {snapshot:ResearchReviewFullTextDecisionInspection['snapshot'];binding:ResearchReviewFullTextBindingInspection} {
    const snapshot=researchReviewFullTextDecisionSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
      snapshot.version!==row.version||request.parentDecisionId!==row.parent_id||request.reviewerId!==row.reviewer_id||
      (snapshot.version===1)!==(request.parentDecisionId===null)||
      JSON.stringify(snapshot.reviewer)!==JSON.stringify(plan.snapshot.request.fullTextReviewers.find(value=>value.id===request.reviewerId))) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    const binding=this.validateRow(row,request,snapshot.requestHash,snapshot.recordedAt,snapshot.material,plan);
    this.validateSuggestion(request,plan);
    return {snapshot,binding};
  }
  private inspectDecision(row:DecisionRow,plan:ResearchReviewScreeningPlanInspection):ResearchReviewFullTextDecisionInspection {
    const {snapshot,binding}=this.readDecision(row,plan);let child=snapshot;
    while(child.request.parentDecisionId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?').get(child.request.parentDecisionId) as DecisionRow|undefined;
      if(parent===undefined)throw new Error('research_review_screening_snapshot_invalid');
      const previous=this.readDecision(parent,plan).snapshot;
      if(previous.version!==child.version-1||previous.request.hitId!==child.request.hitId||
        previous.request.reviewerId!==child.request.reviewerId||parent.snapshot_hash!==child.request.expectedParentHash) {
        throw new Error('research_review_screening_snapshot_invalid');
      }
      child=previous;
    }
    const latest=this.latest(row.corpus_id,row.hit_id,row.reviewer_id);
    if(latest===undefined)throw new Error('research_review_screening_snapshot_invalid');
    return researchReviewFullTextDecisionInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,sourceCurrent:binding.isLatest&&binding.referenceStatus==='current'
    });
  }
  private inspectSuggestion(row:Row,plan:ResearchReviewScreeningPlanInspection):ResearchReviewFullTextSuggestionInspection {
    const snapshot=researchReviewFullTextSuggestionSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    const binding=this.validateRow(row,snapshot.request,snapshot.requestHash,snapshot.recordedAt,snapshot.material,plan);
    return researchReviewFullTextSuggestionInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,sourceCurrent:binding.isLatest&&binding.referenceStatus==='current'
    });
  }
}
