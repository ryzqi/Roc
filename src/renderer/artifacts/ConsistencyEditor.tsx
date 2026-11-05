import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchConsistencySaveSchema, type ResearchConsistencyInspection, type ResearchConsistencyBinding,
  type ResearchConsistencySave} from '../../shared/schemas/research-consistency';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ConsistencyBindingFields} from './ConsistencyBindingFields';
import {consistencySurfaces} from './ConsistencyReceipt';

export function ConsistencyEditor({client, snapshot, report, writable, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchConsistencyInspection['report']; writable: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const initial = report.review?.snapshot.request.bindings ?? [];
  const [bindings, setBindings] = useState<ResearchConsistencyBinding[]>(initial);
  const [rationale, setRationale] = useState(''), [dirty, setDirty] = useState(false), [candidateDirty, setCandidateDirty] = useState(false);
  const [validation, setValidation] = useState<string | null>(null), [fieldsKey, setFieldsKey] = useState(0);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((request: ResearchConsistencySave) => client.api.research.saveConsistencyReview(request), {label: '保存数值审核'});
  const change = (): void => {setDirty(true); onDirty(true); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();};
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-consistency-editor">
    <ConsistencyBindingFields key={fieldsKey} client={client} snapshot={snapshot} report={report} disabled={!writable || save.pending}
      onChange={() => {setCandidateDirty(true); change();}}
      onDiscard={() => setCandidateDirty(false)}
      onAdd={binding => {
        setBindings(previous => [...previous.filter(item => item.claimId !== binding.claimId ||
          item.start !== binding.start || item.end !== binding.end), binding]);
        setCandidateDirty(false); change();
      }}/>
    <h3 className="font-medium">待保存映射，共 {bindings.length} 项</h3>
    <ul className="flex min-w-0 flex-col gap-2">
      {bindings.map((binding, index) => <li key={`${binding.claimId}:${binding.start}:${binding.end}`} className="min-w-0 break-words">
        <p>{consistencySurfaces[binding.surface]}，字符 {binding.start}–{binding.end}，指标 {binding.metricId}，单位 {binding.unit}</p>
        <p className="break-all text-muted">主张 {binding.claimId}，结果 {binding.resultId}，证据 {binding.evidenceId}</p>
        <details className="text-muted">
          <summary className="cursor-pointer">映射规则与版本</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(binding, null, 2)}</pre>
        </details>
        <button type="button" className={formSecondaryButtonClass} disabled={!writable || save.pending}
          data-testid="artifact-consistency-remove" onClick={() => {setBindings(previous => previous.filter((_, position) => position !== index)); change();}}>
          移除此映射
        </button>
      </li>)}
    </ul>
    <form className="flex min-w-0 flex-col gap-3" onSubmit={event => {
      event.preventDefault();
      if (!writable || busy.current) return;
      if (candidateDirty) {setValidation('先加入或清空待加入映射，再保存整份审核。'); return;}
      const parent = report.review;
      const parsed = researchConsistencySaveSchema.safeParse({
        projectId: report.projectId, artifactId: report.artifactId, expectedArtifactVersion: report.artifactVersion,
        requestId: requestId.current, parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
        rationale, bindings
      });
      if (!parsed.success) {setValidation('至少保留一项数值映射并填写审核理由。'); return;}
      busy.current = true; onPending(true);
      void save.run(parsed.data).then(reply => {
        busy.current = false;
        if (!mounted.current) return;
        onPending(false);
        if (reply.ok) {setDirty(false); onDirty(false); onSaved();}
      });
    }}>
      <fieldset disabled={!writable || save.pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-muted">数值审核理由
          <textarea required rows={4} maxLength={4000} aria-label="数值审核理由" className={`${formInputClass} resize-y border-[0.5px]`}
            value={rationale} onChange={event => {setRationale(event.target.value); change();}}/>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={formPrimaryButtonClass} data-testid="artifact-consistency-save">保存数值审核</button>
          <button type="button" className={formSecondaryButtonClass} disabled={!dirty} data-testid="artifact-consistency-discard"
            onClick={() => {setBindings(initial); setRationale(''); setDirty(false); setCandidateDirty(false); onDirty(false);
              setFieldsKey(value => value + 1); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();}}>
            放弃数值审核修改
          </button>
        </div>
      </fieldset>
      {save.pending ? <p role="status">正在保存数值审核，请等待回执。</p> : null}
      {validation === null ? null : <p role="alert" className="text-[var(--st-warn)]">{validation}</p>}
      {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
    </form>
  </section>;
}
