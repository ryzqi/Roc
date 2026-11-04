import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewExtractionSaveSchema,researchReviewExtractionSnapshotSchema,researchReviewExtractionInspectionSchema,
  researchReviewExtractionSourceSchema,researchReviewExtractionGetSchema,researchReviewExtractionHistorySchema,researchReviewExtractionListSchema,
  type ResearchReviewExtractionSave,type ResearchReviewExtractionInspection,type ResearchReviewExtractionSource
} from '../../../shared/schemas/research-review-extraction';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchReviewFullTextFrozenPhase} from '../../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewFullTextBindingInspection,ResearchReviewFullTextSource} from '../../../shared/schemas/research-review-fulltext';
import type {ResearchReviewProtocolInspection} from '../../../shared/schemas/research-systematic-review';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
import type {ResearchDocumentService} from './document-service';
import {readCurrentEvidenceSourceLocator} from './evidence-source-locator';
type Row={
  id:string;project_id:string;corpus_id:string;hit_id:string;binding_id:string;version:number;parent_id:string|null;
  request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string
};
type Context={freeze:ResearchReviewFullTextFrozenPhase;binding:ResearchReviewFullTextBindingInspection;source:ResearchReviewFullTextSource;
  protocol:ResearchReviewProtocolInspection};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Human-confirmed extraction links existing immutable evidence and declared units to the fixed included report. */
export class ResearchReviewExtractionRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly freezing:ResearchReviewFullTextFreeze,private readonly bindings:ResearchReviewFullTextRepository,
    private readonly documents:Pick<ResearchDocumentService,'preview'>,private readonly now:()=>string) {}

  async save(input:ResearchReviewExtractionSave,reviewedBy:ResearchRelationReviewer):Promise<ResearchReviewExtractionInspection> {
    const request=researchReviewExtractionSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(reviewedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request)),replay=this.requestRow(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    const context=this.context(request);this.requireCurrent(context);
    this.validateFields(request,context);
    const sources=this.captureSources(request,context);
    for(const source of sources)this.requireCurrentSource(source,context);
    await this.bindings.verifyCurrent({projectId:request.projectId,corpusId:request.corpusId,
      bindingId:request.bindingId,expectedBindingHash:request.expectedBindingHash});
    const verifiedParses=new Set<string>();
    for(const source of sources) {
      const locator=source.sourceLocator,key=JSON.stringify([locator.documentId,locator.parseId,locator.parseHash]);
      if(verifiedParses.has(key))continue;
      await this.documents.preview({projectId:request.projectId,documentId:locator.documentId,
        sourceHash:locator.sourceHash,parseId:locator.parseId,parseHash:locator.parseHash});
      verifiedParses.add(key);
    }
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.requestRow(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      const current=this.context(request);this.requireCurrent(current);this.validateFields(request,current);
      const captured=this.captureSources(request,current);
      if(JSON.stringify(captured)!==JSON.stringify(sources))throw new Error('research_review_extraction_source_changed');
      for(const source of captured)this.requireCurrentSource(source,current);
      const latest=this.latest(request.corpusId,request.hitId),parent=latest===undefined?null:this.inspect(latest,current);
      if(parent===null?request.parentExtractionId!==null:
        request.parentExtractionId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash)throw new Error('research_review_extraction_version_conflict');
      const reviewer=this.reviewer(request,current);
      const snapshot=researchReviewExtractionSnapshotSchema.parse({
        id:`review_extraction_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,request,requestHash,
        protocolVersionId:current.protocol.version.id,protocolVersionHash:current.protocol.versionHash,hit:current.binding.snapshot.hit,
        fieldDefinitions:current.protocol.version.body.extractionFields,sources:captured,reviewer,actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_extractions
        (id,project_id,corpus_id,hit_id,binding_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.hitId,request.bindingId,
          snapshot.version,request.parentExtractionId,request.requestId,json,hash(json),snapshot.recordedAt);
      const row=this.latest(request.corpusId,request.hitId);
      if(row===undefined||row.id!==snapshot.id)throw new Error('research_review_extraction_snapshot_invalid');
      const fresh=this.context(request),saved=this.inspect(row,fresh);
      if(saved.snapshotHash!==hash(json))throw new Error('research_review_extraction_snapshot_invalid');
      if(!saved.currentProtocol||saved.referenceStatus!=='current'||!saved.isLatest)throw new Error('research_review_extraction_source_changed');
      return saved;
    })();
  }
  get(input:{projectId:string;corpusId:string;extractionId:string}):ResearchReviewExtractionInspection {
    const request=researchReviewExtractionGetSchema.parse(input);this.repository.getProject(request.projectId);
    const row=this.db.prepare('SELECT * FROM research_review_extractions WHERE id=?').get(request.extractionId) as Row|undefined;
    if(row===undefined)throw new Error('research_review_extraction_not_found');
    if(row.project_id!==request.projectId||row.corpus_id!==request.corpusId)throw new Error('research_review_project_mismatch');
    return this.inspect(row);
  }
  history(input:{projectId:string;corpusId:string;hitId:string}):ResearchReviewExtractionInspection[] {
    const request=researchReviewExtractionHistorySchema.parse(input);
    this.freezing.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'full_text'});
    return (this.db.prepare('SELECT * FROM research_review_extractions WHERE project_id=? AND corpus_id=? AND hit_id=? ORDER BY version')
      .all(request.projectId,request.corpusId,request.hitId) as Row[]).map(row=>this.inspect(row));
  }
  list(input:{projectId:string;corpusId:string}):ResearchReviewExtractionInspection[] {
    const request=researchReviewExtractionListSchema.parse(input);
    this.freezing.getPhase({...request,phase:'full_text'});
    return (this.db.prepare(`SELECT * FROM research_review_extractions e WHERE project_id=? AND corpus_id=? AND
      version=(SELECT MAX(version) FROM research_review_extractions WHERE corpus_id=e.corpus_id AND hit_id=e.hit_id) ORDER BY rowid`)
      .all(request.projectId,request.corpusId) as Row[]).map(row=>this.inspect(row));
  }

  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private context(request:ResearchReviewExtractionSave):Context {
    const freeze=this.freezing.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'full_text'});
    if(freeze.freeze===null)throw new Error('research_review_screening_not_frozen');
    if(freeze.freezeHash!==request.expectedFullFreezeHash)throw new Error('research_review_extraction_version_conflict');
    const item=freeze.freeze.authority.items.find(item=>item.hit.id===request.hitId);
    if(item===undefined||item.status!=='included')throw new Error('research_review_extraction_hit_not_included');
    const binding=this.bindings.get({projectId:request.projectId,corpusId:request.corpusId,bindingId:request.bindingId});
    if(item.binding===null||item.binding.id!==request.bindingId||item.binding.expectedHash!==request.expectedBindingHash||
      binding.snapshotHash!==request.expectedBindingHash||binding.snapshot.request.hitId!==request.hitId)throw new Error('research_review_extraction_version_conflict');
    const source=binding.snapshot.source;
    if(source===null)throw new Error('research_review_fulltext_not_retrieved');
    const protocol=this.repository.systematicReviews.get({projectId:request.projectId,versionId:freeze.plan.snapshot.protocolVersionId});
    return {freeze,binding,source,protocol};
  }
  private requireCurrent(context:Context):void {
    if(!context.freeze.plan.currentProtocol||!context.freeze.sourcesCurrent||!context.binding.isLatest||
      context.binding.referenceStatus!=='current')throw new Error('research_review_extraction_version_conflict');
  }
  private reviewer(request:ResearchReviewExtractionSave,context:Context) {
    const reviewer=[...context.freeze.plan.snapshot.request.fullTextReviewers,context.freeze.plan.snapshot.request.adjudicator]
      .find(reviewer=>reviewer.id===request.reviewerId);
    if(reviewer===undefined)throw new Error('research_review_screening_reviewer_not_declared');
    return reviewer;
  }
  private validateFields(request:ResearchReviewExtractionSave,context:Context):void {
    this.reviewer(request,context);
    const declared=context.protocol.version.body.extractionFields;
    if(declared.some(field=>field.required&&!request.fields.some(value=>value.fieldId===field.id)))throw new Error('research_review_extraction_required_field_missing');
    for(const field of request.fields) {
      const definition=declared.find(value=>value.id===field.fieldId);
      if(definition===undefined)throw new Error('research_review_extraction_field_not_declared');
      if(field.unit!==definition.unit||field.value.kind==='number'&&field.unit===null)throw new Error('research_review_extraction_unit_mismatch');
    }
  }
  private captureSources(request:ResearchReviewExtractionSave,context:Context):ResearchReviewExtractionSource[] {
    const refs=new Map<string,string>();
    for(const ref of [...request.studyDesign.evidence,...request.fields.flatMap(field=>field.evidence)]) {
      if(refs.has(ref.id)&&refs.get(ref.id)!==ref.expectedHash)throw new Error('research_review_extraction_version_conflict');
      refs.set(ref.id,ref.expectedHash);
    }
    return [...refs].map(([id,expectedHash])=>{
      const inspected=this.repository.evidence.inspectEvidence(id,request.projectId),locator=inspected.sourceLocator;
      if(locator===null)throw new Error('research_review_extraction_source_unlocated');
      const digest=hash(JSON.stringify({evidence:inspected.evidence,sourceLocator:locator}));
      if(digest!==expectedHash)throw new Error('research_review_extraction_version_conflict');
      if(locator.documentId!==context.source.documentId||locator.sourceHash!==context.source.sourceHash||
        context.source.parse!==null&&(locator.parseId!==context.source.parse.id||locator.parseHash!==context.source.parse.hash)) {
        throw new Error('research_review_extraction_source_mismatch');
      }
      const coordinates=this.repository.documents.coordinates(locator.documentId,locator.parseId);
      return researchReviewExtractionSourceSchema.parse({
        evidence:inspected.evidence,sourceLocator:locator,coordinateHash:coordinates===null?null:coordinates.snapshotHash,digest
      });
    });
  }
  private sourceCurrent(source:ResearchReviewExtractionSource,context:Context):boolean {
    const inspected=this.repository.evidence.inspectEvidence(source.evidence.id,source.evidence.projectId);
    const document=this.repository.documents.get(source.sourceLocator.documentId);
    if(inspected.referenceStatus!=='recorded'||document.currentParseId!==source.sourceLocator.parseId||
      document.sourceHash!==source.sourceLocator.sourceHash||context.binding.referenceStatus!=='current')return false;
    const current=readCurrentEvidenceSourceLocator(this.db,source.evidence);
    return current!==null&&JSON.stringify(current)===JSON.stringify(source.sourceLocator);
  }
  private requireCurrentSource(source:ResearchReviewExtractionSource,context:Context):void {
    if(!this.sourceCurrent(source,context))throw new Error('research_review_extraction_source_changed');
  }
  private requestRow(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_extractions WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private latest(corpusId:string,hitId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_extractions WHERE corpus_id=? AND hit_id=? ORDER BY version DESC LIMIT 1')
      .get(corpusId,hitId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewExtractionSave,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewExtractionInspection {
    if(row.corpus_id!==request.corpusId)throw new Error('research_review_request_conflict');
    const previous=this.inspect(row);
    if(previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private read(row:Row,context:Context):ResearchReviewExtractionInspection['snapshot'] {
    const snapshot=researchReviewExtractionSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
      request.projectId!==row.project_id||request.corpusId!==row.corpus_id||request.hitId!==row.hit_id||request.bindingId!==row.binding_id||
      request.projectId!==context.freeze.plan.snapshot.request.projectId||request.corpusId!==context.freeze.plan.snapshot.request.corpusId||
      request.hitId!==context.binding.snapshot.request.hitId||request.bindingId!==context.binding.snapshot.id||
      request.expectedBindingHash!==context.binding.snapshotHash||request.expectedFullFreezeHash!==context.freeze.freezeHash||
      snapshot.version!==row.version||request.parentExtractionId!==row.parent_id||request.requestId!==row.request_id||
      snapshot.recordedAt!==row.created_at||snapshot.requestHash!==hash(JSON.stringify(request))||
      (snapshot.version===1)!==(request.parentExtractionId===null)||snapshot.protocolVersionId!==context.protocol.version.id||
      snapshot.protocolVersionHash!==context.protocol.versionHash||JSON.stringify(snapshot.hit)!==JSON.stringify(context.binding.snapshot.hit)||
      JSON.stringify(snapshot.fieldDefinitions)!==JSON.stringify(context.protocol.version.body.extractionFields)||
      JSON.stringify(snapshot.reviewer)!==JSON.stringify(this.reviewer(request,context))||
      JSON.stringify(snapshot.sources)!==JSON.stringify(this.captureSources(request,context)))throw new Error('research_review_extraction_snapshot_invalid');
    this.validateFields(request,context);
    return snapshot;
  }
  private inspect(row:Row,selectedContext?:Context):ResearchReviewExtractionInspection {
    const context=selectedContext===undefined?this.context(researchReviewExtractionSnapshotSchema.parse(JSON.parse(row.snapshot_json)).request):selectedContext;
    const snapshot=this.read(row,context);let child=snapshot;
    while(child.request.parentExtractionId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_extractions WHERE id=?').get(child.request.parentExtractionId) as Row|undefined;
      if(parent===undefined)throw new Error('research_review_extraction_snapshot_invalid');
      const previous=this.read(parent,context);
      if(previous.version!==child.version-1||previous.request.hitId!==child.request.hitId||
        parent.snapshot_hash!==child.request.expectedParentHash)throw new Error('research_review_extraction_snapshot_invalid');
      child=previous;
    }
    const latest=this.latest(row.corpus_id,row.hit_id);
    if(latest===undefined)throw new Error('research_review_extraction_snapshot_invalid');
    return researchReviewExtractionInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,currentProtocol:context.freeze.plan.currentProtocol,
      referenceStatus:context.binding.referenceStatus==='current'&&snapshot.sources.every(source=>this.sourceCurrent(source,context))?'current':'superseded'
    });
  }
}
