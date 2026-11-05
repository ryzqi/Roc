import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchFigureConsistencySaveSchema, type ResearchFigureConsistencyBinding,
  type ResearchFigureConsistencyInspection, type ResearchFigureConsistencySave} from '../../shared/schemas/research-figure-consistency';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {FigureConsistencyScene} from './FigureConsistencyScene';

const sameLocation = (a: ResearchFigureConsistencyBinding, b: ResearchFigureConsistencyBinding): boolean =>
  a.markName === b.markName && a.channel === b.channel && JSON.stringify(a.scenePath) === JSON.stringify(b.scenePath);
export function FigureConsistencyEditor({client, snapshot, report, editing, writable, externalLocked, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchFigureConsistencyInspection['report'];
  editing: boolean; writable: boolean; externalLocked: boolean; onDirty: (value: boolean) => void;
  onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const initial = report.review?.snapshot.request.bindings ?? [];
  const [bindings, setBindings] = useState<ResearchFigureConsistencyBinding[]>(initial);
  const [rationale, setRationale] = useState(''), [dirty, setDirty] = useState(false), [candidateDirty, setCandidateDirty] = useState(false);
  const [validation, setValidation] = useState<string | null>(null), [sceneKey, setSceneKey] = useState(0);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((request: ResearchFigureConsistencySave) => client.api.research.saveFigureConsistencyReview(request),
    {label: '保存图稿数据审核'});
  const change = (): void => {setDirty(true); onDirty(true); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();};
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-figure-consistency-editor">
    <FigureConsistencyScene key={sceneKey} client={client} snapshot={snapshot} report={report} editing={editing}
      writable={writable} locked={externalLocked || save.pending} candidateDirty={candidateDirty}
      onChange={() => {setCandidateDirty(true); change();}} onDiscard={() => setCandidateDirty(false)}
      onAdd={binding => {setBindings(previous => [...previous.filter(value => !sameLocation(value, binding)), binding]);
        setCandidateDirty(false); change();}}/>
    {!editing ? null : <>
      <h3 className="font-medium" data-testid="artifact-figure-consistency-draft-count">待保存图稿映射，共 {bindings.length} 项</h3>
      <ul className="flex min-w-0 flex-col gap-2">
        {bindings.map((binding, index) => <li className="min-w-0 break-words" key={JSON.stringify([binding.markName, binding.channel, binding.scenePath])}>
          <p>{binding.markName}，路径 {binding.scenePath.join('/')}，{binding.channel} → {binding.field}，指标 {binding.metricId}，单位 {binding.unit}</p>
          <p className="break-all text-muted">主张 {binding.claimId}，结果 {binding.resultId}，证据 {binding.evidenceId}</p>
          <details className="text-muted"><summary className="cursor-pointer">待保存场景映射规则</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(binding, null, 2)}</pre>
          </details>
          <button type="button" className={formSecondaryButtonClass} disabled={!writable || externalLocked || save.pending}
            data-testid="artifact-figure-consistency-remove"
            onClick={() => {setBindings(previous => previous.filter((_, position) => position !== index)); change();}}>移除此图稿映射</button>
        </li>)}
      </ul>
      <form className="flex min-w-0 flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        if (!writable || externalLocked || busy.current) return;
        if (candidateDirty) {setValidation('先加入或清空待加入图稿映射，再保存整份审核。'); return;}
        const parent = report.review;
        const parsed = researchFigureConsistencySaveSchema.safeParse({
          projectId: report.projectId, artifactId: report.artifactId, expectedArtifactVersion: report.artifactVersion,
          requestId: requestId.current, figure: {id: report.figure.id, manifestHash: report.figure.manifestHash, traceHash: report.trace.file.sha256},
          parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash}, rationale, bindings
        });
        if (!parsed.success) {setValidation('至少保留一项图稿映射并填写审核理由，最多保存 200 项。'); return;}
        busy.current = true; onPending(true);
        void save.run(parsed.data).then(reply => {
          busy.current = false;
          if (!mounted.current) return;
          onPending(false);
          if (reply.ok) {setDirty(false); onDirty(false); onSaved();}
        });
      }}>
        <fieldset disabled={!writable || externalLocked || save.pending} className="flex min-w-0 flex-col gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-muted">图稿数据审核理由
            <textarea required rows={4} maxLength={4000} aria-label="图稿数据审核理由" className={`${formInputClass} resize-y border-[0.5px]`}
              value={rationale} onChange={event => {setRationale(event.target.value); change();}}/>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={formPrimaryButtonClass} data-testid="artifact-figure-consistency-save">保存图稿数据审核</button>
            <button type="button" className={formSecondaryButtonClass} disabled={!dirty} data-testid="artifact-figure-consistency-discard"
              onClick={() => {setBindings(initial); setRationale(''); setDirty(false); setCandidateDirty(false); onDirty(false);
                setSceneKey(value => value + 1); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();}}>放弃图稿审核修改</button>
          </div>
        </fieldset>
        {save.pending ? <p role="status">正在保存图稿数据审核，请等待回执。</p> : null}
        {validation === null ? null : <p role="alert" className="text-[var(--st-warn)]">{validation}</p>}
        {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
      </form>
    </>}
  </section>;
}
