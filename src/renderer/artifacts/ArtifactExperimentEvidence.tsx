import {useState} from 'react';
import type {ResearchEvidence} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ExperimentResultReceipt} from './production/ExperimentResultReceipt';

export function ArtifactExperimentEvidence({client,evidence}:{client:RocClient;evidence:ResearchEvidence}):React.JSX.Element {
  const [showOutput,setShowOutput]=useState(false);
  const trace=useAsyncResource(`experiment:evidence:${evidence.projectId}:${evidence.id}:${evidence.sourceVersion}`,
    ()=>client.api.research.getExperimentResultEvidence({projectId:evidence.projectId,evidenceId:evidence.id}),{label:'复核指标证据来源'});
  const receipt=trace.status==='ready'?trace.data?.receipt:null;
  const read=useAsyncResource(!showOutput||receipt==null?null:`experiment:evidence-output:${evidence.id}:${receipt.snapshotHash}`,async()=>{
    if(receipt==null)throw new Error('research_result_selection_required');
    const response=await client.api.research.readExperimentFile({projectId:evidence.projectId,runId:receipt.snapshot.execution.runId,
      area:'output',path:receipt.snapshot.execution.output.path});
    if(response.ok&&(response.data.file.sha256!==receipt.snapshot.execution.output.sha256||response.data.encoding!=='utf8')) {
      throw new Error('指标实际输出与固定回执不一致。');
    }
    return response;
  },{label:'读取指标实际输出'});
  return <section className="mt-2 flex min-w-0 flex-col gap-2" data-testid="artifact-experiment-evidence-source">
    {trace.status==='loading'?<p role="status">正在复核指标证据及实际来源…</p>:null}
    {trace.error===null?null:<>
      <p role="alert" className="break-words text-[var(--st-warn)]">{trace.error}</p>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`} onClick={trace.reload}>重新复核指标证据</button>
    </>}
    {trace.status==='ready'&&trace.data===null?<p className="text-muted">此证据引用原始实验输出，未关联指标审核回执。</p>:null}
    {receipt==null?null:<>
      <p role="status">已复核指标 {trace.data!.metricId} 的固定结果来源。</p>
      <ExperimentResultReceipt receipt={receipt}/>
      <button type="button" aria-expanded={showOutput} className={`${formSecondaryButtonClass} border-[0.5px] self-start`}
        onClick={()=>setShowOutput(value=>!value)} data-testid="artifact-experiment-evidence-output-toggle">{showOutput?'收起实际指标输出':'查看实际指标输出'}</button>
      {read.status==='loading'?<p role="status">正在读取实际指标输出…</p>:null}
      {read.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
      {read.status!=='ready'||read.data===null?null:<pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]"
        data-testid="artifact-experiment-evidence-output">{read.data.content}</pre>}
    </>}
  </section>;
}
