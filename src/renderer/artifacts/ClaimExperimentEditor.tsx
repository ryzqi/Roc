import {useRef, useState} from 'react';
import type {ResearchClaim} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactDraftDiscard, useArtifactDraft} from './artifact-editor-guard';

export const experimentLabels = {method: '方法', dataset: '数据集', metric: '指标', value: '数值',
  unit: '单位', baseline: '基线', conditions: '实验条件', finding: '相对基线结论'};
export function ClaimExperimentEditor({client, claim, writable, onChanged}: {
  client: RocClient; claim: ResearchClaim; writable: boolean; onChanged: () => void
}): React.JSX.Element {
  const [fields, setFields] = useState({...claim.experiment, value: String(claim.experiment.value)});
  const busy = useRef(false);
  const draft = useArtifactDraft('主张实验条件', fields, busy);
  const save = useAsyncAction(() => client.api.research.updateClaim({
    id: claim.id, expectedVersion: claim.version, content: claim.content, status: claim.status, evidenceIds: claim.evidenceIds,
    experiment: {...fields, value: fields.value.trim() === 'unknown' ? 'unknown' : Number(fields.value)}
  }), {label: '保存实验条件'});
  return <details>
    <summary className="cursor-pointer">实验条件与比较对象</summary>
    <p className="mt-2 text-xs text-muted">缺失信息填 unknown。修改条件会使当前关系失效，需要重新审核。</p>
    <div className="mt-2 grid grid-cols-2 gap-2">
      {(Object.keys(experimentLabels) as Array<keyof typeof experimentLabels>).map(key => <label key={key} className="flex flex-col gap-1">
        {experimentLabels[key]}{key === 'finding' ? <select className={formInputClass} value={fields.finding} disabled={!writable || busy.current || draft.locked}
          onChange={event => setFields({...fields, finding: event.target.value as typeof fields.finding})}>
          <option value="unknown">unknown</option><option value="improves">提升</option><option value="no_improvement">未提升</option><option value="worsens">下降</option>
        </select> : <input className={formInputClass} value={fields[key]} maxLength={1000} disabled={!writable || save.pending || draft.locked}
          onChange={event => setFields({...fields, [key]: event.target.value})}/>}
      </label>)}
    </div>
    {writable && <div className="mt-2 flex gap-2">
      <button className={formSecondaryButtonClass} disabled={save.pending || draft.locked || !draft.dirty || fields.value.trim() === '' ||
        (fields.value.trim() !== 'unknown' && !Number.isFinite(Number(fields.value)))} onClick={async () => {
        if (busy.current || draft.isLocked()) return;
        busy.current = true; const result = await save.run(); busy.current = false;
        if (result.ok) {draft.saved(); onChanged();}
      }}>保存实验条件</button>
      <ArtifactDraftDiscard dirty={draft.dirty} testId={`artifact-experiment-discard-${claim.id}`} onDiscard={() => {
        const original = {...claim.experiment, value: String(claim.experiment.value)};
        setFields(original); draft.reset(original); save.reset();
      }}/>
    </div>}
    {save.error && <p role="alert">{save.error}</p>}
  </details>;
}
