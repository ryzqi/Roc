import {useState} from 'react';
import type {ResearchExperimentResultReceipt,ResearchExperimentResultGet,ResearchExperimentCompare} from '../../../shared/schemas/research-experiment-results';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncResource} from '../../app/use-async-resource';
import {formInputClass,formSecondaryButtonClass} from '../../shared/form-ui';
import {ExperimentResultReceipt} from './ExperimentResultReceipt';

const button=`${formSecondaryButtonClass} border-[0.5px]`,pageSize=20;
export function ExperimentResultComparison({client,left}: {client: RocClient;left: ResearchExperimentResultReceipt}): React.JSX.Element {
  const projectId=left.snapshot.request.projectId;
  const [runId,setRunId]=useState(''),[selection,setSelection]=useState<{runId:string;offset:number;nonce:number}|null>(null);
  const [right,setRight]=useState<Omit<ResearchExperimentResultGet,'projectId'>|null>(null);
  const [comparisonRequest,setComparisonRequest]=useState<ResearchExperimentCompare|null>(null);
  const history=useAsyncResource(selection===null?null:`experiment:compare-history:${projectId}:${JSON.stringify(selection)}`,()=>{
    if(selection===null)throw new Error('research_result_selection_required');
    return client.api.research.listExperimentResults({projectId,runId:selection.runId,offset:selection.offset,limit:pageSize});
  },{label:'读取对照运行回执'});
  const comparison=useAsyncResource(comparisonRequest===null?null:`experiment:comparison:${JSON.stringify(comparisonRequest)}`,
    ()=>{
      if(comparisonRequest===null)throw new Error('research_result_comparison_required');
      return client.api.research.compareExperimentResults(comparisonRequest);
    },{label:'核对实验可比性'});
  const labels={data:'输入数据不同',metric_definitions:'指标定义或方向不同',units:'指标或效应量单位不同',environment:'运行环境不同',
    parameters:'参数或命令参数不同',seed:'随机种子不同',method:'人工确认的统计方法不同'} as const;
  function selectHistory(offset:number):void {
    setSelection({runId:runId.trim(),offset,nonce:(selection?.nonce??0)+1});setRight(null);setComparisonRequest(null);
  }
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-experiment-comparison">
    <h3 className="font-medium">比较实验结果</h3>
    <label className="flex flex-col gap-1 text-muted">对照运行 ID
      <input className={`${formInputClass} border-[0.5px]`} value={runId} maxLength={128} onChange={event=>{
        setRunId(event.target.value);setSelection(null);setRight(null);setComparisonRequest(null);
      }}/>
    </label>
    <button type="button" disabled={runId.trim()===''||history.status==='loading'} className={`${button} self-start`}
      data-testid="artifact-experiment-comparison-list" onClick={()=>selectHistory(0)}>读取对照回执</button>
    {history.status==='loading'?<p role="status">正在读取对照回执…</p>:null}
    {history.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status!=='ready'||history.data===null||selection===null?null:<>
      <p className="text-muted">历史回执 {history.data.total} 份，比较时复核双方实际来源。</p>
      <select aria-label="对照结果回执" className={`${formInputClass} border-[0.5px]`} value={right?.resultId??''} onChange={event=>{
        const value=history.data!.items.find(value=>value.snapshot.id===event.target.value);
        setRight(value===undefined?null:{resultId:value.snapshot.id,expectedHash:value.snapshotHash});setComparisonRequest(null);
      }}>
        <option value="">选择确切的结果版本</option>
        {history.data.items.map(value=><option key={value.snapshot.id} value={value.snapshot.id}>{value.snapshot.recordedAt} {value.snapshot.id}</option>)}
      </select>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selection.offset===0} onClick={()=>selectHistory(selection.offset-pageSize)}>上一页对照回执</button>
        <button type="button" className={button} disabled={selection.offset+pageSize>=history.data.total} onClick={()=>selectHistory(selection.offset+pageSize)}>下一页对照回执</button>
      </div>
    </>}
    <button type="button" className={`${button} self-start`} disabled={right===null||comparison.status==='loading'}
      data-testid="artifact-experiment-compare" onClick={()=>{
        if(right===null)return;
        const request={projectId,left:{resultId:left.snapshot.id,expectedHash:left.snapshotHash},right};
        if(JSON.stringify(request)===JSON.stringify(comparisonRequest))comparison.reload();else setComparisonRequest(request);
      }}>核对双方可比性</button>
    {comparison.status==='loading'?<p role="status">正在复核双方运行、来源与回执…</p>:null}
    {comparison.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{comparison.error}</p>}
    {comparison.status!=='ready'||comparison.data===null?null:<section className="flex min-w-0 flex-col gap-3" data-testid="artifact-experiment-comparison-result">
      <p role="status" className="font-medium">{comparison.data.comparable?'冻结合同可比':'冻结合同不可比'}</p>
      <p className="text-muted">此核对不表示科学支持性或统计显著性。</p>
      <ul className="flex flex-col gap-1">{comparison.data.differences.map(value=><li key={value}>{labels[value]}</li>)}</ul>
      <section className="flex min-w-0 flex-col gap-2"><h4 className="font-medium">当前结果</h4><ExperimentResultReceipt receipt={comparison.data.left}/></section>
      <section className="flex min-w-0 flex-col gap-2"><h4 className="font-medium">对照结果</h4><ExperimentResultReceipt receipt={comparison.data.right}/></section>
    </section>}
  </section>;
}
