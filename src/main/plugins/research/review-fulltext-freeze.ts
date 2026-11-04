import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewFullTextAuthoritySchema,researchReviewFullTextFreezeRequestSchema,researchReviewFullTextFreezeReceiptSchema,
  researchReviewFullTextFrozenPhaseSchema,researchReviewFullTextPhaseGetSchema,
  type ResearchReviewFullTextAuthority,type ResearchReviewFullTextFreezeRequest,type ResearchReviewFullTextFreezeReceipt,
  type ResearchReviewFullTextFrozenPhase,type ResearchReviewFullTextResolvedPhase
} from '../../../shared/schemas/research-review-fulltext-screening';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextArbitration} from './review-fulltext-arbitration';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
type Row={project_id:string;corpus_id:string;phase:string;request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Marker and receipt are independent; losing one cannot reopen the complete review. */
export function readFullTextFreeze(db:Database,projectId:string,corpusId:string):
  {receipt:ResearchReviewFullTextFreezeReceipt;receiptHash:string}|null {
  researchReviewFullTextPhaseGetSchema.parse({projectId,corpusId,phase:'full_text'});
  const plan=db.prepare('SELECT project_id,full_freeze_hash FROM research_review_screening_plans WHERE corpus_id=?')
    .get(corpusId) as {project_id:string;full_freeze_hash:string|null}|undefined;
  if(plan===undefined)throw new Error('research_review_screening_plan_not_found');
  if(plan.project_id!==projectId)throw new Error('research_review_project_mismatch');
  const row=db.prepare("SELECT * FROM research_review_screening_freezes WHERE corpus_id=? AND phase='full_text'").get(corpusId) as Row|undefined;
  if((row===undefined)!==(plan.full_freeze_hash===null)||(row!==undefined&&row.snapshot_hash!==plan.full_freeze_hash)) {
    throw new Error('research_review_screening_snapshot_invalid');
  }
  if(row===undefined)return null;
  const receipt=researchReviewFullTextFreezeReceiptSchema.parse(JSON.parse(row.snapshot_json));
  if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(receipt)!==row.snapshot_json||
    row.project_id!==projectId||row.corpus_id!==corpusId||receipt.request.projectId!==projectId||
    receipt.request.corpusId!==corpusId||receipt.request.phase!==row.phase||receipt.request.requestId!==row.request_id||
    receipt.frozenAt!==row.created_at||receipt.requestHash!==hash(JSON.stringify(receipt.request))||
    receipt.reviewHash!==hash(JSON.stringify(receipt.authority))||receipt.request.expectedReviewHash!==receipt.reviewHash||
    receipt.authority.corpusId!==corpusId||receipt.authority.phase!==row.phase)throw new Error('research_review_screening_snapshot_invalid');
  return {receipt,receiptHash:row.snapshot_hash};
}
export function requireFullTextPhaseOpen(db:Database,projectId:string,corpusId:string):void {
  if(readFullTextFreeze(db,projectId,corpusId)!==null)throw new Error('research_review_screening_already_frozen');
}

/** Fixed human authority remains historical after document reparse; live source state separately gates new scientific actions. */
export class ResearchReviewFullTextFreeze {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly arbitration:ResearchReviewFullTextArbitration,private readonly bindings:ResearchReviewFullTextRepository,
    private readonly now:()=>string) {}

  getPhase(input:{projectId:string;corpusId:string;phase:'full_text'}):ResearchReviewFullTextFrozenPhase {
    const request=researchReviewFullTextPhaseGetSchema.parse(input),phase=this.arbitration.getPhase(request);
    const authority=this.capture(phase),reviewHash=hash(JSON.stringify(authority));
    const sealed=readFullTextFreeze(this.db,request.projectId,request.corpusId);
    if(sealed!==null&&(sealed.receipt.reviewHash!==reviewHash||JSON.stringify(sealed.receipt.authority)!==JSON.stringify(authority))) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    const sourcesCurrent=phase.items.every(item=>item.binding!==null&&
      (item.binding.referenceStatus==='not_retrieved'||item.binding.referenceStatus==='current'&&item.decisions.every(decision=>decision.sourceCurrent)));
    return researchReviewFullTextFrozenPhaseSchema.parse({
      ...phase,reviewHash,freeze:sealed===null?null:sealed.receipt,freezeHash:sealed===null?null:sealed.receiptHash,sourcesCurrent
    });
  }
  async freeze(input:ResearchReviewFullTextFreezeRequest,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewFullTextFrozenPhase> {
    const request=researchReviewFullTextFreezeRequestSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    const phase=this.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
    this.requireComplete(phase,request.expectedReviewHash);
    for(const item of phase.items) {
      if(item.binding===null)throw new Error('research_review_screening_incomplete');
      if(item.binding.snapshot.request.outcome.kind==='retrieved')await this.bindings.verifyCurrent({
        projectId:request.projectId,corpusId:request.corpusId,bindingId:item.binding.snapshot.id,expectedBindingHash:item.binding.snapshotHash
      });
    }
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      const current=this.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
      this.requireComplete(current,request.expectedReviewHash);
      const receipt=researchReviewFullTextFreezeReceiptSchema.parse({
        request,requestHash,authority:this.capture(current),reviewHash:current.reviewHash,actor,frozenAt:this.now()
      });
      const json=JSON.stringify(receipt);
      this.db.prepare(`INSERT INTO research_review_screening_freezes
        (project_id,corpus_id,phase,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(request.projectId,request.corpusId,request.phase,request.requestId,json,hash(json),receipt.frozenAt);
      this.db.prepare('UPDATE research_review_screening_plans SET full_freeze_hash=? WHERE corpus_id=? AND full_freeze_hash IS NULL')
        .run(hash(json),request.corpusId);
      const saved=this.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
      if(!saved.plan.currentProtocol||!saved.sourcesCurrent||saved.reviewHash!==request.expectedReviewHash) {
        throw new Error('research_review_screening_version_conflict');
      }
      return saved;
    })();
  }
  requireFrozen(projectId:string,corpusId:string,expectedFreezeHash:string):ResearchReviewFullTextFrozenPhase {
    const phase=this.getPhase({projectId,corpusId,phase:'full_text'});
    if(phase.freeze===null)throw new Error('research_review_screening_not_frozen');
    if(!phase.plan.currentProtocol||!phase.sourcesCurrent||phase.freezeHash!==expectedFreezeHash)throw new Error('research_review_screening_version_conflict');
    return phase;
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private requireComplete(phase:ResearchReviewFullTextFrozenPhase,expectedReviewHash:string):void {
    if(phase.freeze!==null)throw new Error('research_review_screening_already_frozen');
    if(!phase.plan.currentProtocol||phase.reviewHash!==expectedReviewHash)throw new Error('research_review_screening_version_conflict');
    if(!phase.sourcesCurrent||phase.items.some(item=>item.status!=='included'&&item.status!=='excluded'&&item.status!=='not_retrieved')) {
      throw new Error('research_review_screening_incomplete');
    }
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_screening_freezes WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewFullTextFreezeRequest,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewFullTextFrozenPhase {
    if(row.corpus_id!==request.corpusId||row.phase!==request.phase)throw new Error('research_review_request_conflict');
    const previous=this.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:request.phase});
    if(previous.freeze===null||previous.freeze.requestHash!==requestHash||previous.freeze.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private capture(phase:ResearchReviewFullTextResolvedPhase):ResearchReviewFullTextAuthority {
    const counts:ResearchReviewFullTextAuthority['counts']={
      reportsToSeek:phase.items.length,retrieval_pending:0,not_retrieved:0,source_changed:0,pending:0,uncertain:0,conflict:0,included:0,excluded:0
    };
    const items=phase.items.map(item=>{
      const binding=item.binding,decisions=item.decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash}));
      let status:ResearchReviewFullTextAuthority['items'][number]['status'];
      if(binding===null)status='retrieval_pending';
      else if(binding.snapshot.request.outcome.kind==='not_retrieved')status='not_retrieved';
      else if(item.decisions.some(decision=>decision.snapshot.request.bindingId!==binding.snapshot.id||
        decision.snapshot.request.expectedBindingHash!==binding.snapshotHash))status='source_changed';
      else if(item.decisions.length!==phase.plan.snapshot.request.fullTextReviewers.length)status='pending';
      else if(item.decisions.some(decision=>decision.snapshot.request.outcome.decision==='uncertain'))status='uncertain';
      else if(new Set(item.decisions.map(decision=>decision.snapshot.request.outcome.decision)).size>1||
        new Set(item.decisions.flatMap(decision=>{
          const outcome=decision.snapshot.request.outcome;return outcome.decision==='exclude'?[outcome.exclusionCriterionId]:[];
        })).size>1)status='conflict';
      else status=item.decisions[0].snapshot.request.outcome.decision==='include'?'included':'excluded';
      const arbitration=item.arbitration;
      const applied=arbitration!==null&&arbitration.isLatest&&binding!==null&&
        arbitration.snapshot.request.bindingId===binding.snapshot.id&&arbitration.snapshot.request.expectedBindingHash===binding.snapshotHash&&
        arbitration.snapshot.request.decisions.length===decisions.length&&
        arbitration.snapshot.request.decisions.every(ref=>decisions.some(current=>current.id===ref.id&&current.expectedHash===ref.expectedHash))&&
        (status==='conflict'||status==='uncertain')?arbitration:null;
      if(applied!==null)status=applied.snapshot.request.outcome.decision==='include'?'included':'excluded';
      let primaryExclusionCriterionId:string|null=null;
      if(status==='excluded') {
        const outcome=applied===null?item.decisions[0].snapshot.request.outcome:applied.snapshot.request.outcome;
        if(outcome.decision!=='exclude')throw new Error('research_review_screening_snapshot_invalid');
        primaryExclusionCriterionId=outcome.exclusionCriterionId;
      }
      counts[status]++;
      return {hit:item.hit,binding:binding===null?null:{id:binding.snapshot.id,expectedHash:binding.snapshotHash},status,decisions,
        arbitration:applied===null?null:{id:applied.snapshot.id,expectedHash:applied.snapshotHash},primaryExclusionCriterionId};
    });
    return researchReviewFullTextAuthoritySchema.parse({
      corpusId:phase.plan.snapshot.request.corpusId,corpusHash:phase.plan.snapshot.request.expectedCorpusHash,
      planId:phase.plan.snapshot.id,planHash:phase.plan.snapshotHash,titleFreezeHash:phase.titleFreezeHash,phase:phase.phase,items,counts
    });
  }
}
