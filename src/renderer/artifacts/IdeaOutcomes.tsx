import {useState} from 'react';
import type {ResearchIdeaCanvas} from '../../shared/types';
import type {ResearchIdeaPlanInspection, ResearchIdeaPlanGet} from '../../shared/schemas/research-idea-plans';
import type {ResearchIdeaOutcomeHead, ResearchIdeaOutcomeGet} from '../../shared/schemas/research-idea-outcomes';
import type {ResearchExperimentResultGet} from '../../shared/schemas/research-experiment-results';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {IdeaPlanReceipt} from './IdeaPlans';
import {IdeaOutcomeReceipt, outcomeVerdicts} from './IdeaOutcomeReceipt';
import {IdeaOutcomeForm} from './IdeaOutcomeForm';

const button = `${formSecondaryButtonClass} border-[0.5px] self-start`, pageSize = 10;
type Props = {client: RocClient; canvas: ResearchIdeaCanvas; heads: ResearchIdeaOutcomeHead[]; writable: boolean;
  locked: boolean; onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void};

export function IdeaOutcomes(props: Props): React.JSX.Element {
  const {client, canvas, heads, locked} = props;
  const [offset, setOffset] = useState<number | null>(null);
  const [selection, setSelection] = useState<ResearchIdeaPlanGet | null>(null);
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
  const selectionLocked = locked || dirty || pending;
  const history = useAsyncResource(offset === null ? null : `idea:outcome:plans:${canvas.projectId}:${canvas.artifactId}:${offset}`,
    () => client.api.research.getIdeaPlanHistory({projectId: canvas.projectId, artifactId: canvas.artifactId, offset: offset!, limit: pageSize}),
    {label: '读取可评估方法计划'});
  const selected = useAsyncResource(selection === null ? null : `idea:outcome:plan:${JSON.stringify(selection)}`,
    () => client.api.research.getIdeaPlan(selection!), {label: '复核所选冻结方法'});
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-idea-outcomes">
    <h2 className="font-medium">实验结果与假设评估</h2>
    {heads.length === 0 ? <p className="text-muted">尚无保存的人工结果评估。</p> : <ul className="flex flex-col gap-2">
      {heads.map(head => <li key={head.outcomeId} className="break-words">
        {outcomeVerdicts[head.verdict]} 评估版本 {head.version} {head.recordedAt}
        <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">评估 SHA-256 {head.outcomeHash}</p>
      </li>)}
    </ul>}
    <button type="button" className={button} disabled={selectionLocked || history.status === 'loading'}
      data-testid="artifact-idea-outcome-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>
      选择冻结方法与结果
    </button>
    {history.status === 'loading' || selected.status === 'loading' ? <p role="status">正在读取方法计划…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <>
      <p className="text-muted">方法计划共 {history.data.total} 版。只有冻结版本可评估。</p>
      <ul className="flex min-w-0 flex-col gap-2">{history.data.items.map(plan => <li key={plan.version.id}>
        <button type="button" className={`${button} max-w-full text-left`} disabled={selectionLocked || plan.freeze === null}
          data-testid="artifact-idea-outcome-plan" onClick={() => {
            if (selection?.versionId === plan.version.id) selected.reload();
            else setSelection({projectId: canvas.projectId, artifactId: canvas.artifactId,
              versionId: plan.version.id, expectedHash: plan.versionHash});
          }}>方法版本 {plan.version.version} {plan.freeze === null ? '草稿' : '已冻结'} {plan.version.recordedAt}</button>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selectionLocked || offset === 0}
          onClick={() => {setSelection(null); setOffset(offset - pageSize);}}>上一页可评估计划</button>
        <button type="button" className={button} disabled={selectionLocked || offset + pageSize >= history.data.total}
          onClick={() => {setSelection(null); setOffset(offset + pageSize);}}>下一页可评估计划</button>
      </div>
    </>}
    {selected.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{selected.error}</p>}
    {selected.status !== 'ready' || selected.data === null ? null : selected.data.freeze === null ?
      <p role="alert">所选方法尚未冻结，请重新读取计划。</p> :
      <FrozenOutcome key={`${selected.data.versionHash}:${selected.data.freezeHash}`} {...props} plan={selected.data}
        selectionLocked={selectionLocked} onDirty={value => {setDirty(value); props.onDirty(value);}}
        onPending={value => {setPending(value); props.onPending(value);}}/>}
  </section>;
}

function FrozenOutcome({client, canvas, heads, plan, writable, locked, selectionLocked, onDirty, onPending, onSaved}: Props & {
  plan: ResearchIdeaPlanInspection; selectionLocked: boolean
}): React.JSX.Element {
  const [historyOffset, setHistoryOffset] = useState(0);
  const [storedSelection, setStoredSelection] = useState<string | null>(null);
  const [verification, setVerification] = useState<ResearchIdeaOutcomeGet | null>(null);
  const [runsOpen, setRunsOpen] = useState(false), [runId, setRunId] = useState('');
  const [resultOffset, setResultOffset] = useState(0);
  const [resultSelection, setResultSelection] = useState<ResearchExperimentResultGet | null>(null);
  const history = useAsyncResource(`idea:outcome:history:${canvas.projectId}:${plan.version.id}:${historyOffset}`,
    () => client.api.research.getIdeaOutcomeHistory({projectId: canvas.projectId, artifactId: canvas.artifactId,
      versionId: plan.version.id, offset: historyOffset, limit: pageSize}), {label: '读取保存的结果评估'});
  const verified = useAsyncResource(verification === null ? null : `idea:outcome:verify:${JSON.stringify(verification)}`,
    () => client.api.research.getIdeaOutcome(verification!), {label: '复核评估当前来源'});
  const runs = useAsyncResource(!runsOpen ? null : `idea:outcome:runs:${canvas.projectId}`,
    () => client.api.research.listExperiments({projectId: canvas.projectId, limit: 200}), {label: '读取实际实验运行'});
  const results = useAsyncResource(runId === '' ? null : `idea:outcome:results:${canvas.projectId}:${runId}:${resultOffset}`,
    () => client.api.research.listExperimentResults({projectId: canvas.projectId, runId, offset: resultOffset, limit: pageSize}),
    {label: '读取人工审核结果'});
  const result = useAsyncResource(resultSelection === null ? null : `idea:outcome:result:${JSON.stringify(resultSelection)}`,
    () => client.api.research.getExperimentResult(resultSelection!), {label: '复核实际结果来源'});
  const parent = heads.find(head => head.planVersionId === plan.version.id) ?? null;
  const stored = history.status === 'ready' ? history.data?.items.find(receipt => receipt.snapshot.id === storedSelection) : undefined;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-idea-outcome-selected-plan">
    <IdeaPlanReceipt plan={plan}/>
    {history.status === 'loading' ? <p role="status">正在读取评估历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null ? null : <>
      <h3 className="font-medium">保存的评估历史 {history.data.total} 份</h3>
      <ul className="flex min-w-0 flex-col gap-2">{history.data.items.map(receipt => <li key={receipt.snapshot.id}>
        <button type="button" className={`${button} max-w-full text-left`} disabled={selectionLocked}
          data-testid="artifact-idea-outcome-history-select" onClick={() => {setStoredSelection(receipt.snapshot.id); setVerification(null);}}>
          评估版本 {receipt.snapshot.version} {outcomeVerdicts[receipt.snapshot.request.verdict]} {receipt.snapshot.recordedAt}
        </button>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selectionLocked || historyOffset === 0}
          onClick={() => {setStoredSelection(null); setVerification(null); setHistoryOffset(historyOffset - pageSize);}}>上一页评估</button>
        <button type="button" className={button} disabled={selectionLocked || historyOffset + pageSize >= history.data.total}
          onClick={() => {setStoredSelection(null); setVerification(null); setHistoryOffset(historyOffset + pageSize);}}>下一页评估</button>
      </div>
    </>}
    {stored === undefined ? null : <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-idea-outcome-stored">
      <p className="text-muted">保存回执。尚未复核当前运行与来源文件。</p>
      <IdeaOutcomeReceipt receipt={stored}/>
      <button type="button" className={button} disabled={selectionLocked || verified.status === 'loading'}
        data-testid="artifact-idea-outcome-verify" onClick={() => {
          const next = {projectId: canvas.projectId, artifactId: canvas.artifactId, outcomeId: stored.snapshot.id, expectedHash: stored.snapshotHash};
          if (verification?.outcomeId === next.outcomeId) verified.reload(); else setVerification(next);
        }}>复核评估当前来源</button>
    </section>}
    {verified.status === 'loading' ? <p role="status">正在复核当前来源…</p> : null}
    {verified.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{verified.error}</p>}
    {verified.status !== 'ready' || verified.data === null ? null : <section data-testid="artifact-idea-outcome-verified">
      <p role="status">已复核冻结方法、实际运行、结果与指标证据。</p>
      <IdeaOutcomeReceipt receipt={verified.data}/>
    </section>}
    <button type="button" className={button} disabled={selectionLocked || runs.status === 'loading'}
      data-testid="artifact-idea-outcome-runs" onClick={() => {if (runsOpen) runs.reload(); else setRunsOpen(true);}}>
      读取实际实验运行
    </button>
    {runs.status === 'loading' || results.status === 'loading' || result.status === 'loading' ? <p role="status">正在读取实验结果…</p> : null}
    {[runs.error, results.error, result.error].map((error, index) => error === null ? null :
      <p key={index} role="alert" className="break-words text-[var(--st-warn)]">{error}</p>)}
    {runs.status !== 'ready' || runs.data === null ? null : <label className="flex min-w-0 flex-col gap-1 text-muted">
      实际实验运行（最近 200 次）
      <select aria-label="实际实验运行" className={`${formInputClass} border-[0.5px]`} value={runId} disabled={selectionLocked}
        onChange={event => {setRunId(event.target.value); setResultOffset(0); setResultSelection(null);}}>
        <option value="">请选择实际运行</option>
        {runs.data.map(run => <option key={run.id} value={run.id} disabled={run.status !== 'completed'}>
          {run.request.label} {run.id} {run.status}
        </option>)}
      </select>
    </label>}
    {results.status !== 'ready' || results.data === null ? null : <>
      <p className="text-muted">人工审核结果共 {results.data.total} 份</p>
      <ul className="flex min-w-0 flex-col gap-2">{results.data.items.map(receipt => <li key={receipt.snapshot.id}>
        <button type="button" className={`${button} max-w-full break-all text-left`} disabled={selectionLocked}
          data-testid="artifact-idea-outcome-result" onClick={() => {
            if (resultSelection?.resultId === receipt.snapshot.id) result.reload();
            else setResultSelection({projectId: canvas.projectId, resultId: receipt.snapshot.id, expectedHash: receipt.snapshotHash});
          }}>结果 {receipt.snapshot.id} {receipt.snapshot.recordedAt}</button>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selectionLocked || resultOffset === 0}
          onClick={() => {setResultSelection(null); setResultOffset(resultOffset - pageSize);}}>上一页结果</button>
        <button type="button" className={button} disabled={selectionLocked || resultOffset + pageSize >= results.data.total}
          onClick={() => {setResultSelection(null); setResultOffset(resultOffset + pageSize);}}>下一页结果</button>
      </div>
    </>}
    {result.status !== 'ready' || result.data === null ? null : <IdeaOutcomeForm
      key={`${result.data.snapshotHash}:${parent?.outcomeHash ?? 'new'}`} client={client} plan={plan} result={result.data} parent={parent}
      writable={writable && history.status === 'ready'} locked={locked} onDirty={onDirty} onPending={onPending} onSaved={onSaved}/>}
  </section>;
}
