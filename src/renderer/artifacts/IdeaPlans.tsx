import {useEffect, useRef, useState} from 'react';
import type {ResearchIdeaCanvas} from '../../shared/types';
import type {ResearchIdeaPlanBody, ResearchIdeaPlanInspection, ResearchIdeaPlanSave, ResearchIdeaPlanFreezeRequest} from '../../shared/schemas/research-idea-plans';
import {researchIdeaPlanSaveSchema} from '../../shared/schemas/research-idea-plans';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {IdeaPlanFields, PlanText} from './IdeaPlanFields';

const button = `${formSecondaryButtonClass} border-[0.5px] self-start`;
const primary = `${formPrimaryButtonClass} border-[0.5px] self-start`;

function newBody(canvas: ResearchIdeaCanvas): ResearchIdeaPlanBody {
  return {hypothesis: canvas.hypothesis, falsifiableIf: '',
    metrics: [{id: '', label: '', definition: '', unit: '', direction: 'neutral', expectedOutcome: ''}],
    dataPlan: '', design: canvas.experiment, analysisPlan: '', observation: {kind: 'before_data'},
    novelty: {status: 'pending_verification', searchScope: '', comparisons: []},
    sampleSize: {kind: 'not_calculated', reason: ''}};
}

export function IdeaPlanReceipt({plan}: {plan: ResearchIdeaPlanInspection}): React.JSX.Element {
  const {version, freeze} = plan;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-idea-plan-receipt">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>计划状态</dt><dd>{freeze === null ? '已保存草稿' : '已冻结'}{plan.isLatest ? ' 当前版本' : ' 历史版本'}</dd>
      <dt>计划版本</dt><dd>{version.version}</dd>
      <dt>记录人</dt><dd className="break-all">{version.actor.id}</dd>
      <dt>记录时间</dt><dd>{version.recordedAt}</dd>
      <dt>Canvas 版本</dt><dd>{version.request.canvas.version}{plan.canvasCurrent ? ' 当前 Canvas' : ' Canvas 已变化'}</dd>
      <dt>观察时序</dt><dd>{version.request.body.observation.kind === 'before_data' ? '人工声明：观察数据前' : '人工声明：观察数据后'}</dd>
      {version.request.revisionReason === null ? null : <><dt>修订原因</dt><dd className="break-words">{version.request.revisionReason}</dd></>}
      {freeze === null ? null : <><dt>冻结时间</dt><dd>{freeze.frozenAt}</dd>
        <dt>审核人</dt><dd className="break-all">{freeze.actor.id}</dd>
        <dt>审核说明</dt><dd className="break-words">{freeze.request.reviewNote}</dd></>}
    </dl>
    <p className="break-all font-mono text-muted text-[length:var(--font-meta-size)]">计划 SHA-256 {plan.versionHash}</p>
    {plan.freezeHash === null ? null : <p className="break-all font-mono text-muted text-[length:var(--font-meta-size)]">冻结 SHA-256 {plan.freezeHash}</p>}
    <details><summary className="cursor-pointer">保存的方法与预期结果</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(version.request.body, null, 2)}</pre>
    </details>
  </section>;
}

export function IdeaPlans({client, canvas, current, writable, locked, onPending, onDirty, onSaved}: {
  client: RocClient; canvas: ResearchIdeaCanvas; current: ResearchIdeaPlanInspection | null; writable: boolean; locked: boolean;
  onPending: (pending: boolean) => void; onDirty: (dirty: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(() => current === null ? newBody(canvas) : structuredClone(current.version.request.body));
  const [parameters, setParameters] = useState(() => body.sampleSize.kind === 'calculated' ?
    Object.entries(body.sampleSize.parameters).map(([key, value]) => `${key}=${value}`).join('\n') : '');
  const [editing, setEditing] = useState(current === null);
  const [observationChoice, setObservationChoice] = useState<ResearchIdeaPlanBody['observation']['kind'] | ''>(
    current === null ? '' : body.observation.kind);
  const [revisionReason, setRevisionReason] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [validation, setValidation] = useState<string[]>([]);
  const [historyOffset, setHistoryOffset] = useState<number | null>(null);
  const [selection, setSelection] = useState<{versionId: string; expectedHash: string} | null>(null);
  const requests = useRef({save: crypto.randomUUID(), freeze: crypto.randomUUID()});
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((request: ResearchIdeaPlanSave) => client.api.research.saveIdeaPlan(request), {label: '保存方法计划'});
  const freeze = useAsyncAction((request: ResearchIdeaPlanFreezeRequest) => client.api.research.freezeIdeaPlan(request), {label: '冻结方法计划'});
  const pending = save.pending || freeze.pending;
  const canEdit = writable && (current === null || current.isLatest);
  const history = useAsyncResource(historyOffset === null ? null :
    `idea:history:${canvas.artifactId}:${current?.versionHash ?? 'new'}:${historyOffset}`,
    () => client.api.research.getIdeaPlanHistory({projectId: canvas.projectId, artifactId: canvas.artifactId, offset: historyOffset!, limit: 10}),
    {label: '读取方法计划历史'});
  const selected = useAsyncResource(selection === null ? null : `idea:version:${canvas.artifactId}:${JSON.stringify(selection)}`,
    () => client.api.research.getIdeaPlan({projectId: canvas.projectId, artifactId: canvas.artifactId, ...selection!}),
    {label: '复核历史方法计划'});
  const change = (): void => {requests.current.save = crypto.randomUUID(); onDirty(true); setValidation([]); save.reset();};
  const updateBody = (value: ResearchIdeaPlanBody): void => {setBody(value); change();};
  const finish = (result: {ok: true; data: ResearchIdeaPlanInspection} | {ok: false; error: string}): void => {
    busy.current = false;
    if (!mounted.current) return;
    onPending(false);
    if (result.ok) {onDirty(false); onSaved();}
  };
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-idea-plans">
    <h2 className="font-medium">假设与方法计划</h2>
    {current === null ? <p className="text-muted">尚无已保存方法计划。</p> : <IdeaPlanReceipt plan={current}/>}
    {!canEdit || editing ? null : <button type="button" className={button} disabled={pending || locked} data-testid="artifact-idea-plan-revise"
      onClick={() => {setEditing(true); updateBody({...body, hypothesis: canvas.hypothesis});}}>修订方法计划</button>}
    {!editing ? null : <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-idea-plan-form" onSubmit={event => {
      event.preventDefault();
      if (!canEdit || locked || busy.current) return;
      if (observationChoice === '') {setValidation(['请选择此版本的观察时序。']); return;}
      let requestBody = body;
      if (body.sampleSize.kind === 'calculated') {
        const entries = parameters.split('\n').filter(line => line.trim().length > 0).map(line => {
          const separator = line.indexOf('=');
          return separator < 1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
        });
        if (entries.some(entry => entry === null || entry[0].length === 0 || entry[1].length === 0) ||
          new Set(entries.map(entry => entry?.[0])).size !== entries.length) {
          setValidation(['计算参数必须逐行填写唯一名称和非空值。']); return;
        }
        requestBody = {...body, sampleSize: {...body.sampleSize, parameters: Object.fromEntries(entries as [string, string][])}};
      }
      const parsed = researchIdeaPlanSaveSchema.safeParse({projectId: canvas.projectId, artifactId: canvas.artifactId,
        requestId: requests.current.save, canvas: {version: canvas.version, contentHash: canvas.contentHash},
        parent: current === null ? null : {versionId: current.version.id, versionHash: current.versionHash},
        revisionReason: current === null ? null : revisionReason, body: requestBody});
      if (!parsed.success) {setValidation(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return;}
      busy.current = true; onPending(true); void save.run(parsed.data).then(finish);
    }}>
      <IdeaPlanFields body={body} disabled={!canEdit || pending || locked} onChange={updateBody} parameters={parameters}
        onParameters={value => {setParameters(value); change();}}
        observationChoice={observationChoice} onObservationChoice={value => {setObservationChoice(value); change();}}/>
      {current === null ? null : <fieldset disabled={!canEdit || pending || locked}><PlanText label="计划修订原因" value={revisionReason}
        onChange={value => {setRevisionReason(value); change();}}/></fieldset>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primary} disabled={!canEdit || pending || locked} data-testid="artifact-idea-plan-save">
          {pending ? '正在保存…' : current === null ? '保存方法计划' : '保存计划新版本'}
        </button>
        <button type="button" className={button} disabled={pending || locked} data-testid="artifact-idea-plan-discard" onClick={() => {
          const restored = current === null ? newBody(canvas) : structuredClone(current.version.request.body);
          onDirty(false); setEditing(false); setBody(restored);
          setObservationChoice(current === null ? '' : restored.observation.kind);
          setParameters(restored.sampleSize.kind === 'calculated' ?
            Object.entries(restored.sampleSize.parameters).map(([key, value]) => `${key}=${value}`).join('\n') : '');
          setRevisionReason(''); setValidation([]); save.reset();
        }}>放弃未保存修改</button>
      </div>
    </form>}
    {current !== null || editing || !canEdit ? null : <button type="button" className={button} disabled={locked}
      onClick={() => setEditing(true)}>编写方法计划</button>}
    {validation.length === 0 ? null : <ul role="alert" className="break-words text-[var(--st-warn)]">
      {validation.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
    {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
    {current === null || !canEdit || editing || current.freeze !== null || !current.canvasCurrent ? null :
      <form className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" onSubmit={event => {
        event.preventDefault(); if (busy.current || locked) return;
        busy.current = true; onPending(true);
        void freeze.run({projectId: canvas.projectId, artifactId: canvas.artifactId, versionId: current.version.id,
          expectedHash: current.versionHash, requestId: requests.current.freeze, reviewNote}).then(finish);
      }}>
        <fieldset disabled={pending || locked}><PlanText label="计划冻结审核说明" value={reviewNote} onChange={value => {
          setReviewNote(value); requests.current.freeze = crypto.randomUUID(); freeze.reset(); onDirty(value.length > 0);
        }}/></fieldset>
        <button type="submit" className={primary} disabled={pending || locked || reviewNote.trim().length === 0}
          data-testid="artifact-idea-plan-freeze">确认并冻结方法计划</button>
        <button type="button" className={button} disabled={pending || locked} onClick={() => {
          setReviewNote(''); freeze.reset(); onDirty(false);
        }}>放弃冻结审核修改</button>
      </form>}
    {freeze.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{freeze.error}</p>}
    <button type="button" className={button} disabled={pending || locked || editing || history.status === 'loading'}
      data-testid="artifact-idea-plan-history" onClick={() => {if (historyOffset === 0) history.reload(); else setHistoryOffset(0);}}>
      读取计划历史
    </button>
    {history.status === 'loading' || selected.status === 'loading' ? <p role="status">正在读取计划历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}
      <button type="button" className={button} onClick={history.reload}>重试历史读取</button></p>}
    {history.data === null ? null : <div className="flex min-w-0 flex-col gap-2" data-testid="artifact-idea-plan-history-list">
      <p className="text-muted">共 {history.data.total} 个版本</p>
      {history.data.items.map(plan => <button type="button" className={`${button} max-w-full text-left`} key={plan.version.id}
        disabled={pending || locked || editing} data-testid="artifact-idea-plan-history-select" onClick={() => setSelection({versionId: plan.version.id, expectedHash: plan.versionHash})}>
        版本 {plan.version.version} {plan.freeze === null ? '草稿' : '已冻结'} {plan.version.recordedAt}
      </button>)}
      <div className="flex gap-2">
        <button type="button" className={button} disabled={pending || locked || editing || historyOffset === null || historyOffset === 0 || history.status === 'loading'}
          onClick={() => {setSelection(null); setHistoryOffset(historyOffset! - 10);}}>上一页计划</button>
        <button type="button" className={button} disabled={pending || locked || editing || historyOffset === null || historyOffset + 10 >= history.data.total || history.status === 'loading'}
          onClick={() => {setSelection(null); setHistoryOffset(historyOffset! + 10);}}>下一页计划</button>
      </div>
    </div>}
    {selected.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{selected.error}</p>}
    {selected.data === null ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2"
      data-testid="artifact-idea-plan-history-receipt"><h3 className="font-medium">所选历史计划</h3><IdeaPlanReceipt plan={selected.data}/></section>}
  </section>;
}
