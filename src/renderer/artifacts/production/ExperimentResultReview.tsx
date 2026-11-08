import {useRef,useState} from 'react';
import {researchExperimentResultFileSchema,type ResearchExperimentResultReview,type ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';
import type {ResearchExperimentExecution} from '../../../shared/schemas/research-experiments';
import type {ResearchArtifactInspectRequest} from '../../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncAction,useAsyncResource} from '../../app/use-async-resource';
import {formInputClass,formPrimaryButtonClass,formSecondaryButtonClass} from '../../shared/form-ui';

const input=`${formInputClass} border-[0.5px]`;
export function ExperimentResultReview({client,run,request,writable,onSaved}: {
  client: RocClient;run: ResearchExperimentExecution;request: ResearchArtifactInspectRequest;
  writable: boolean;onSaved: (receipt: ResearchExperimentResultReceipt)=>void
}): React.JSX.Element {
  const [path,setPath]=useState('');
  const file=run.files.find(value=>value.area==='output'&&value.path===path);
  const preview=useAsyncResource(file===undefined?null:`experiment:metric-preview:${JSON.stringify([request,file])}`,async()=>{
    if(file===undefined||request.expectedVersion===null)throw new Error('research_result_file_selection_required');
    const response=await client.api.research.readProductionReviewFile({...request,expectedVersion:request.expectedVersion,
      area:'output',path:file.path,expectedFileHash:file.sha256});
    if(!response.ok)return response;
    if(response.data.encoding!=='utf8')throw new Error('research_result_utf8_required');
    return {ok:true as const,data:researchExperimentResultFileSchema.parse(JSON.parse(response.data.content))};
  },{label:'读取实际指标输出'});
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-experiment-result-review">
    <label className="flex flex-col gap-1 text-muted">指标输出文件
      <select className={input} value={path} onChange={event=>setPath(event.target.value)} aria-label="指标输出文件">
        <option value="">选择保存的输出文件</option>
        {run.files.filter(value=>value.area==='output'&&value.size<=1024*1024).map(value=>
          <option key={value.path} value={value.path}>{value.path}</option>)}
      </select>
    </label>
    {preview.status==='loading'?<p role="status">正在核对实际指标输出…</p>:null}
    {preview.error===null?null:<>
      <p role="alert" className="break-words text-[var(--st-warn)]">{preview.error}</p>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`} onClick={preview.reload}>重读指标输出</button>
    </>}
    {preview.status!=='ready'||preview.data===null||file===undefined?null:<ExperimentResultReviewForm
      key={`${file.path}:${file.sha256}`} client={client} run={run} file={file} metrics={preview.data.metrics} writable={writable} onSaved={onSaved}/>}
  </section>;
}

function ExperimentResultReviewForm({client,run,file,metrics,writable,onSaved}: {
  client: RocClient;run: ResearchExperimentExecution;file: ResearchExperimentExecution['files'][number];
  metrics: ResearchExperimentResultReceipt['snapshot']['result']['metrics'];writable: boolean;
  onSaved: (receipt: ResearchExperimentResultReceipt)=>void
}): React.JSX.Element {
  const [definitions,setDefinitions]=useState(()=>metrics.map(metric=>({id:metric.id,unit:metric.unit,label:'',definition:'',direction:''})));
  const [method,setMethod]=useState({name:'',rationale:'',assumptions:'',limitations:''});
  const requests=useRef(new Map<string,string>()),busy=useRef(false);
  const save=useAsyncAction((request: ResearchExperimentResultReview)=>client.api.research.reviewExperimentResult(request),{label:'保存人工指标审核'});
  const complete=definitions.every(value=>value.label.trim()!==''&&value.definition.trim()!==''&&value.direction!=='')&&
    Object.values(method).every(value=>value.trim()!=='');
  const methodLabels={name:'统计方法',rationale:'方法选择理由',assumptions:'方法假设',limitations:'分析限制'} as const;
  return <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-experiment-result-form" onSubmit={event=>{
    event.preventDefault();
    if(!writable||!complete||busy.current)return;
    if(run.inputHash===null)throw new Error('research_result_input_required');
    const body={projectId:run.projectId,runId:run.id,expectedInputHash:run.inputHash,resultPath:file.path,expectedResultHash:file.sha256,
      definitions:definitions.map(value=>({...value,direction:value.direction as ResearchExperimentResultReview['definitions'][number]['direction']})),method};
    const signature=JSON.stringify(body);
    let requestId=requests.current.get(signature);
    if(requestId===undefined){requestId=crypto.randomUUID();requests.current.set(signature,requestId);}
    busy.current=true;
    void save.run({...body,requestId}).then(result=>{busy.current=false;if(result.ok)onSaved(result.data);});
  }}>
    <p className="text-muted">确认全部指标定义和统计方法后，保存不可修改的审核回执。</p>
    <fieldset disabled={!writable||save.pending} className="flex min-w-0 flex-col gap-3">
      {metrics.map((metric,index)=><section key={metric.id} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium break-words">{metric.id} <span className="tabular-nums">{metric.value} {metric.unit}</span></h3>
        <p className="text-muted tabular-nums">样本量 {metric.sampleSize}</p>
        <details><summary className="cursor-pointer text-muted">输出记录的误差、区间与效应量</summary>
          <pre tabIndex={0} className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(metric,null,2)}</pre>
        </details>
        {(['label','definition'] as const).map(field=><label key={field} className="flex flex-col gap-1 text-muted">
          {metric.id}{field==='label'?'指标名称':'指标定义'}
          <input required maxLength={field==='label'?128:4000} className={input} value={definitions[index]![field]}
            onChange={event=>{setDefinitions(values=>values.map((value,i)=>i===index?{...value,[field]:event.target.value}:value));save.reset();}}/>
        </label>)}
        <label className="flex flex-col gap-1 text-muted">{metric.id}指标方向
          <select required aria-label={`${metric.id}指标方向`} className={input} value={definitions[index]!.direction} onChange={event=>{
            setDefinitions(values=>values.map((value,i)=>i===index?{...value,direction:event.target.value}:value));save.reset();
          }}>
            <option value="">选择方向</option><option value="higher">越高越好</option><option value="lower">越低越好</option><option value="neutral">中性</option>
          </select>
        </label>
      </section>)}
      {(Object.keys(methodLabels) as Array<keyof typeof methodLabels>).map(field=><label key={field} className="flex flex-col gap-1 text-muted">
        {methodLabels[field]}
        <textarea required rows={field==='name'?1:2} maxLength={field==='name'?128:4000} className={`${input} h-auto resize-y py-1`}
          value={method[field]} onChange={event=>{setMethod({...method,[field]:event.target.value});save.reset();}}/>
      </label>)}
      <button type="submit" disabled={!complete} className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
        data-testid="artifact-experiment-result-save">{save.pending?'正在保存审核…':'保存人工指标审核'}</button>
    </fieldset>
    {save.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
  </form>;
}
