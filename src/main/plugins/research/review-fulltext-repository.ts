import {createHash,randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewFullTextBindingSaveSchema,researchReviewFullTextSourceSchema,researchReviewFullTextBindingSnapshotSchema,
  researchReviewFullTextBindingInspectionSchema,researchReviewFullTextBindingGetSchema,researchReviewFullTextBindingListSchema,researchReviewFullTextBindingsListSchema,
  researchReviewFullTextBindingVerifySchema,type ResearchReviewFullTextBindingSave,type ResearchReviewFullTextBindingInspection,
  type ResearchReviewFullTextSource
} from '../../../shared/schemas/research-review-fulltext';
import {researchRelationReviewerSchema,type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchDocumentService} from './document-service';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';
import type {ResearchReviewScreeningFreeze} from './review-screening-freeze';
import type {ResearchReviewScreeningFrozenPhase} from '../../../shared/schemas/research-review-screening';
type Row={
  id:string;project_id:string;corpus_id:string;hit_id:string;version:number;parent_id:string|null;document_id:string|null;
  request_id:string;snapshot_json:string;snapshot_hash:string;created_at:string
};
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');

/** Human retrieval status and explicit existing-document linkage, independent from full-text eligibility. */
export class ResearchReviewFullTextRepository {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly corpora:ResearchReviewCorpusRepository,private readonly titles:ResearchReviewScreeningFreeze,
    private readonly documents:Pick<ResearchDocumentService,'source'|'preview'>,private readonly now:()=>string) {}

  async save(input:ResearchReviewFullTextBindingSave,selectedBy:ResearchRelationReviewer):Promise<ResearchReviewFullTextBindingInspection> {
    const request=researchReviewFullTextBindingSaveSchema.parse(input),actor=researchRelationReviewerSchema.parse(selectedBy);
    this.requireWritable(request.projectId);
    const requestHash=hash(JSON.stringify(request));
    const replay=this.findRequest(request.projectId,request.requestId);
    if(replay!==undefined)return this.replay(replay,request,requestHash,actor);
    this.requireIncluded(request);
    const verifiedSource=request.outcome.kind==='retrieved'?this.captureSource(request.projectId,request.outcome.selection):null;
    if(request.outcome.kind==='retrieved') {
      await this.verifyBytes(request.projectId,request.outcome.selection);
    }
    return this.db.transaction(()=>{
      this.requireWritable(request.projectId);
      const repeated=this.findRequest(request.projectId,request.requestId);
      if(repeated!==undefined)return this.replay(repeated,request,requestHash,actor);
      const title=this.requireIncluded(request);
      const latest=this.latest(request.corpusId,request.hitId);
      const parent=latest===undefined?null:this.inspect(latest,title);
      if(parent===null?request.parentBindingId!==null:
          request.parentBindingId!==parent.snapshot.id||request.expectedParentHash!==parent.snapshotHash) {
        throw new Error('research_review_fulltext_version_conflict');
      }
      const raw=this.corpora.getHit({projectId:request.projectId,corpusId:request.corpusId,hitId:request.hitId});
      const source=request.outcome.kind==='retrieved'?this.captureSource(request.projectId,request.outcome.selection):null;
      if(JSON.stringify(source)!==JSON.stringify(verifiedSource))throw new Error('research_review_fulltext_source_changed');
      const snapshot=researchReviewFullTextBindingSnapshotSchema.parse({
        id:`review_fulltext_binding_${randomUUID()}`,version:parent===null?1:parent.snapshot.version+1,request,requestHash,
        hit:raw.reference,searchSource:raw.source,source,actor,recordedAt:this.now()
      });
      const json=JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_fulltext_bindings
        (id,project_id,corpus_id,hit_id,version,parent_id,document_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id,request.projectId,request.corpusId,request.hitId,snapshot.version,
          request.parentBindingId,source===null?null:source.documentId,request.requestId,json,hash(json),snapshot.recordedAt);
      const saved=this.get({projectId:request.projectId,corpusId:request.corpusId,bindingId:snapshot.id});
      if(!saved.currentProtocol||saved.referenceStatus==='superseded')throw new Error('research_review_fulltext_source_changed');
      return saved;
    })();
  }

  get(input:{projectId:string;corpusId:string;bindingId:string}):ResearchReviewFullTextBindingInspection {
    const request=researchReviewFullTextBindingGetSchema.parse(input);this.repository.getProject(request.projectId);
    const row=this.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE id=?').get(request.bindingId) as Row|undefined;
    if(row===undefined)throw new Error('research_review_fulltext_binding_not_found');
    if(row.project_id!==request.projectId||row.corpus_id!==request.corpusId)throw new Error('research_review_project_mismatch');
    return this.inspect(row,this.titles.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'title_abstract'}));
  }
  history(input:{projectId:string;corpusId:string;hitId:string}):ResearchReviewFullTextBindingInspection[] {
    const request=researchReviewFullTextBindingListSchema.parse(input);
    this.corpora.getHit({projectId:request.projectId,corpusId:request.corpusId,hitId:request.hitId});
    const title=this.titles.getPhase({projectId:request.projectId,corpusId:request.corpusId,phase:'title_abstract'});
    return (this.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE project_id=? AND corpus_id=? AND hit_id=? ORDER BY version')
      .all(request.projectId,request.corpusId,request.hitId) as Row[]).map(row=>this.inspect(row,title));
  }
  list(input:{projectId:string;corpusId:string}):ResearchReviewFullTextBindingInspection[] {
    const request=researchReviewFullTextBindingsListSchema.parse(input);
    const title=this.titles.getPhase({...request,phase:'title_abstract'});
    return (this.db.prepare(`SELECT * FROM research_review_fulltext_bindings b WHERE project_id=? AND corpus_id=? AND
      version=(SELECT MAX(version) FROM research_review_fulltext_bindings WHERE corpus_id=b.corpus_id AND hit_id=b.hit_id) ORDER BY rowid`)
      .all(request.projectId,request.corpusId) as Row[]).map(row=>this.inspect(row,title));
  }

  async verifyCurrent(input:{projectId:string;corpusId:string;bindingId:string;expectedBindingHash:string}):Promise<ResearchReviewFullTextBindingInspection> {
    const request=researchReviewFullTextBindingVerifySchema.parse(input);this.requireWritable(request.projectId);
    const read=()=>this.get({projectId:request.projectId,corpusId:request.corpusId,bindingId:request.bindingId});
    const selected=read();this.requireCurrent(selected,request.expectedBindingHash);
    if(selected.snapshot.request.outcome.kind!=='retrieved')throw new Error('research_review_fulltext_not_retrieved');
    await this.verifyBytes(request.projectId,selected.snapshot.request.outcome.selection);
    this.requireWritable(request.projectId);
    const current=read();this.requireCurrent(current,request.expectedBindingHash);
    return current;
  }

  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private requireCurrent(binding:ResearchReviewFullTextBindingInspection,expectedHash:string):void {
    if(!binding.isLatest||!binding.currentProtocol||binding.snapshotHash!==expectedHash||binding.referenceStatus==='superseded') {
      throw new Error('research_review_fulltext_version_conflict');
    }
  }
  private requireIncluded(request:ResearchReviewFullTextBindingSave):ResearchReviewScreeningFrozenPhase {
    const title=this.titles.requireFrozen(request.projectId,request.corpusId,request.expectedTitleFreezeHash);
    if(title.freeze===null||!title.freeze.authority.items.some(item=>item.hit.id===request.hitId&&item.status==='included')) {
      throw new Error('research_review_fulltext_hit_not_included');
    }
    return title;
  }
  private findRequest(projectId:string,requestId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE project_id=? AND request_id=?').get(projectId,requestId) as Row|undefined;
  }
  private latest(corpusId:string,hitId:string):Row|undefined {
    return this.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE corpus_id=? AND hit_id=? ORDER BY version DESC LIMIT 1')
      .get(corpusId,hitId) as Row|undefined;
  }
  private replay(row:Row,request:ResearchReviewFullTextBindingSave,requestHash:string,actor:ResearchRelationReviewer):ResearchReviewFullTextBindingInspection {
    if(row.corpus_id!==request.corpusId)throw new Error('research_review_request_conflict');
    const previous=this.get({projectId:row.project_id,corpusId:row.corpus_id,bindingId:row.id});
    if(previous.snapshot.requestHash!==requestHash||previous.snapshot.actor.id!==actor.id)throw new Error('research_review_request_conflict');
    return previous;
  }
  private async verifyBytes(projectId:string,selection:Extract<ResearchReviewFullTextBindingSave['outcome'],{kind:'retrieved'}>['selection']):Promise<void> {
    if(selection.parseId===null) {
      await this.documents.source({projectId,documentId:selection.documentId,sourceHash:selection.sourceHash});
    }else {
      await this.documents.preview({projectId,documentId:selection.documentId,sourceHash:selection.sourceHash,
        parseId:selection.parseId,parseHash:selection.parseHash});
    }
  }
  private captureSource(projectId:string,selection:Extract<ResearchReviewFullTextBindingSave['outcome'],{kind:'retrieved'}>['selection']):ResearchReviewFullTextSource {
    const document=this.repository.documents.get(selection.documentId),library=this.repository.library.get(document.libraryItemId);
    if(!library.projectIds.includes(projectId))throw new Error('research_document_project_mismatch');
    if(library.archived)throw new Error('research_library_item_archived');
    if(document.sourceHash!==selection.sourceHash)throw new Error('research_document_source_changed');
    let parse:ResearchReviewFullTextSource['parse']=null;
    if(selection.parseId!==null) {
      if(document.currentParseId!==selection.parseId)throw new Error('research_review_fulltext_source_changed');
      const {data}=this.repository.documents.parsed(document.id,selection.parseId),parseHash=hash(JSON.stringify(data.content));
      if(parseHash!==selection.parseHash||data.content.sourceHash!==selection.sourceHash)throw new Error('research_document_preview_parse_changed');
      const coordinates=this.repository.documents.coordinates(document.id,selection.parseId);
      parse={id:selection.parseId,hash:parseHash,parserFingerprint:data.content.parserFingerprint,pageCount:data.content.pageCount,
        coordinateHash:coordinates===null?null:coordinates.snapshotHash};
    }
    return researchReviewFullTextSourceSchema.parse({
      documentId:document.id,libraryItemId:document.libraryItemId,sourceHash:document.sourceHash,
      filename:document.filename,mediaType:document.mediaType,size:document.size,parse
    });
  }
  private read(row:Row,title:ResearchReviewScreeningFrozenPhase):ResearchReviewFullTextBindingInspection['snapshot'] {
    const snapshot=researchReviewFullTextBindingSnapshotSchema.parse(JSON.parse(row.snapshot_json)),request=snapshot.request;
    if(hash(row.snapshot_json)!==row.snapshot_hash||JSON.stringify(snapshot)!==row.snapshot_json||snapshot.id!==row.id||
        request.projectId!==row.project_id||request.corpusId!==row.corpus_id||request.hitId!==row.hit_id||
        snapshot.version!==row.version||request.parentBindingId!==row.parent_id||request.requestId!==row.request_id||
        snapshot.recordedAt!==row.created_at||snapshot.requestHash!==hash(JSON.stringify(request))||
        (snapshot.version===1)!==(request.parentBindingId===null)||
        row.document_id!==(snapshot.source===null?null:snapshot.source.documentId))throw new Error('research_review_fulltext_snapshot_invalid');
    if(title.plan.snapshot.request.projectId!==request.projectId||title.plan.snapshot.request.corpusId!==request.corpusId||
        title.freezeHash!==request.expectedTitleFreezeHash||title.freeze===null||
        !title.freeze.authority.items.some(item=>item.hit.id===request.hitId&&item.status==='included'))throw new Error('research_review_fulltext_snapshot_invalid');
    const raw=this.corpora.getHit({projectId:request.projectId,corpusId:request.corpusId,hitId:request.hitId});
    if(JSON.stringify(snapshot.hit)!==JSON.stringify(raw.reference)||JSON.stringify(snapshot.searchSource)!==JSON.stringify(raw.source)) {
      throw new Error('research_review_fulltext_snapshot_invalid');
    }
    if(request.outcome.kind==='retrieved') {
      const source=snapshot.source;
      if(source===null||source.documentId!==request.outcome.selection.documentId||source.sourceHash!==request.outcome.selection.sourceHash||
          (source.parse===null)!==(request.outcome.selection.parseId===null)||
          (source.parse!==null&&(source.parse.id!==request.outcome.selection.parseId||source.parse.hash!==request.outcome.selection.parseHash))) {
        throw new Error('research_review_fulltext_snapshot_invalid');
      }
      const document=this.repository.documents.get(source.documentId);
      if(document.libraryItemId!==source.libraryItemId)throw new Error('research_review_fulltext_snapshot_invalid');
      if(source.parse!==null) {
        const {data}=this.repository.documents.parsed(source.documentId,source.parse.id);
        const coordinates=this.repository.documents.coordinates(source.documentId,source.parse.id);
        if(hash(JSON.stringify(data.content))!==source.parse.hash||data.content.parserFingerprint!==source.parse.parserFingerprint||
            data.content.sourceHash!==source.sourceHash||data.content.pageCount!==source.parse.pageCount||
            (coordinates===null?null:coordinates.snapshotHash)!==source.parse.coordinateHash)throw new Error('research_review_fulltext_snapshot_invalid');
      }
    }
    return snapshot;
  }
  private inspect(row:Row,title:ResearchReviewScreeningFrozenPhase):ResearchReviewFullTextBindingInspection {
    const snapshot=this.read(row,title);let child=snapshot;
    while(child.request.parentBindingId!==null) {
      const parent=this.db.prepare('SELECT * FROM research_review_fulltext_bindings WHERE id=?').get(child.request.parentBindingId) as Row|undefined;
      if(parent===undefined)throw new Error('research_review_fulltext_snapshot_invalid');
      const previous=this.read(parent,title);
      if(previous.version!==child.version-1||previous.request.corpusId!==child.request.corpusId||
          previous.request.hitId!==child.request.hitId||parent.snapshot_hash!==child.request.expectedParentHash)throw new Error('research_review_fulltext_snapshot_invalid');
      child=previous;
    }
    const latest=this.latest(row.corpus_id,row.hit_id);
    if(latest===undefined)throw new Error('research_review_fulltext_snapshot_invalid');
    let referenceStatus:ResearchReviewFullTextBindingInspection['referenceStatus']='not_retrieved';
    if(snapshot.source!==null) {
      const document=this.repository.documents.get(snapshot.source.documentId),library=this.repository.library.get(snapshot.source.libraryItemId);
      referenceStatus=document.sourceHash===snapshot.source.sourceHash&&!library.archived&&library.projectIds.includes(row.project_id)&&
        (snapshot.source.parse===null||document.currentParseId===snapshot.source.parse.id)?'current':'superseded';
    }
    return researchReviewFullTextBindingInspectionSchema.parse({
      snapshot,snapshotHash:row.snapshot_hash,isLatest:latest.id===row.id,currentProtocol:title.plan.currentProtocol,referenceStatus
    });
  }
}
