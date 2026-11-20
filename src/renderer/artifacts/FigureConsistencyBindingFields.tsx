import {useState} from 'react';
import {researchFigureConsistencyBindingSchema, type ResearchFigureConsistencyBinding,
  type ResearchFigureConsistencyInspection} from '../../shared/schemas/research-figure-consistency';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchClaimSchema} from '../../shared/schemas/research-evidence';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ConsistencyRuleFields, emptyConsistencyRuleFields} from './ConsistencyRuleFields';

export function FigureConsistencyBindingFields({client, snapshot, report, markName, disabled, onChange, onAdd, onDiscard}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchFigureConsistencyInspection['report'];
  markName: string; disabled: boolean; onChange: () => void;
  onAdd: (binding: ResearchFigureConsistencyBinding) => void; onDiscard: () => void
}): React.JSX.Element {
  const empty = {...emptyConsistencyRuleFields, item: '', channel: '', claim: '', evidence: ''};
  const [fields, setFields] = useState(empty), [error, setError] = useState<string | null>(null);
  const mark = report.marks.find(value => value.name === markName)!;
  const item = fields.item === '' ? undefined : report.items[Number(fields.item)];
  const claim = snapshot.claims.find(value => value.id === fields.claim);
  const digest = useAsyncResource(claim === undefined ? null : `figure:claim:${snapshot.version}:${claim.id}`, async () => {
    const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(researchClaimSchema.parse(claim))));
    return {ok: true as const, data: Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')};
  }, {label: '核对图稿主张'});
  const trace = useAsyncResource(fields.evidence === '' ? null : `figure:metric:${snapshot.artifact.projectId}:${fields.evidence}`,
    () => client.api.research.getExperimentResultEvidence({projectId: snapshot.artifact.projectId, evidenceId: fields.evidence}),
    {label: '读取图稿来源指标'});
  const source = trace.status === 'ready' ? trace.data : null;
  const metric = source?.receipt.snapshot.result.metrics.find(value => value.id === source.metricId);
  const change = (name: keyof typeof empty, value: string): void => {
    setFields(previous => ({...previous, [name]: value, ...(name === 'claim' ? {evidence: ''} : {}),
      ...(name === 'item' ? {channel: ''} : {})}));
    setError(null); onChange();
  };
  const select = (name: keyof typeof empty, label: string, options: Record<string, string>): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <select aria-label={label} className={`${formInputClass} border-[0.5px]`} value={fields[name]}
        onChange={event => change(name, event.target.value)}>
        <option value="">请选择</option>
        {Object.entries(options).map(([value, text]) => <option value={value} key={value}>{text}</option>)}
      </select>
    </label>;
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3" data-testid="artifact-figure-consistency-fields">
    {select('item', '场景数据项', Object.fromEntries(report.items.map((value, index) =>
      [String(index), `路径 ${value.scenePath.join('/')}，${JSON.stringify(value.numericFields)}`])))}
    {select('channel', '数据通道与字段', Object.fromEntries(Object.entries(mark.directFields)
      .filter(([, field]) => item !== undefined && Object.hasOwn(item.numericFields, field))
      .map(([channel, field]) => [channel, `${channel} → ${field} = ${item!.numericFields[field]}`])))}
    {select('claim', '图稿指标主张', Object.fromEntries(snapshot.claims.map(value => [value.id, value.content])))}
    {claim === undefined ? null : <p className="whitespace-pre-wrap break-words">{claim.content}</p>}
    {digest.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{digest.error}</p>}
    {select('evidence', '图稿指标证据', Object.fromEntries((claim?.evidenceIds ?? []).map(id => {
      const evidence = snapshot.evidence.find(value => value.evidence.id === id)!.evidence;
      return [id, `${evidence.title}，${id}`];
    })))}
    {trace.status === 'loading' ? <p role="status">正在读取指标来源…</p> : null}
    {trace.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{trace.error}
      <button type="button" className={formSecondaryButtonClass} onClick={trace.reload}>重读图稿指标</button>
    </p>}
    {trace.status === 'ready' && source === null ? <p role="alert" className="text-[var(--st-warn)]">该证据未关联实验结果指标。</p> : null}
    {source === null || metric === undefined ? null : <div className="flex min-w-0 flex-col gap-1 text-muted">
      <p>来源指标 {metric.id}：{metric.value} {metric.unit}</p>
      <p className="break-all">结果 {source.receipt.snapshot.id}，SHA-256 {source.receipt.snapshotHash}</p>
    </div>}
    <ConsistencyRuleFields fields={fields} onChange={change}/>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={formSecondaryButtonClass} data-testid="artifact-figure-consistency-add" onClick={() => {
        if (item === undefined || fields.channel === '' || claim === undefined || digest.status !== 'ready' || digest.data === null ||
          source === null || metric === undefined || fields.conversion === '' || fields.rounding === '' ||
          fields.absolute.trim() === '' || fields.relative.trim() === '' ||
          (fields.conversion === 'affine' && (fields.scale.trim() === '' || fields.offset.trim() === '')) ||
          (fields.rounding === 'decimal_places' && fields.places.trim() === '')) {
          setError('请选择场景数据、主张、真实指标，并完整填写转换、舍入和容差。'); return;
        }
        const parsed = researchFigureConsistencyBindingSchema.safeParse({
          claimId: claim.id, expectedClaimHash: digest.data, markName, channel: fields.channel, field: mark.directFields[fields.channel],
          scenePath: item.scenePath, unit: fields.unit, evidenceId: fields.evidence,
          resultId: source.receipt.snapshot.id, resultHash: source.receipt.snapshotHash, metricId: source.metricId,
          rule: {conversion: fields.conversion === 'identity' ? {kind: 'identity'} : {
            kind: fields.conversion, fromUnit: metric.unit, toUnit: fields.unit, scale: Number(fields.scale), offset: Number(fields.offset),
            rationale: fields.conversionReason},
          rounding: fields.rounding === 'none' ? {kind: 'none'} : {
            kind: fields.rounding, places: Number(fields.places), mode: 'half_away_from_zero'},
          tolerance: {absolute: Number(fields.absolute), relative: Number(fields.relative), rationale: fields.toleranceReason}}
        });
        if (!parsed.success) {setError('图稿映射不完整或规则无效，请核对单位、位数和容差。'); return;}
        onAdd(parsed.data); setFields(empty); setError(null);
      }}>加入图稿映射</button>
      <button type="button" className={formSecondaryButtonClass} data-testid="artifact-figure-consistency-candidate-discard"
        onClick={() => {setFields(empty); setError(null); onDiscard();}}>清空待加入图稿映射</button>
    </div>
    {error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{error}</p>}
  </fieldset>;
}
