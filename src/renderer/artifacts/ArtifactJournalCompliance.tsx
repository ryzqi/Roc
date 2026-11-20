import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchJournalInspection} from '../../shared/schemas/research-journal-compliance';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {JournalEditor} from './JournalEditor';
import {JournalReceipt, journalStatusLabels} from './JournalReceipt';

const button = `${formSecondaryButtonClass} border-[0.5px]`, pageSize = 10;
export function ArtifactJournalCompliance({client, snapshot, writable, locked: externalLocked, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const baseline = useRef<string | null>(null);
  const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
  const [offset, setOffset] = useState<number | null>(null);
  const [restored, setRestored] = useState<ResearchJournalInspection['report'] | null>(null);
  const {projectId, id: artifactId} = snapshot.artifact, locked = externalLocked || dirty || pending;
  const read = useAsyncResource(`journal:inspect:${projectId}:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectJournalCompliance({projectId, artifactId, selection: null, expectedHash: baseline.current}), {label: '检查投稿材料'});
  const result = read.status === 'ready' ? read.data : null;
  const history = useAsyncResource(offset === null ? null : `journal:history:${projectId}:${artifactId}:${snapshot.version}:${offset}`,
    () => client.api.research.getJournalComplianceHistory({projectId, artifactId, offset: offset!, limit: pageSize}), {label: '读取投稿检查历史'});
  useEffect(() => {if (result?.status === 'current') baseline.current = result.reportHash;}, [result]);
  const matchesArtifact = result !== null && result.report.artifactVersion === snapshot.version;
  return <section className="mt-2 flex min-w-0 flex-col gap-3" data-testid="artifact-journal-compliance" aria-label="期刊投稿检查">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-medium">期刊投稿检查</h2>
      <button type="button" className={button} disabled={locked || read.status === 'loading'} data-testid="artifact-journal-refresh"
        onClick={() => {setEditing(false); setRestored(null); read.reload();}}>重新检查投稿材料</button>
    </div>
    {read.status === 'loading' ? <p role="status">正在核对投稿规则与材料…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {result !== null && !matchesArtifact ? <p role="alert" className="text-[var(--st-warn)]">工件已变化，请先刷新工件。</p> : null}
    {result === null || !matchesArtifact ? null : <>
      {result.status !== 'stale' ? null : <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[var(--st-warn)]">投稿检查报告已变化，请核对当前版本。</p>
        <button type="button" className={button} disabled={locked} data-testid="artifact-journal-recapture"
          onClick={() => {setEditing(false); baseline.current = result.reportHash; read.reload();}}>按当前版本核对投稿</button>
      </div>}
      <p className="break-all font-mono text-muted" data-testid="artifact-journal-hash">报告 SHA-256：{result.reportHash}</p>
      {result.report.selection === null ? <p className="text-muted">尚未选择期刊规则。</p> : <>
        <p className="break-words">{result.report.selection.profile.journal}，{result.report.selection.profile.articleType}，{result.report.selection.profile.submissionStage}</p>
        <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-journal-checks">
          {result.report.checks.map(check => <li className="break-words" key={check.ruleId}>
            {result.report.selection!.profile.rules.find(rule => rule.id === check.ruleId)!.label}：{journalStatusLabels[check.status]}。{check.detail}
          </li>)}
        </ul>
      </>}
      {result.report.review === null ? null : <>
        {!result.report.reviewCurrent ? <p role="alert" className="text-[var(--st-warn)]">规则或材料已变化，保存的判断需要重新核对。</p> :
          <p className="text-muted">保存的规则与当前材料一致。论文接受仍需人工决定。</p>}
        <JournalReceipt receipt={result.report.review}/>
      </>}
      <button type="button" className={`${button} self-start`} disabled={locked || result.status !== 'current'}
        data-testid="artifact-journal-edit" onClick={() => setEditing(value => !value)}>{editing ? '收起规则编辑' : '编辑投稿规则'}</button>
      {!editing ? null : <JournalEditor key={result.reportHash} client={client} report={result.report}
        writable={writable && !externalLocked && result.status === 'current'}
        onDirty={value => {setDirty(value); onDirty(value);}} onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved}/>}
    </>}
    {restored === null ? null : <>
      <p role="status" className="text-muted">正在编辑最新保存的规则。当前材料尚未核验，请重新检查后保存。</p>
      <JournalEditor key={restored.review!.snapshotHash} client={client} report={restored}
        writable={writable && !externalLocked}
        onDirty={value => {setDirty(value); onDirty(value);}} onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved}/>
    </>}
    <button type="button" className={`${button} self-start`} disabled={locked || history.status === 'loading'}
      data-testid="artifact-journal-history-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>读取投稿检查历史</button>
    {history.status === 'loading' ? <p role="status">正在读取保存的检查历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-journal-history">
      <p className="text-muted">保存回执，共 {history.data.total} 版。历史材料未按当前来源复核。</p>
      {read.status !== 'error' || offset !== 0 || history.data.items.length === 0 || restored !== null ? null :
        <button type="button" className={`${button} self-start`} disabled={locked} data-testid="artifact-journal-repair" onClick={() => {
          const review = history.data!.items[0]!;
          setRestored({projectId, artifactId, artifactVersion: snapshot.version, selection: review.snapshot.request.selection,
            material: null, materialHash: null, checks: [], review, reviewCurrent: false});
        }}>编辑最新保存规则并重新检查</button>}
      {history.data.items.map(receipt => <JournalReceipt key={receipt.snapshot.id} receipt={receipt}/>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked || offset === 0} data-testid="artifact-journal-history-prev"
          onClick={() => setOffset(offset - pageSize)}>上一页检查</button>
        <button type="button" className={button} disabled={locked || offset + pageSize >= history.data.total} data-testid="artifact-journal-history-next"
          onClick={() => setOffset(offset + pageSize)}>下一页检查</button>
      </div>
    </section>}
  </section>;
}
