import {useRef,useState} from 'react';
import type {ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';
import type {ResearchEvidence} from '../../../shared/types';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncAction} from '../../app/use-async-resource';
import {formInputClass,formSecondaryButtonClass} from '../../shared/form-ui';

export function ExperimentMetricEvidence({client,receipt,writable}:{
  client:RocClient;receipt:ResearchExperimentResultReceipt;writable:boolean
}):React.JSX.Element {
  const [metricId,setMetricId]=useState('');
  const [evidence,setEvidence]=useState<ResearchEvidence|null>(null);
  const busy=useRef(false);
  const save=useAsyncAction((id:string)=>client.api.research.captureExperimentResultEvidence({
    projectId:receipt.snapshot.request.projectId,resultId:receipt.snapshot.id,expectedHash:receipt.snapshotHash,metricId:id
  }),{label:'保存指标证据'});
  return <form className="flex min-w-0 flex-col gap-2" data-testid="artifact-experiment-metric-evidence" onSubmit={event=>{
    event.preventDefault();
    if(!writable||metricId===''||busy.current)return;
    busy.current=true;
    void save.run(metricId).then(result=>{busy.current=false;if(result.ok)setEvidence(result.data);});
  }}>
    <fieldset disabled={!writable||save.pending} className="flex min-w-0 flex-col gap-2">
      <label className="flex flex-col gap-1 text-muted">证据指标
        <select aria-label="证据指标" className={`${formInputClass} border-[0.5px]`} value={metricId}
          onChange={event=>{setMetricId(event.target.value);setEvidence(null);save.reset();}}>
          <option value="">选择固定回执中的指标</option>
          {receipt.snapshot.request.definitions.map(metric=><option key={metric.id} value={metric.id}>{metric.label} ({metric.id})</option>)}
        </select>
      </label>
      <button type="submit" className={`${formSecondaryButtonClass} border-[0.5px] self-start`}
        disabled={metricId===''} data-testid="artifact-experiment-metric-evidence-save">{save.pending?'正在保存指标证据…':'保存指标为证据'}</button>
    </fieldset>
    {save.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
    {evidence===null?null:<div data-testid="artifact-experiment-metric-evidence-saved" className="flex min-w-0 flex-col gap-1">
      <p role="status">指标证据已保存。</p>
      <p className="break-all select-text">{evidence.id}</p>
      <p className="break-all text-muted">{evidence.locator}</p>
      <p className="break-all font-mono text-[var(--font-meta-size)] text-muted">来源版本 {evidence.sourceVersion}</p>
    </div>}
  </form>;
}
