import {useState} from 'react';
import {
  researchConsistencyBindingSchema, type ResearchConsistencyBinding, type ResearchConsistencyInspection
} from '../../shared/schemas/research-consistency';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchClaimSchema} from '../../shared/schemas/research-evidence';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {consistencySurfaces} from './ConsistencyReceipt';
import {ConsistencyRuleFields, emptyConsistencyRuleFields, type ConsistencyRuleFieldsValue} from './ConsistencyRuleFields';

const inputClass = `${formInputClass} border-[0.5px]`;
type Fields = ConsistencyRuleFieldsValue & {location: string; evidence: string; surface: string};
const empty: Fields = {...emptyConsistencyRuleFields, location: '', evidence: '', surface: ''};

export function ConsistencyBindingFields({client, snapshot, report, disabled, onChange, onAdd, onDiscard}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchConsistencyInspection['report']; disabled: boolean;
  onChange: () => void; onAdd: (binding: ResearchConsistencyBinding) => void; onDiscard: () => void
}): React.JSX.Element {
  const [fields, setFields] = useState(empty), [error, setError] = useState<string | null>(null);
  const locations = [...report.unmappedLocations, ...report.locations.filter(item => item.current).map(({binding, calculation}) => ({
    claimId: binding.claimId, start: binding.start, end: binding.end, text: calculation.observedText
  }))];
  const location = fields.location === '' ? undefined : locations[Number(fields.location)];
  const claim = location === undefined ? undefined : snapshot.claims.find(item => item.id === location.claimId);
  const claimDigest = useAsyncResource(claim === undefined ? null : `consistency:claim:${snapshot.version}:${claim.id}`, async () => {
    const digest = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(researchClaimSchema.parse(claim))));
    return {ok: true as const, data: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')};
  }, {label: '核对数值主张'});
  const trace = useAsyncResource(fields.evidence === '' ? null : `consistency:metric:${snapshot.artifact.projectId}:${fields.evidence}`,
    () => client.api.research.getExperimentResultEvidence({projectId: snapshot.artifact.projectId, evidenceId: fields.evidence}),
    {label: '读取数值来源指标'});
  const metricSource = trace.status === 'ready' ? trace.data : null;
  const metric = metricSource?.receipt.snapshot.result.metrics.find(item => item.id === metricSource.metricId);
  const change = (name: keyof Fields, value: string): void => {
    setFields(previous => ({...previous, [name]: value, ...(name === 'location' ? {evidence: ''} : {})}));
    setError(null); onChange();
  };
  const select = (name: keyof Fields, label: string, options: Record<string, string>): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <select aria-label={label} className={inputClass} value={fields[name]} onChange={event => change(name, event.target.value)}>
        <option value="">请选择</option>
        {Object.entries(options).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-consistency-fields">
    <h3 className="font-medium">添加或替换数值映射</h3>
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
      {select('location', '数值位置', Object.fromEntries(locations.map((value, index) =>
        [String(index), `${value.text}，字符 ${value.start}–${value.end}，${snapshot.claims.find(item => item.id === value.claimId)!.content}`])))}
      {claim === undefined ? null : <p className="whitespace-pre-wrap break-words">{claim.content}</p>}
      {claimDigest.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{claimDigest.error}</p>}
      {select('evidence', '指标证据', Object.fromEntries((claim?.evidenceIds ?? []).map(id => {
        const evidence = snapshot.evidence.find(item => item.evidence.id === id)!.evidence;
        return [id, `${evidence.title}，${id}`];
      })))}
      {trace.status === 'loading' ? <p role="status">正在读取指标来源…</p> : null}
      {trace.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{trace.error}
        <button type="button" className={formSecondaryButtonClass} onClick={trace.reload}>重读指标</button>
      </p>}
      {trace.status === 'ready' && trace.data === null ? <p role="alert" className="text-[var(--st-warn)]">该证据未关联实验结果指标。</p> : null}
      {metric === undefined || metricSource === null ? null : <section className="flex min-w-0 flex-col gap-1 text-muted">
        <p>来源指标 {metricSource.metricId}：{metric.value} {metric.unit}</p>
        <p className="break-all">结果 {metricSource.receipt.snapshot.id}，SHA-256 {metricSource.receipt.snapshotHash}</p>
      </section>}
      {select('surface', '展示位置', consistencySurfaces)}
      <ConsistencyRuleFields fields={fields} onChange={change}/>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={formSecondaryButtonClass} data-testid="artifact-consistency-add" onClick={() => {
          if (location === undefined || claim === undefined || claimDigest.status !== 'ready' || claimDigest.data === null ||
            metricSource === null || metric === undefined ||
            fields.absolute.trim() === '' || fields.relative.trim() === '' ||
            (fields.conversion === 'affine' && (fields.scale.trim() === '' || fields.offset.trim() === '')) ||
            (fields.rounding === 'decimal_places' && fields.places.trim() === '')) {
            setError('请选择数值位置、真实指标并完整填写转换、舍入和容差。'); return;
          }
            const parsed = researchConsistencyBindingSchema.safeParse({
              claimId: claim.id, expectedClaimHash: claimDigest.data, surface: fields.surface, start: location.start, end: location.end,
              unit: fields.unit, evidenceId: fields.evidence, resultId: metricSource.receipt.snapshot.id,
              resultHash: metricSource.receipt.snapshotHash, metricId: metricSource.metricId,
              rule: {conversion: fields.conversion === 'identity' ? {kind: 'identity'} : {
                kind: fields.conversion, fromUnit: metric.unit, toUnit: fields.unit,
                scale: Number(fields.scale), offset: Number(fields.offset), rationale: fields.conversionReason},
              rounding: fields.rounding === 'none' ? {kind: 'none'} : {
                kind: fields.rounding, places: Number(fields.places), mode: 'half_away_from_zero'},
              tolerance: {absolute: Number(fields.absolute), relative: Number(fields.relative), rationale: fields.toleranceReason}}
            });
            if (!parsed.success) {setError('数值映射不完整或规则无效，请核对单位、位数和容差。'); return;}
            onAdd(parsed.data); setFields(empty); setError(null);
        }}>加入映射</button>
        <button type="button" className={formSecondaryButtonClass} onClick={() => {setFields(empty); setError(null); onDiscard();}}>
          清空待加入映射
        </button>
      </div>
      {error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{error}</p>}
    </fieldset>
  </section>;
}
