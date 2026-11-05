import {useState} from 'react';
import type {ResearchExperimentExecution} from '../../../shared/schemas/research-experiments';
import type {ResearchExperimentResultGet} from '../../../shared/schemas/research-experiment-results';
import type {ResearchArtifactInspectRequest} from '../../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncResource} from '../../app/use-async-resource';
import {formSecondaryButtonClass} from '../../shared/form-ui';
import {ExperimentResultReview} from './ExperimentResultReview';
import {ExperimentResultReceipt} from './ExperimentResultReceipt';
import {ExperimentResultComparison} from './ExperimentResultComparison';
import {ExperimentMetricEvidence} from './ExperimentMetricEvidence';

const button=`${formSecondaryButtonClass} border-[0.5px]`,pageSize=20;
export function ExperimentResults({client,run,request,writable}: {
  client: RocClient;run: ResearchExperimentExecution;request: ResearchArtifactInspectRequest;writable: boolean
}): React.JSX.Element {
  const [reviewOpen,setReviewOpen]=useState(false);
  const [historyChoice,setHistoryChoice]=useState<{offset:number;nonce:number}|null>(null);
  const [selection,setSelection]=useState<ResearchExperimentResultGet|null>(null);
  const history=useAsyncResource(historyChoice===null?null:`experiment:results:${run.projectId}:${run.id}:${JSON.stringify(historyChoice)}`,()=>{
    if(historyChoice===null)throw new Error('research_result_selection_required');
    return client.api.research.listExperimentResults({projectId:run.projectId,runId:run.id,offset:historyChoice.offset,limit:pageSize});
  },{label:'读取指标审核历史'});
  const read=useAsyncResource(selection===null?null:`experiment:result:${JSON.stringify(selection)}`,()=>{
    if(selection===null)throw new Error('research_result_selection_required');
    return client.api.research.getExperimentResult(selection);
  },{label:'复核指标回执来源'});
  const canReview=writable&&run.status==='completed'&&run.inputHash!==null&&run.environment!==null;
  function loadHistory(offset:number):void {
    setHistoryChoice({offset,nonce:(historyChoice?.nonce??0)+1});
  }
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-experiment-results">
    <h2 className="font-medium">指标审核与比较</h2>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={!canReview} aria-expanded={reviewOpen}
        data-testid="artifact-experiment-result-review-open" onClick={()=>setReviewOpen(!reviewOpen)}>{reviewOpen?'收起指标审核':'审核指标输出'}</button>
      <button type="button" className={button} disabled={history.status==='loading'} data-testid="artifact-experiment-result-list"
        onClick={()=>loadHistory(0)}>读取指标回执</button>
    </div>
    {!reviewOpen?null:<ExperimentResultReview client={client} run={run} request={request} writable={canReview}
      onSaved={receipt=>{setReviewOpen(false);setSelection({projectId:run.projectId,resultId:receipt.snapshot.id,expectedHash:receipt.snapshotHash});loadHistory(0);}}/>}
    {history.status==='loading'?<p role="status">正在读取指标审核历史…</p>:null}
    {history.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status!=='ready'||history.data===null||historyChoice===null?null:<>
      <p className="text-muted">历史回执 {history.data.total} 份。选中后复核实际来源。</p>
      <ul className="flex min-w-0 flex-col gap-2">{history.data.items.map(receipt=><li key={receipt.snapshot.id} className="flex min-w-0 flex-col gap-1">
        <button type="button" className={`${button} h-auto min-h-[var(--control-height-compact)] break-all text-left`}
          aria-pressed={selection?.resultId===receipt.snapshot.id} data-testid="artifact-experiment-result-select"
          onClick={()=>setSelection({projectId:run.projectId,resultId:receipt.snapshot.id,expectedHash:receipt.snapshotHash})}>
          {receipt.snapshot.recordedAt} {receipt.snapshot.id}
        </button>
        <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">SHA-256 {receipt.snapshotHash}</p>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={historyChoice.offset===0} onClick={()=>loadHistory(historyChoice.offset-pageSize)}>上一页指标回执</button>
        <button type="button" className={button} disabled={historyChoice.offset+pageSize>=history.data.total} onClick={()=>loadHistory(historyChoice.offset+pageSize)}>下一页指标回执</button>
      </div>
    </>}
    {read.status==='loading'?<p role="status">正在复核指标回执及实际来源…</p>:null}
    {read.error===null?null:<>
      <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>
      <button type="button" className={`${button} self-start`} onClick={read.reload}>重读指标回执</button>
    </>}
    {read.status!=='ready'||read.data===null?null:<>
      <p role="status">已复核实际运行、输出与审核回执。</p>
      <ExperimentResultReceipt receipt={read.data}/>
      <ExperimentMetricEvidence key={`evidence:${read.data.snapshot.id}:${read.data.snapshotHash}`} client={client} receipt={read.data} writable={writable}/>
      <ExperimentResultComparison key={`${read.data.snapshot.id}:${read.data.snapshotHash}`} client={client} left={read.data}/>
    </>}
  </section>;
}
