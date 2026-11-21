import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchExternalExperimentCreateSchema,researchExternalExperimentContractSchema,researchExternalExperimentBindSchema,
  researchExternalExperimentGetSchema,researchExternalExperimentListSchema,researchExternalExperimentRecordSchema,
  researchExternalExperimentReportSchema,researchExternalExperimentPreviewSchema,researchExternalExperimentImportSchema,
  researchExternalExperimentResultSchema,researchExternalExperimentResultGetSchema,researchExternalExperimentResultsListSchema,
  researchExternalExperimentCaptureSchema,researchExternalExperimentDerivationSchema,researchExternalExperimentPreviewResultSchema,
  externalReportVerification,type ResearchExternalExperimentCreate,type ResearchExternalExperimentBind,
  type ResearchExternalExperimentGet,type ResearchExternalExperimentList,type ResearchExternalExperimentRecord,
  type ResearchExternalExperimentPreview,type ResearchExternalExperimentPreviewResult,type ResearchExternalExperimentImport,
  type ResearchExternalExperimentResult,type ResearchExternalExperimentResultGet,type ResearchExternalExperimentResultsList,
  type ResearchExternalExperimentCapture,type ResearchExternalExperimentDerivation
} from '../../../shared/schemas/research-external-experiments';
import type {ResearchEvidence} from '../../../shared/types';
import type {ResearchRepository} from './repository';
import {requireResearchHuman} from '../../services/research-human-context';
import {readResearchFile,researchContentHash,researchWorkspace} from './research-files';
import {buildMetricFigureSources} from './metric-figure-source';

type Row={id:string;project_id:string;artifact_id:string;request_id:string;snapshot_json:string;snapshot_hash:string;
  binding_json:string|null;binding_hash:string|null;provider:string|null;external_id:string|null;bind_request_id:string|null};
type ResultRow={id:string;project_id:string;contract_id:string;request_id:string;snapshot_json:string;snapshot_hash:string;original_bytes:Buffer};
const digest=(value:unknown):string=>researchContentHash(JSON.stringify(value));

/** External reports are immutable human-reviewed documents, never managed local executions. */
export class ExternalExperimentService {
  constructor(private readonly db:Database,private readonly research:ResearchRepository,private readonly now:()=>string){}

  validateDraft(input:ResearchExternalExperimentCreate):string {
    const request=researchExternalExperimentCreateSchema.parse(input);this.writable(request.projectId);
    const inspected=this.research.inspectArtifact({projectId:request.projectId,artifactId:request.artifactId,expectedVersion:request.expectedArtifactVersion});
    if(inspected.status!=='current'||inspected.snapshot.artifact.status==='superseded')throw new Error('research_external_experiment_source_changed');
    return inspected.snapshot.version;
  }
  create(input:ResearchExternalExperimentCreate):ResearchExternalExperimentRecord {
    const request=researchExternalExperimentCreateSchema.parse(input),actor=requireResearchHuman('research.externalExperiments.create',request.projectId);
    return this.db.transaction(()=>{
      this.writable(request.projectId);
      const prior=this.db.prepare('SELECT * FROM research_external_experiments WHERE project_id=? AND request_id=?').get(request.projectId,request.requestId) as Row|undefined;
      if(prior!==undefined){const saved=this.readContract(prior);if(saved.snapshot.requestHash!==digest(request)||saved.snapshot.actor.id!==actor.id)throw new Error('research_external_experiment_request_conflict');return this.get({projectId:request.projectId,contractId:prior.id});}
      this.validateDraft(request);
      const snapshot=researchExternalExperimentContractSchema.shape.snapshot.parse({schemaVersion:1,id:`external_experiment_${randomUUID()}`,request,
        requestHash:digest(request),actor,recordedAt:this.now()});
      const json=JSON.stringify(snapshot);
      this.db.prepare('INSERT INTO research_external_experiments(id,project_id,artifact_id,request_id,snapshot_json,snapshot_hash) VALUES (?,?,?,?,?,?)')
        .run(snapshot.id,request.projectId,request.artifactId,request.requestId,json,researchContentHash(json));
      return this.get({projectId:request.projectId,contractId:snapshot.id});
    })();
  }
  bind(input:ResearchExternalExperimentBind):ResearchExternalExperimentRecord {
    const request=researchExternalExperimentBindSchema.parse(input),actor=requireResearchHuman('research.externalExperiments.bind',request.projectId);
    return this.db.transaction(()=>{
      this.writable(request.projectId);const record=this.get({projectId:request.projectId,contractId:request.contractId});
      if(record.binding!==null){if(digest(record.binding.request)!==digest(request)||record.binding.actor.id!==actor.id)throw new Error('research_external_experiment_request_conflict');return record;}
      if(record.recordHash!==request.expectedRecordHash)throw new Error('research_external_experiment_record_changed');
      if(this.db.prepare('SELECT 1 FROM research_external_experiments WHERE project_id=? AND provider=? AND external_id=?').get(request.projectId,request.provider,request.externalId)!==undefined)throw new Error('research_external_experiment_assignment_exists');
      if(this.db.prepare('SELECT 1 FROM research_external_experiments WHERE project_id=? AND bind_request_id=?').get(request.projectId,request.requestId)!==undefined)throw new Error('research_external_experiment_request_conflict');
      const binding={request,actor,recordedAt:this.now()},json=JSON.stringify(binding);
      this.db.prepare('UPDATE research_external_experiments SET binding_json=?,binding_hash=?,provider=?,external_id=?,bind_request_id=? WHERE id=?')
        .run(json,researchContentHash(json),request.provider,request.externalId,request.requestId,request.contractId);
      return this.get({projectId:request.projectId,contractId:request.contractId});
    })();
  }
  get(input:ResearchExternalExperimentGet):ResearchExternalExperimentRecord {
    const request=researchExternalExperimentGetSchema.parse(input),row=this.contractRow(request.projectId,request.contractId),contract=this.readContract(row);
    const binding=row.binding_json===null?null:researchExternalExperimentRecordSchema.shape.binding.unwrap().parse(JSON.parse(row.binding_json));
    if(binding===null&&(row.binding_hash!==null||row.provider!==null||row.external_id!==null||row.bind_request_id!==null))throw new Error('research_external_experiment_snapshot_invalid');
    if(binding!==null&&(JSON.stringify(binding)!==row.binding_json||researchContentHash(row.binding_json!)!==row.binding_hash||
      binding.request.projectId!==row.project_id||binding.request.contractId!==row.id||binding.request.provider!==row.provider||binding.request.externalId!==row.external_id||binding.request.requestId!==row.bind_request_id))throw new Error('research_external_experiment_snapshot_invalid');
    const latest=this.db.prepare('SELECT id,snapshot_hash FROM research_external_experiment_results WHERE contract_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as {id:string;snapshot_hash:string}|undefined;
    const resultCount=this.db.prepare('SELECT count(*) FROM research_external_experiment_results WHERE contract_id=?').pluck().get(row.id) as number;
    const latestResult=latest===undefined?null:{resultId:latest.id,expectedHash:latest.snapshot_hash};
    const source=this.research.inspectArtifact({projectId:request.projectId,artifactId:row.artifact_id,expectedVersion:contract.snapshot.request.expectedArtifactVersion});
    const body={contract,binding,status:latestResult!==null?'reported' as const:binding===null?'unbound' as const:'waiting' as const,
      sourceCurrent:source.status==='current'&&source.snapshot.artifact.status!=='superseded',latestResult,resultCount};
    return researchExternalExperimentRecordSchema.parse({...body,recordHash:digest({contractHash:contract.snapshotHash,binding,latestResult,resultCount})});
  }
  list(input:ResearchExternalExperimentList):{items:ResearchExternalExperimentRecord[];total:number}{
    const request=researchExternalExperimentListSchema.parse(input);this.research.getProject(request.projectId);
    if(request.artifactId!==undefined&&this.research.getArtifact(request.artifactId).projectId!==request.projectId)throw new Error('research_external_experiment_project_mismatch');
    const query='project_id=? AND (? IS NULL OR artifact_id=?)',params=[request.projectId,request.artifactId??null,request.artifactId??null];
    const rows=this.db.prepare(`SELECT id FROM research_external_experiments WHERE ${query} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...params,request.limit,request.offset) as {id:string}[];
    const total=this.db.prepare(`SELECT count(*) FROM research_external_experiments WHERE ${query}`).pluck().get(...params) as number;
    return {items:rows.map(row=>this.get({projectId:request.projectId,contractId:row.id})),total};
  }
  async previewImport(input:ResearchExternalExperimentPreview):Promise<ResearchExternalExperimentPreviewResult>{
    const request=researchExternalExperimentPreviewSchema.parse(input),material=await this.readImport(request);
    return material.preview;
  }
  async importResult(input:ResearchExternalExperimentImport):Promise<ResearchExternalExperimentResult>{
    const request=researchExternalExperimentImportSchema.parse(input),actor=requireResearchHuman('research.externalExperiments.importResult',request.projectId);
    this.writable(request.projectId);
    const replay=()=>{
      const row=this.db.prepare('SELECT * FROM research_external_experiment_results WHERE project_id=? AND request_id=?').get(request.projectId,request.requestId) as ResultRow|undefined;
      if(row===undefined)return null;
      const saved=this.readResult(row);if(saved.snapshot.requestHash!==digest(request)||saved.snapshot.actor.id!==actor.id)throw new Error('research_external_experiment_request_conflict');return saved;
    };
    const prior=replay();if(prior!==null)return prior;
    const material=await this.readImport(request);
    if(material.preview.recordHash!==request.expectedRecordHash||material.preview.original.sha256!==request.expectedResultHash)throw new Error('research_external_experiment_record_changed');
    return this.db.transaction(()=>{
      this.writable(request.projectId);const prior=replay();if(prior!==null)return prior;
      const record=this.get({projectId:request.projectId,contractId:request.contractId});
      if(record.recordHash!==request.expectedRecordHash||record.binding===null)throw new Error('research_external_experiment_record_changed');
      const snapshot=researchExternalExperimentResultSchema.shape.snapshot.parse({schemaVersion:1,id:`external_result_${randomUUID()}`,request,requestHash:digest(request),
        contractHash:record.contract.snapshotHash,provider:record.binding.request.provider,externalId:record.binding.request.externalId,
        report:material.preview.report,original:material.preview.original,files:material.preview.files,
        verification:externalReportVerification,actor,recordedAt:this.now()});
      const json=JSON.stringify(snapshot),snapshotHash=researchContentHash(json);
      this.db.prepare('INSERT INTO research_external_experiment_results(id,project_id,contract_id,request_id,snapshot_json,snapshot_hash,original_bytes) VALUES (?,?,?,?,?,?,?)')
        .run(snapshot.id,request.projectId,request.contractId,request.requestId,json,snapshotHash,material.original);
      const insert=this.db.prepare('INSERT INTO research_external_experiment_files(result_id,path,bytes) VALUES (?,?,?)');
      material.files.forEach(file=>insert.run(snapshot.id,file.path,file.bytes));
      return this.getResult({projectId:request.projectId,resultId:snapshot.id,expectedHash:snapshotHash});
    })();
  }
  getResult(input:ResearchExternalExperimentResultGet):ResearchExternalExperimentResult{
    const request=researchExternalExperimentResultGetSchema.parse(input);this.research.getProject(request.projectId);
    const row=this.db.prepare('SELECT * FROM research_external_experiment_results WHERE id=?').get(request.resultId) as ResultRow|undefined;
    if(row===undefined)throw new Error('research_external_experiment_result_not_found');
    if(row.project_id!==request.projectId)throw new Error('research_external_experiment_project_mismatch');
    if(row.snapshot_hash!==request.expectedHash)throw new Error('research_external_experiment_result_changed');
    return this.readResult(row);
  }
  listResults(input:ResearchExternalExperimentResultsList):{items:Array<{resultId:string;expectedHash:string}>;total:number}{
    const request=researchExternalExperimentResultsListSchema.parse(input);this.contractRow(request.projectId,request.contractId);
    const rows=this.db.prepare('SELECT id,snapshot_hash FROM research_external_experiment_results WHERE contract_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(request.contractId,request.limit,request.offset) as {id:string;snapshot_hash:string}[];
    return {items:rows.map(row=>({resultId:row.id,expectedHash:row.snapshot_hash})),total:this.db.prepare('SELECT count(*) FROM research_external_experiment_results WHERE contract_id=?').pluck().get(request.contractId) as number};
  }
  captureMetric(input:ResearchExternalExperimentCapture):ResearchEvidence{
    const request=researchExternalExperimentCaptureSchema.parse(input);requireResearchHuman('research.externalExperiments.captureMetric',request.projectId);this.writable(request.projectId);
    const receipt=this.getResult({projectId:request.projectId,resultId:request.resultId,expectedHash:request.expectedHash}),source=this.metricSource(receipt,request.metricId);
    return this.db.transaction(()=>{
      const existing=this.findMetric(receipt,request.metricId);if(existing!==null)return existing;
      this.research.knowledge.upsertFromSource({id:source.id,projectId:request.projectId,sourceType:'file',sourceId:receipt.snapshot.request.contractId,
        title:source.title,content:source.content,chunks:[{content:source.content,locator:source.locator}],embeddingPolicy:'none'},source.metadata);
      return this.research.evidence.capture({projectId:request.projectId,chunkId:`${source.id}:chunk:0`});
    })();
  }
  derive(input:ResearchExternalExperimentResultGet):ResearchExternalExperimentDerivation{
    const request=researchExternalExperimentResultGetSchema.parse(input),receipt=this.getResult(request),contract=this.readContract(this.contractRow(request.projectId,receipt.snapshot.request.contractId));
    const rows=receipt.snapshot.report.result.metrics.map((metric,ordinal)=>({ordinal,metric,
      definition:contract.snapshot.request.definitions.find(item=>item.id===metric.id)!,evidence:this.findMetric(receipt,metric.id)}));
    const {method,environment}=receipt.snapshot.report;
    return researchExternalExperimentDerivationSchema.parse({result:{resultId:request.resultId,expectedHash:request.expectedHash},verification:externalReportVerification,
      methods:`外部报告：${receipt.snapshot.provider} / ${receipt.snapshot.externalId}。方法由外部执行方报告为 ${method.name}：${method.rationale}。环境报告：${environment.description}（报告方：${environment.reportedBy}）。假设：${method.assumptions}。局限：${method.limitations}。Roc 未独立核验外部执行或复现结果。`,
      rows,figures:buildMetricFigureSources({kind:'external_experiment_report',resultId:request.resultId,expectedHash:request.expectedHash,
        contractId:contract.snapshot.id,contractHash:contract.snapshotHash,verification:externalReportVerification},rows)});
  }

  private async readImport(request:ResearchExternalExperimentPreview):Promise<{preview:ResearchExternalExperimentPreviewResult;original:Buffer;files:Array<{path:string;bytes:Buffer}>}>{
    const record=this.get({projectId:request.projectId,contractId:request.contractId});
    if(record.binding===null)throw new Error('research_external_experiment_assignment_required');
    const root=await researchWorkspace(this.research.getProject(request.projectId).workspacePath),original=await readResearchFile(root,request.resultPath,1024*1024);
    const report=researchExternalExperimentReportSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(original)));
    if(report.contractId!==request.contractId||report.contractHash!==record.contract.snapshotHash||report.externalId!==record.binding.request.externalId)throw new Error('research_external_experiment_report_mismatch');
    const definitions=record.contract.snapshot.request.definitions;
    if(report.result.metrics.length!==definitions.length||report.result.metrics.some(metric=>!definitions.some(definition=>definition.id===metric.id&&definition.unit===metric.unit)))throw new Error('research_external_experiment_definitions_mismatch');
    if(record.contract.snapshot.request.expectedFiles.some(expected=>!report.files.some(file=>file.path===expected.path&&file.role===expected.role)))throw new Error('research_external_experiment_files_missing');
    const files:Array<{path:string;bytes:Buffer}>=[],described:ResearchExternalExperimentPreviewResult['files']=[];let total=0;
    for(const file of report.files){const bytes=await readResearchFile(root,file.path,8*1024*1024);total+=bytes.length;if(total>16*1024*1024)throw new Error('research_external_experiment_file_limit');
      if(researchContentHash(bytes)!==file.sha256)throw new Error('research_external_experiment_file_changed');
      files.push({path:file.path,bytes});described.push({...file,size:bytes.length});}
    const current=this.get({projectId:request.projectId,contractId:request.contractId});
    if(current.recordHash!==record.recordHash)throw new Error('research_external_experiment_record_changed');
    return {preview:researchExternalExperimentPreviewResultSchema.parse({recordHash:record.recordHash,resultPath:request.resultPath,report,
      original:{sha256:researchContentHash(original),size:original.length},files:described}),original,files};
  }
  private metricSource(receipt:ResearchExternalExperimentResult,metricId:string){
    const {snapshot,snapshotHash}=receipt,contract=this.readContract(this.contractRow(snapshot.request.projectId,snapshot.request.contractId));
    const index=snapshot.report.result.metrics.findIndex(metric=>metric.id===metricId),definition=contract.snapshot.request.definitions.find(metric=>metric.id===metricId);
    if(index<0||definition===undefined)throw new Error('research_external_experiment_metric_not_found');
    const id=`external_metric_${digest([snapshot.id,snapshotHash,metricId])}`,title=`外部报告：${definition.label} (${snapshot.externalId})`;
    const metadata={type:'external-experiment-report',contractId:contract.snapshot.id,contractHash:contract.snapshotHash,resultId:snapshot.id,resultHash:snapshotHash,
      metricId,provider:snapshot.provider,externalId:snapshot.externalId,reportHash:snapshot.original.sha256,pointer:`/result/metrics/${index}`,verification:externalReportVerification};
    return {id,title,metadata,locator:`external-report/${snapshot.id}#${metadata.pointer}`,
      content:JSON.stringify({schemaVersion:1,source:metadata,metric:snapshot.report.result.metrics[index],definition,method:snapshot.report.method,environment:snapshot.report.environment},null,2)};
  }
  private findMetric(receipt:ResearchExternalExperimentResult,metricId:string):ResearchEvidence|null{
    const source=this.metricSource(receipt,metricId),projectId=receipt.snapshot.request.projectId;
    const row=this.db.prepare('SELECT id FROM research_evidence WHERE project_id=? AND document_id=?').get(projectId,source.id) as {id:string}|undefined;
    if(row===undefined)return null;
    const inspected=this.research.evidence.inspectEvidence(row.id,projectId);
    if(inspected.referenceStatus!=='recorded')throw new Error('research_external_experiment_evidence_changed');
    if(inspected.evidence.excerpt!==source.content||inspected.evidence.contentHash!==researchContentHash(source.content)||
      digest(this.research.evidence.sourceMetadata(projectId,row.id))!==digest(source.metadata))throw new Error('research_external_experiment_evidence_changed');
    return inspected.evidence;
  }
  private contractRow(projectId:string,id:string):Row{
    this.research.getProject(projectId);const row=this.db.prepare('SELECT * FROM research_external_experiments WHERE id=?').get(id) as Row|undefined;
    if(row===undefined)throw new Error('research_external_experiment_not_found');if(row.project_id!==projectId)throw new Error('research_external_experiment_project_mismatch');return row;
  }
  private readContract(row:Row){
    const snapshot=researchExternalExperimentContractSchema.shape.snapshot.parse(JSON.parse(row.snapshot_json));
    if(JSON.stringify(snapshot)!==row.snapshot_json||researchContentHash(row.snapshot_json)!==row.snapshot_hash||snapshot.id!==row.id||
      snapshot.request.projectId!==row.project_id||snapshot.request.artifactId!==row.artifact_id||snapshot.request.requestId!==row.request_id||snapshot.requestHash!==digest(snapshot.request))throw new Error('research_external_experiment_snapshot_invalid');
    return {snapshot,snapshotHash:row.snapshot_hash};
  }
  private readResult(row:ResultRow):ResearchExternalExperimentResult{
    const snapshot=researchExternalExperimentResultSchema.shape.snapshot.parse(JSON.parse(row.snapshot_json));
    if(JSON.stringify(snapshot)!==row.snapshot_json||researchContentHash(row.snapshot_json)!==row.snapshot_hash||snapshot.id!==row.id||
      snapshot.request.projectId!==row.project_id||snapshot.request.contractId!==row.contract_id||snapshot.request.requestId!==row.request_id||snapshot.requestHash!==digest(snapshot.request)||
      row.original_bytes.length!==snapshot.original.size||researchContentHash(row.original_bytes)!==snapshot.original.sha256||snapshot.original.sha256!==snapshot.request.expectedResultHash||
      digest(researchExternalExperimentReportSchema.parse(JSON.parse(row.original_bytes.toString('utf8'))))!==digest(snapshot.report))throw new Error('research_external_experiment_snapshot_invalid');
    const record=this.get({projectId:row.project_id,contractId:row.contract_id}),contract=record.contract;
    if(record.binding===null||record.binding.request.provider!==snapshot.provider||record.binding.request.externalId!==snapshot.externalId||contract.snapshotHash!==snapshot.contractHash||snapshot.report.contractHash!==snapshot.contractHash||snapshot.report.contractId!==row.contract_id||snapshot.report.externalId!==snapshot.externalId)throw new Error('research_external_experiment_snapshot_invalid');
    if(snapshot.report.files.length!==snapshot.files.length||snapshot.report.files.some(file=>!snapshot.files.some(stored=>stored.path===file.path&&stored.role===file.role&&stored.sha256===file.sha256))||
      snapshot.report.result.metrics.length!==contract.snapshot.request.definitions.length||snapshot.report.result.metrics.some(metric=>!contract.snapshot.request.definitions.some(definition=>definition.id===metric.id&&definition.unit===metric.unit)))throw new Error('research_external_experiment_snapshot_invalid');
    const files=this.db.prepare('SELECT path,bytes FROM research_external_experiment_files WHERE result_id=? ORDER BY path').all(row.id) as {path:string;bytes:Buffer}[];
    if(files.length!==snapshot.files.length||files.some(file=>!snapshot.files.some(expected=>expected.path===file.path&&expected.size===file.bytes.length&&expected.sha256===researchContentHash(file.bytes))))throw new Error('research_external_experiment_snapshot_invalid');
    return {snapshot,snapshotHash:row.snapshot_hash};
  }
  private writable(projectId:string):void{if(this.research.getProject(projectId).status==='archived')throw new Error('research_project_archived');}
}
