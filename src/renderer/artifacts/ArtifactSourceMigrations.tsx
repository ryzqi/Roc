import {useEffect, useRef, useState} from 'react';
import type {
  ResearchSourceMigrationInspection, ResearchSourceMigrationDecisionRequest, ResearchSourceMigrationDecision
} from '../../shared/schemas/research-source-migrations';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const input = `${formInputClass} min-w-0 border-[0.5px]`;
const matches = {exact_text: '完整原文匹配', normalized_text: '仅规范空白后匹配', ambiguous: '多个匹配，需选择', no_match: '没有匹配目标'};

export function ArtifactSourceMigrations({client, projectId, evidenceId, canDecide}: {
  client: RocClient; projectId: string; evidenceId: string; canDecide: boolean
}): React.JSX.Element {
  const read = useAsyncResource(`source-migrations:${projectId}:${evidenceId}`,
    () => client.api.research.listSourceMigrations({projectId, evidenceId}), {label: '读取定位候选'});
  const guard = useArtifactEditorGuard();
  return <section aria-label="来源定位候选" data-testid="artifact-source-migrations" className="mt-3 flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">定位候选</h3>
      <button type="button" className={button} data-testid="artifact-source-migrations-refresh" disabled={read.status === 'loading' || guard.locked()}
        data-reading-key={`source-migrations-refresh:${evidenceId}`} onClick={() => {
          if (!guard.locked()) read.reload();
        }}>刷新候选</button>
    </div>
    <p className="text-muted">按解析时间和原始块顺序排列。位置捕获只保存新证据；主张与科学审核仍需另行重建。</p>
    {read.status === 'loading' ? <p role="status">正在读取定位候选…</p> : null}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-error)]">{read.error}</p>}
    {read.status !== 'ready' || read.data === null ? null : read.data.length === 0 ? <p className="text-muted">没有保存的同文档定位候选。</p> :
      read.data.map(inspection => <MigrationCandidate key={`${inspection.proposal.id}:${inspection.proposalHash}:${inspection.decision?.id ?? 'pending'}`}
        client={client} inspection={inspection} canDecide={canDecide} onChanged={read.reload}/>)}
  </section>;
}

function MigrationCandidate({client, inspection, canDecide, onChanged}: {
  client: RocClient; inspection: ResearchSourceMigrationInspection; canDecide: boolean; onChanged: () => void
}): React.JSX.Element {
  const {proposal, decision} = inspection;
  const [chunkId, setChunkId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const busy = useRef(false);
  const draft = useArtifactDraft('来源定位决定', {chunkId, note}, busy);
  const requestIds = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const action = useAsyncAction((request: ResearchSourceMigrationDecisionRequest) => request.action === 'capture' ?
    client.api.research.captureSourceMigration(request) : client.api.research.rejectSourceMigration(request),
  {label: '决定来源定位候选'});
  const submit = async (choice: 'capture' | 'reject'): Promise<void> => {
    if (busy.current || draft.isLocked() || !canDecide || decision !== null ||
      (choice === 'capture' && (chunkId === null || inspection.targetStatus !== 'current'))) return;
    const fields = {projectId: proposal.projectId, proposalId: proposal.id, expectedProposalHash: inspection.proposalHash,
      expectedSourceDigest: proposal.sourceDigest, expectedTargetParseHash: proposal.targetParseHash,
      note: note.trim() === '' ? null : note.trim()};
    let selection: {action: 'capture'; chunkId: string} | {action: 'reject'};
    if (choice === 'capture') {
      if (chunkId === null) return;
      selection = {action: 'capture', chunkId};
    } else selection = {action: 'reject'};
    const key = JSON.stringify({...fields, ...selection});
    let requestId = requestIds.current.get(key);
    if (requestId === undefined) {requestId = crypto.randomUUID(); requestIds.current.set(key, requestId);}
    const request: ResearchSourceMigrationDecisionRequest = {...fields, requestId, ...selection};
    busy.current = true;
    const result = await action.run(request); busy.current = false;
    if (result.ok && mounted.current) {draft.saved(); onChanged();}
  };
  const canCapture = canDecide && !draft.locked && inspection.targetStatus === 'current' && decision === null && !action.pending;
  return <details data-testid={`artifact-source-migration-${proposal.id}`} data-reading-key={`source-migration:${proposal.id}`}
    className="min-w-0 border-t-[0.5px] border-line py-2 [&::details-content]:overflow-clip!">
    <summary data-reading-key={`source-migration-summary:${proposal.id}`} className="cursor-pointer break-words">
      {matches[proposal.match]}<span className="ml-2 text-muted">{decision === null ? '待核查' : decision.request.action === 'capture' ? '已捕获新证据' : '已拒绝'}</span>
      <span className="ml-2 text-muted">{inspection.targetStatus === 'current' ? '当前解析' : '旧目标已被新解析替换'}</span>
    </summary>
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <p className="break-words text-muted">解析时间 {proposal.createdAt}</p>
      <p className="break-all text-muted">原解析 {proposal.source.sourceLocator!.parseId}，目标解析 {proposal.targetParseId}</p>
      <details data-reading-key={`source-migration-hashes:${proposal.id}`} className="text-muted">
        <summary data-reading-key={`source-migration-hashes-summary:${proposal.id}`} className="cursor-pointer">固定来源与候选哈希</summary>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[length:var(--font-meta-size)]">
          <dt>候选</dt><dd className="break-all">{inspection.proposalHash}</dd>
          <dt>原来源</dt><dd className="break-all">{proposal.sourceDigest}</dd>
          <dt>目标原文</dt><dd className="break-all">{proposal.targetSourceHash}</dd>
          <dt>目标解析</dt><dd className="break-all">{proposal.targetParseHash}</dd>
        </dl>
      </details>
      {proposal.targets.length === 0 ? <p className="text-muted">正文已改变，不能自动迁移定位。</p> :
        <fieldset disabled={!canCapture} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-muted">{decision === null ? '明确选择目标块' : '当时的候选目标'}</legend>
          {proposal.targets.map((target, index) => <label key={target.chunkId} className="flex min-w-0 items-start gap-2">
            <input type="radio" name={`source-migration-${proposal.id}`} value={target.chunkId}
              checked={chunkId === target.chunkId || decision?.request.action === 'capture' && decision.request.chunkId === target.chunkId}
              onChange={() => setChunkId(target.chunkId)} data-testid={`artifact-source-migration-target-${index}`}
              data-reading-key={`source-migration-target:${proposal.id}:${target.chunkId}`}
              className="mt-1 shrink-0 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-accent"/>
            <span className="min-w-0 flex-1">
              <span className="block break-words">{target.block.locator}{target.textSpan ? `；原文字符 ${target.textSpan.start + 1}–${target.textSpan.end}` : ''}</span>
              <span className="block text-muted">{target.block.locations.length === 0 ? '未提供页或区域' :
                `解析页 ${[...new Set(target.block.locations.map(location => location.page))].join('、')}`}</span>
              <span className="block break-all text-muted">块 {target.block.id}</span>
              <span className="block whitespace-pre-wrap break-words">{target.textSpan ? target.block.text.slice(target.textSpan.start, target.textSpan.end) : target.block.text}</span>
            </span>
          </label>)}
        </fieldset>}
      {decision === null ? <>
        {!canDecide ? <p className="text-muted">重新核对当前工件后再决定；归档项目只读。</p> : null}
        <label className="flex min-w-0 flex-col gap-1 text-muted">决定说明
          <textarea rows={2} maxLength={10000} className={input} value={note} disabled={!canDecide || action.pending || draft.locked}
            onChange={event => setNote(event.target.value)} data-testid="artifact-source-migration-note"
            data-reading-key={`source-migration-note:${proposal.id}`}/>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={!canCapture || chunkId === null}
            data-testid="artifact-source-migration-capture" onClick={() => {void submit('capture');}}>捕获选中块</button>
          <button type="button" className={button} disabled={!canDecide || action.pending || draft.locked}
            data-testid="artifact-source-migration-reject" onClick={() => {void submit('reject');}}>拒绝此候选</button>
        </div>
        <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-source-migration-discard" onDiscard={() => {
          setChunkId(null); setNote(''); draft.reset({chunkId: null, note: ''}); action.reset();
        }}/>
        {action.pending ? <p role="status">正在保存决定…</p> : null}
        {action.error === null ? null : <p role="alert" className="text-[var(--st-error)]">{action.error}</p>}
      </> : <MigrationDecision decision={decision} currentStatus={inspection.capturedReferenceStatus}/>}
    </div>
  </details>;
}

function MigrationDecision({decision, currentStatus}: {
  decision: ResearchSourceMigrationDecision; currentStatus: ResearchSourceMigrationInspection['capturedReferenceStatus']
}): React.JSX.Element {
  const source = decision.capturedSource;
  return <div data-testid="artifact-source-migration-decision" className="flex min-w-0 flex-col gap-1 text-muted">
    <p className="break-words">用户 {decision.actor.id}，决定时间 {decision.recordedAt}</p>
    {decision.request.note === null ? null : <p className="whitespace-pre-wrap break-words">{decision.request.note}</p>}
    {source === null ? <p>已拒绝，未捕获新证据。</p> : <>
      <p className="break-all">新证据 {source.evidence.id}</p>
      <p className="break-words">捕获位置 {source.evidence.locator}。{currentStatus === 'recorded' ? '当前定位仍有效。' : '该新证据的位置也已失效。'}</p>
      <blockquote className="whitespace-pre-wrap break-words text-ink">{source.evidence.excerpt}</blockquote>
    </>}
    <details data-reading-key={`source-migration-decision:${decision.id}`}>
      <summary data-reading-key={`source-migration-decision-summary:${decision.id}`} className="cursor-pointer">决定与请求原记录</summary>
      <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(decision, null, 2)}</pre>
    </details>
    <p>原证据与科学审核记录保持不变。</p>
  </div>;
}
