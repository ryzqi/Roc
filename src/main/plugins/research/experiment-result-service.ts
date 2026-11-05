import {randomUUID} from 'node:crypto';
import {researchExperimentResultReviewSchema,researchExperimentResultFileSchema,researchExperimentResultSnapshotSchema,
  researchExperimentCompareSchema,type ResearchExperimentResultReview,type ResearchExperimentResultReceipt,
  type ResearchExperimentResultGet,type ResearchExperimentCompare,type ResearchExperimentComparison} from '../../../shared/schemas/research-experiment-results';
import {researchExperimentSourcePath,type ResearchExperimentExecution} from '../../../shared/schemas/research-experiments';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';
import type {ResearchExperimentService} from './experiment-service';

const sorted=<T>(values:T[],key:(value:T)=>string):T[]=>[...values].sort((a,b)=>key(a).localeCompare(key(b)));
const canonicalParameters=(parameters:Record<string,string>):string=>JSON.stringify(Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b)));
export class ResearchExperimentResultService {
  constructor(private readonly repository:ResearchRepository,
    private readonly experiments:Pick<ResearchExperimentService,'snapshot'|'source'>,
    private readonly now:()=>string=()=>new Date().toISOString()) {}

  async review(value:ResearchExperimentResultReview):Promise<ResearchExperimentResultReceipt> {
    const request=researchExperimentResultReviewSchema.parse(value);
    const actor=requireResearchHuman('research.experimentResults.review',request.projectId);
    const previous=this.repository.experimentResults.existing(request.projectId,request.requestId);
    if(previous!==null) {
      if(JSON.stringify(previous.snapshot.request)!==JSON.stringify(request)||previous.snapshot.actor.id!==actor.id) {
        throw new Error('research_result_request_conflict');
      }
      return previous;
    }
    this.requireWritable(request.projectId);
    const run=await this.experiments.snapshot(request.projectId,request.runId);
    if(run.inputHash!==request.expectedInputHash||run.environment===null)throw new Error('research_result_input_changed');
    const {bytes,file:output}=await this.experiments.source({projectId:request.projectId,runId:run.id,area:'output',path:request.resultPath});
    if(output.sha256!==request.expectedResultHash)throw new Error('research_result_output_changed');
    if(bytes.length>1024*1024)throw new Error('research_result_file_limit');
    const result=researchExperimentResultFileSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(result.metrics.length!==request.definitions.length)throw new Error('research_result_definitions_incomplete');
    for(const metric of result.metrics) {
      const definition=request.definitions.find(value=>value.id===metric.id);
      if(definition===undefined||definition.unit!==metric.unit)throw new Error('research_result_definition_mismatch');
    }
    const execution=this.execution(run,request.resultPath);
    const current=await this.experiments.snapshot(request.projectId,request.runId);
    if(JSON.stringify(this.execution(current,request.resultPath))!==JSON.stringify(execution))throw new Error('research_result_execution_changed');
    this.requireWritable(request.projectId);
    const snapshot=researchExperimentResultSnapshotSchema.parse({
      schemaVersion:1,id:`result_${randomUUID()}`,request,actor,recordedAt:this.now(),result,
      execution
    });
    return this.repository.experimentResults.save({snapshot,snapshotHash:researchContentHash(JSON.stringify(snapshot))});
  }
  async get(request:ResearchExperimentResultGet):Promise<ResearchExperimentResultReceipt> {
    const result=this.repository.experimentResults.get(request);
    const run=await this.experiments.snapshot(request.projectId,result.snapshot.execution.runId);
    if(JSON.stringify(this.execution(run,result.snapshot.execution.output.path))!==JSON.stringify(result.snapshot.execution)) {
      throw new Error('research_result_execution_changed');
    }
    const read=await this.experiments.source({projectId:request.projectId,runId:run.id,area:'output',path:result.snapshot.execution.output.path});
    if(read.file.sha256!==result.snapshot.execution.output.sha256)throw new Error('research_result_output_changed');
    const parsed=researchExperimentResultFileSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read.bytes)));
    if(JSON.stringify(parsed)!==JSON.stringify(result.snapshot.result))throw new Error('research_result_output_changed');
    const source=await this.experiments.source({projectId:request.projectId,runId:run.id,area:'input',path:result.snapshot.execution.source.path});
    if(source.file.sha256!==result.snapshot.execution.source.sha256)throw new Error('research_result_source_changed');
    return result;
  }
  async compare(value:ResearchExperimentCompare):Promise<ResearchExperimentComparison> {
    const request=researchExperimentCompareSchema.parse(value);
    const left=await this.get({projectId:request.projectId,...request.left}),right=await this.get({projectId:request.projectId,...request.right});
    const a=left.snapshot,b=right.snapshot,differences:ResearchExperimentComparison['differences']=[];
    const data=(value:typeof a)=>JSON.stringify(sorted(value.execution.inputs,file=>file.path).map(file=>({path:file.path,sha256:file.sha256,size:file.size})));
    if(data(a)!==data(b))differences.push('data');
    const definitions=(value:typeof a)=>JSON.stringify(sorted(value.request.definitions,metric=>metric.id).map(({unit:_unit,...fields})=>fields));
    if(definitions(a)!==definitions(b))differences.push('metric_definitions');
    const units=(value:typeof a)=>JSON.stringify(sorted(value.result.metrics,metric=>metric.id).map(metric=>({id:metric.id,unit:metric.unit,
      effect:metric.effect.kind==='recorded'?{name:metric.effect.name,unit:metric.effect.unit}:null})));
    if(units(a)!==units(b))differences.push('units');
    if(a.execution.environmentHash!==b.execution.environmentHash||a.execution.engine!==b.execution.engine)differences.push('environment');
    if(canonicalParameters(a.execution.parameters)!==canonicalParameters(b.execution.parameters)||
      JSON.stringify(a.execution.arguments)!==JSON.stringify(b.execution.arguments))differences.push('parameters');
    if(a.execution.seed!==b.execution.seed)differences.push('seed');
    if(JSON.stringify(a.request.method)!==JSON.stringify(b.request.method))differences.push('method');
    return {left,right,comparable:differences.length===0,differences};
  }
  private requireWritable(projectId:string):void {
    if(this.repository.getProject(projectId).status==='archived')throw new Error('research_project_archived');
  }
  private execution(run:ResearchExperimentExecution,resultPath:string):ResearchExperimentResultReceipt['snapshot']['execution'] {
    if(run.status!=='completed'||run.environment===null||run.inputHash===null)throw new Error('research_result_completed_required');
    const file=(area:'input'|'output',path:string)=>{
      const value=run.files.find(value=>value.area===area&&value.path===path);
      if(value===undefined)throw new Error('research_result_file_missing');
      return value;
    };
    return {runId:run.id,inputHash:run.inputHash,engine:run.request.engine,environmentHash:run.environment.hash,
      source:file('input',researchExperimentSourcePath(run.request)),output:file('output',resultPath),
      inputs:run.request.inputPaths.map(path=>file('input',path)),parameters:run.request.parameters,
      arguments:run.request.engine==='typescript'?[]:run.request.arguments,seed:run.request.engine==='python'?run.request.seed:null};
  }
}
