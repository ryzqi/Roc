import {useState} from 'react';
import type {ResearchEvidence} from '../../shared/types';
import type {ResearchReviewFullTextBindingInspection} from '../../shared/schemas/research-review-fulltext';
import type {ResearchReviewExtractionSave} from '../../shared/schemas/research-review-extraction';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

type Value = ResearchReviewExtractionSave['fields'][number]['value'];
type Reference = ResearchReviewExtractionSave['studyDesign']['evidence'][number];
export type ExtractionFieldDraft = {kind: Value['kind'] | ''; text: string; number: string; reason: string; evidence: Reference[]};
export function extractionFieldDraft(value: Value | null, evidence: Reference[]): ExtractionFieldDraft {
  return {kind: value === null ? '' : value.kind, text: value?.kind === 'text' ? value.text : '',
    number: value?.kind === 'number' ? String(value.number) : '', reason: value?.kind === 'missing' || value?.kind === 'unjudgeable' ? value.reason : '', evidence};
}
export function extractionValue(kind: Value['kind'], draft: ExtractionFieldDraft): Value {
  switch (kind) {
    case 'text': return {kind, text: draft.text};
    case 'number': return {kind, number: Number(draft.number)};
    case 'missing':
    case 'unjudgeable': return {kind, reason: draft.reason};
  }
}
export function ReviewExtractionField({client, projectId, binding, label, value, unit, allowNumber, evidence, onChange}: {
  client: RocClient; projectId: string; binding: ResearchReviewFullTextBindingInspection; label: string;
  value: ExtractionFieldDraft; unit: string | null; allowNumber: boolean; evidence: ResearchEvidence[];
  onChange: (draft: ExtractionFieldDraft) => void
}): React.JSX.Element {
  const input = `${formInputClass} border-[0.5px]`, button = `${formSecondaryButtonClass} border-[0.5px]`;
  const [candidateId, setCandidateId] = useState('');
  const read = useAsyncResource(candidateId === '' ? null : `review:extraction-evidence:${projectId}:${binding.snapshotHash}:${candidateId}`,
    async () => {
      const result = await client.api.research.inspectEvidence({projectId, evidenceId: candidateId});
      if (!result.ok) return result;
      const source = result.data.source;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({evidence: source.evidence, sourceLocator: source.sourceLocator})));
      return {ok: true as const, data: {source, digest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}};
    }, {label: '核查提取证据的准确来源'});
  const source = read.status === 'ready' ? read.data!.source : null, locator = source?.sourceLocator ?? null;
  const boundSource = binding.snapshot.source;
  const matches = source !== null && source.referenceStatus === 'recorded' && locator !== null && boundSource !== null &&
    locator.documentId === boundSource.documentId && locator.sourceHash === boundSource.sourceHash &&
    (boundSource.parse === null || (locator.parseId === boundSource.parse.id && locator.parseHash === boundSource.parse.hash));
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-extraction-field">
    <h4 className="font-medium">{label}</h4>
    <p className="text-muted">单位 {unit ?? '未声明单位'}</p>
    <label className="flex flex-col gap-1 text-muted">{label}值类型
      <select required aria-label={`${label}值类型`} className={input} value={value.kind}
        onChange={event => onChange({...value, kind: event.target.value as ExtractionFieldDraft['kind']})}>
        <option value="">选择人工记录类型</option><option value="text">文本</option>
        {!allowNumber || unit === null ? null : <option value="number">数值</option>}
        <option value="missing">原文未报告</option><option value="unjudgeable">无法判断</option>
      </select>
    </label>
    {value.kind !== 'text' ? null : <label className="flex flex-col gap-1 text-muted">{label}文本
      <textarea required aria-label={`${label}文本`} maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
        value={value.text} onChange={event => onChange({...value, text: event.target.value})} />
    </label>}
    {value.kind !== 'number' ? null : <label className="flex flex-col gap-1 text-muted">{label}数值
      <input required aria-label={`${label}数值`} type="number" step="any" className={input} value={value.number}
        onChange={event => onChange({...value, number: event.target.value})} />
    </label>}
    {value.kind !== 'missing' && value.kind !== 'unjudgeable' ? null : <label className="flex flex-col gap-1 text-muted">{label}原因
      <textarea required aria-label={`${label}原因`} maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
        value={value.reason} onChange={event => onChange({...value, reason: event.target.value})} />
    </label>}
    <label className="flex flex-col gap-1 text-muted">{label}原文证据
      <select aria-label={`${label}原文证据`} className={input} value={candidateId} onChange={event => setCandidateId(event.target.value)}>
        <option value="">选择已有 Evidence 核查来源</option>
        {evidence.map(item => <option key={item.id} value={item.id}>{item.title} {item.locator}</option>)}
      </select>
    </label>
    {read.status !== 'loading' ? null : <p role="status">正在核查准确证据…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {source === null ? null : <>
      <blockquote tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{source.evidence.excerpt}</blockquote>
      <p className="text-muted break-words">{source.evidence.locator} {matches ? '对应所选全文来源' : '来源失效或不对应所选全文'}</p>
      <details><summary className="cursor-pointer text-muted">证据定位与准确摘要</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(read.data, null, 2)}</pre>
      </details>
      <button type="button" className={`${button} self-start`} disabled={!matches || value.evidence.length >= 10 || value.evidence.some(ref => ref.id === candidateId)}
        data-testid="artifact-review-extraction-evidence-add" onClick={() => {
          if (!matches || read.status !== 'ready') return;
          onChange({...value, evidence: [...value.evidence, {id: source.evidence.id, expectedHash: read.data!.digest}]});
        }}>引用已核查证据</button>
    </>}
    <ul className="flex flex-col gap-1">{value.evidence.map(ref => <li key={ref.id} className="flex min-w-0 flex-col gap-1">
      <p className="text-muted break-all">Evidence {ref.id} SHA-256 {ref.expectedHash}</p>
      <button type="button" className={`${button} self-start`} onClick={() => onChange({...value, evidence: value.evidence.filter(item => item.id !== ref.id)})}>移除此字段证据引用</button>
    </li>)}</ul>
  </section>;
}
