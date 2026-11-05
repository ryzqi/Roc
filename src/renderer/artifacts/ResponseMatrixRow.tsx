import {useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchClaimSchema} from '../../shared/schemas/research-evidence';
import {researchResponseLocationSchema, type ResearchResponseMatrixSave, type ResearchResponseMatrixInspection} from '../../shared/schemas/research-response-matrix';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass, formTextAreaClass} from '../shared/form-ui';
import {responseStatusLabels} from './ResponseMatrixReceipt';

type Row = ResearchResponseMatrixSave['rows'][number];
const input = `${formInputClass} border-[0.5px]`, textarea = `${formTextAreaClass} border-[0.5px] font-sans`;
export function ResponseMatrixRow({row, original, snapshot, report, disabled, onChange, onCandidate}: {
  row: Row; original: boolean; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchResponseMatrixInspection['report'];
  disabled: boolean; onChange: (value: Row) => void; onCandidate: (dirty: boolean) => void
}): React.JSX.Element {
  const [claimId, setClaimId] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const claim = report.material.claims.find(item => item.id === claimId);
  const digest = useAsyncResource(claim === undefined ? null : `response:claim:${report.artifactVersion}:${claim.id}`, async () => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(researchClaimSchema.parse(claim))));
    return {ok: true as const, data: Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')};
  }, {label: '核对修改稿位置'});
  const sources = [...new Map([...snapshot.evidence, ...report.material.evidence].map(source => [source.evidence.id, source])).values()];
  const candidate = (): void => {onCandidate(true); setValidation(null);};
  const clear = (): void => {setClaimId(''); setStart(''); setEnd(''); setValidation(null); onCandidate(false);};
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3" data-testid="artifact-response-row">
    <legend className="mb-2 break-all font-medium">意见 {row.commentId}</legend>
    <label className="flex min-w-0 flex-col gap-1 text-muted">审稿人{original ? '（原始记录，只读）' : ''}
      <input required maxLength={300} aria-label="审稿人" className={input} readOnly={original} value={row.reviewer}
        onChange={event => onChange({...row, reviewer: event.target.value})}/>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-muted">原始审稿意见{original ? '（只读）' : ''}
      <textarea required maxLength={12000} rows={4} aria-label="原始审稿意见" className={textarea} readOnly={original} value={row.comment}
        onChange={event => onChange({...row, comment: event.target.value})}/>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-muted">人工处理状态
      <select aria-label="人工处理状态" className={input} value={row.status}
        onChange={event => onChange({...row, status: event.target.value as Row['status']})}>
        {Object.entries(responseStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-muted">审稿回复或未采纳理由
      <textarea required={row.status !== 'open'} maxLength={12000} rows={5} aria-label="审稿回复或未采纳理由"
        className={textarea} value={row.response} onChange={event => onChange({...row, response: event.target.value})}/>
    </label>
    <h3 className="font-medium">修改稿位置</h3>
    <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-response-locations">
      {row.locations.map((location, index) => <li className="min-w-0 break-words" key={`${location.claimId}:${location.start}:${location.end}`}>
        <p className="break-all">{location.claimId}，字符 {location.start}–{location.end}</p>
        <p className="whitespace-pre-wrap">{location.text}</p>
        <button type="button" className={formSecondaryButtonClass} onClick={() => onChange({...row,
          locations: row.locations.filter((_, position) => position !== index)})}>移除此位置</button>
      </li>)}
    </ul>
    <label className="flex min-w-0 flex-col gap-1 text-muted">选择修改稿段落
      <select aria-label="选择修改稿段落" className={input} value={claimId}
        onChange={event => {setClaimId(event.target.value); setStart(''); setEnd(''); candidate();}}>
        <option value="">请选择</option>
        {report.material.claims.map(item => <option key={item.id} value={item.id}>{item.content}</option>)}
      </select>
    </label>
    {claim === undefined ? null : <div className="flex min-w-0 flex-col gap-2">
      <p className="whitespace-pre-wrap break-words" data-testid="artifact-response-current-text">{claim.content}</p>
      <p className="text-muted">字符位置从 0 开始，结束位置不包含在选区内。</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-muted">起始字符
          <input type="number" min={0} max={claim.content.length - 1} step={1} aria-label="起始字符" className={input} value={start}
            onChange={event => {setStart(event.target.value); candidate();}}/>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-muted">结束字符
          <input type="number" min={1} max={claim.content.length} step={1} aria-label="结束字符" className={input} value={end}
            onChange={event => {setEnd(event.target.value); candidate();}}/>
        </label>
      </div>
      <button type="button" className={`${formSecondaryButtonClass} self-start`} data-testid="artifact-response-whole-paragraph"
        onClick={() => {setStart('0'); setEnd(String(claim.content.length)); candidate();}}>选择整段</button>
      {start === '' || end === '' ? null : <p className="whitespace-pre-wrap break-words" data-testid="artifact-response-selected-text">
        {claim.content.slice(Number(start), Number(end))}
      </p>}
    </div>}
    {digest.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{digest.error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={formSecondaryButtonClass} disabled={disabled || digest.status !== 'ready' || start === '' || end === ''}
        data-testid="artifact-response-location-add" onClick={() => {
          if (claim === undefined || digest.status !== 'ready') return;
          const parsed = researchResponseLocationSchema.safeParse({claimId: claim.id, claimHash: digest.data,
            start: Number(start), end: Number(end), text: claim.content.slice(Number(start), Number(end))});
          if (!parsed.success || Number(end) > claim.content.length) {setValidation('请选择段落中的有效字符范围。'); return;}
          onChange({...row, locations: [...row.locations.filter(location => location.claimId !== parsed.data.claimId ||
            location.start !== parsed.data.start || location.end !== parsed.data.end), parsed.data]});
          clear();
        }}>关联此位置</button>
      <button type="button" className={formSecondaryButtonClass} data-testid="artifact-response-location-clear" onClick={clear}>清空待关联位置</button>
    </div>
    {validation === null ? null : <p role="alert" className="text-[var(--st-warn)]">{validation}</p>}
    <h3 className="font-medium">关联证据</h3>
    {sources.length === 0 ? <p className="text-muted">当前工件没有可选证据。</p> : <div className="flex min-w-0 flex-col gap-2">
      {sources.map(source => <label key={source.evidence.id} className="flex min-w-0 items-start gap-2 text-muted">
        <input type="checkbox" className="mt-1 shrink-0" checked={row.evidenceIds.includes(source.evidence.id)}
          disabled={disabled || (source.referenceStatus !== 'recorded' && !row.evidenceIds.includes(source.evidence.id))} aria-label={`关联证据 ${source.evidence.id}`}
          onChange={event => onChange({...row, evidenceIds: event.target.checked ? [...row.evidenceIds, source.evidence.id] :
            row.evidenceIds.filter(id => id !== source.evidence.id)})}/>
        <span className="min-w-0 break-words">{source.evidence.title}
          <span className="block break-all">{source.evidence.id}</span>
          {source.referenceStatus === 'recorded' ? null : <span className="block">来源已变化</span>}
        </span>
      </label>)}
    </div>}
  </fieldset>;
}
