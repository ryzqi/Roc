import {lazy, Suspense, useEffect, useMemo, useRef, useState} from 'react';
import type {z} from 'zod';
import type {researchArtifactInspectionSchema} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchEvidenceRelation} from '../../shared/schemas/research-evidence-relations';
import type {ResearchClaim} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

type Snapshot = z.infer<typeof researchArtifactInspectionSchema>;
const button = `${formSecondaryButtonClass} border-[0.5px]`;
const inputClass = `${formInputClass} min-w-0 border-[0.5px]`;
const DocumentSource = lazy(async () => ({default: (await import('./ArtifactDocumentSource')).ArtifactDocumentSource}));
const kinds = {supports: '支持', contradicts: '反对', qualifies: '限定', depends_on: '依赖', supersedes: '替代', historical: '历史关联'};
const statuses = {proposed: '待审核', confirmed: '已确认', rejected: '已拒绝', invalidated: '已失效', historical: '未经语义审核'};
const reasons = {claim_changed: '主张版本已改变', evidence_invalidated: '来源已失效', superseded: '已由新关系替代'};
const claimStatuses = {supported: '声明有证据支持', hypothesis: '假设', pending: '待核查'};
const isCurrent = (relation: ResearchEvidenceRelation, snapshot: Snapshot, claim: ResearchClaim): boolean =>
  relation.claimVersion === claim.version && snapshot.evidence.some(source =>
    source.evidence.id === relation.evidenceId && source.referenceStatus === 'recorded' &&
    JSON.stringify(source) === JSON.stringify(relation.source));

export function ArtifactRelations({client, snapshot, current, onChanged}: {
  client: RocClient; snapshot: Snapshot; current: boolean; onChanged: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('all');
  const canReview = current && snapshot.artifact.status === 'draft' && snapshot.projectStatus !== 'archived' &&
    snapshot.currentStage === snapshot.artifact.stage && snapshot.stage.artifactIds.includes(snapshot.artifact.id) &&
    ['ready', 'running', 'paused', 'blocked', 'failed', 'waiting_approval'].includes(snapshot.stage.status);
  const rows = useMemo(() => snapshot.claims.map(claim => {
    const relations = snapshot.relations.filter(relation => relation.claimId === claim.id);
    const active = relations.filter(relation => isCurrent(relation, snapshot, claim));
    const confirmed = active.filter(relation => relation.status === 'confirmed');
    return {claim, relations, active, weak: !confirmed.some(relation => relation.kind === 'supports' || relation.kind === 'qualifies'),
      conflict: confirmed.some(relation => relation.kind === 'contradicts'),
      pending: active.some(relation => relation.status === 'proposed')};
  }), [snapshot]);
  const visible = rows.filter(row => filter === 'all' || (filter === 'weak' && row.weak) ||
    (filter === 'conflict' && row.conflict) || (filter === 'pending' && row.pending));
  return <section aria-label="主张与证据关系" data-testid="artifact-relations" className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2">
    <h2 className="font-medium">主张与证据关系</h2>
    {canReview && snapshot.artifact.stage === 'figure' && !snapshot.claims.some(claim => claim.subjectType === 'figure') ?
      <FigureCaptionClaim client={client} snapshot={snapshot} onChanged={onChanged}/> : null}
    <label className="flex items-center gap-2 text-muted"><span className="shrink-0">查看</span>
      <select value={filter} onChange={event => setFilter(event.target.value)} data-testid="artifact-relations-filter"
        data-reading-key="relations-filter" className={inputClass}>
        <option value="all">全部主张</option><option value="weak">未确认支持</option>
        <option value="conflict">已确认反对</option><option value="pending">存在待审核提议</option>
      </select>
    </label>
    <p className="text-muted text-[length:var(--font-meta-size)]">按主张原顺序排列。统计当前版本的人工确认与待审核提议；历史关联不计为支持。</p>
    {visible.length === 0 ? <p className="text-muted">没有符合条件的主张。</p> : <>
      <table className="w-full table-fixed text-left" data-testid="artifact-relations-matrix">
        <colgroup><col className="w-[46%]"/><col className="w-[18%]"/><col className="w-[18%]"/><col className="w-[18%]"/></colgroup>
        <thead className="text-muted text-[length:var(--font-meta-size)]"><tr>
          <th scope="col" className="py-1 font-medium">主张</th>
          {(['supports', 'contradicts', 'qualifies'] as const).map(kind => <th key={kind} scope="col" className="py-1 font-medium">{kinds[kind]}</th>)}
        </tr></thead>
        <tbody>{visible.map(({claim, active}) => <tr key={claim.id} className="border-t-[0.5px] border-line">
          <th scope="row" className="py-2 pr-2 align-top font-normal">
            <button type="button" className="w-full break-words text-left underline decoration-line underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`artifact-relations-claim-${claim.id}`} data-reading-key={`relation-claim-link:${claim.id}`}
              onClick={() => {
                const details = document.getElementById(`relation-claim-${claim.id}`) as HTMLDetailsElement;
                // The destination must not consume the jump button's same Enter activation.
                details.open = true; details.focus();
              }}>{claim.content}</button>
          </th>
          {(['supports', 'contradicts', 'qualifies'] as const).map(kind => <td key={kind} className="py-2 align-top">
            <span className="block">确认 {active.filter(relation => relation.kind === kind && relation.status === 'confirmed').length}</span>
            <span className="block text-muted">提议 {active.filter(relation => relation.kind === kind && relation.status === 'proposed').length}</span>
          </td>)}
        </tr>)}</tbody>
      </table>
      {visible.map(({claim, relations}) => <details key={claim.id} id={`relation-claim-${claim.id}`}
        tabIndex={-1} data-reading-key={`relation-claim:${claim.id}`}
        className="border-t-[0.5px] border-line py-2 focus-visible:outline-2 focus-visible:outline-accent">
        <summary data-reading-key={`relation-claim-summary:${claim.id}`} className="cursor-pointer break-words">{claim.content}</summary>
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-muted">{claimStatuses[claim.status]}，版本 {claim.version}</p>
          {relations.length === 0 ? <p className="text-muted">尚无关系提议。</p> : relations.map(relation =>
            <RelationRecord key={relation.id} client={client} relation={relation}
              canReview={canReview && isCurrent(relation, snapshot, claim)} onChanged={onChanged}/>)}
          {canReview ? <RelationProposal client={client} snapshot={snapshot} claim={claim} onChanged={onChanged}/> : null}
        </div>
      </details>)}
    </>}
  </section>;
}

function FigureCaptionClaim({client, snapshot, onChanged}: {
  client: RocClient; snapshot: Snapshot; onChanged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">补充图注声明</summary>
    {open ? <FigureCaptionForm client={client} snapshot={snapshot} onChanged={onChanged}/> : null}
  </details>;
}

function FigureCaptionForm({client, snapshot, onChanged}: {
  client: RocClient; snapshot: Snapshot; onChanged: () => void
}): React.JSX.Element {
  const projectId = snapshot.artifact.projectId;
  const [content, setContent] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const changed = useChangedAfterAction(onChanged);
  const evidence = useAsyncResource(`caption-evidence:${projectId}`, () => client.api.research.listEvidence({projectId}), {label: '读取图注证据'});
  const source = useAsyncResource(evidenceId === '' ? null : `caption-source:${projectId}:${evidenceId}`,
    () => client.api.research.inspectEvidence({projectId, evidenceId}), {label: '读取图注来源'});
  const selected = source.status === 'ready' && source.data?.source.evidence.id === evidenceId ? source.data.source : null;
  const valid = content.trim() !== '' && selected?.referenceStatus === 'recorded';
  const save = useAsyncAction(async () => {
    if (!valid) throw new Error('research_relation_source_required');
    const current = await client.api.research.inspectArtifact({projectId, artifactId: snapshot.artifact.id, expectedVersion: snapshot.version});
    if (!current.ok) return current;
    if (current.data.status !== 'current') throw new Error('research_artifact_review_changed');
    return client.api.research.createClaim({projectId, artifactId: snapshot.artifact.id,
      subjectType: 'figure', content: content.trim(), status: 'supported', evidenceIds: [evidenceId]});
  }, {label: '保存图注声明'});
  return <div className="mt-2 flex flex-col gap-2" data-testid="artifact-caption-form">
    <label className="flex flex-col gap-1 text-muted">图注声明
      <textarea className={`${inputClass} min-h-24 resize-y`} value={content} maxLength={20000} disabled={save.pending}
        data-testid="artifact-caption-content" onChange={event => setContent(event.target.value)}/>
    </label>
    <label className="flex flex-col gap-1 text-muted">证据来源
      <select className={inputClass} value={evidenceId} disabled={save.pending || evidence.status !== 'ready'}
        data-testid="artifact-caption-source" onChange={event => setEvidenceId(event.target.value)}>
        <option value="">选择已保存证据</option>
        {evidence.data?.map(item => <option key={item.id} value={item.id}>{item.title}，{item.locator}</option>)}
      </select>
    </label>
    {evidence.status === 'loading' || source.status === 'loading' ? <p role="status">正在读取来源…</p> : null}
    {evidence.error === null ? null : <div><p role="alert">{evidence.error}</p><button type="button" className={button} onClick={evidence.reload}>重读证据</button></div>}
    {source.error === null ? null : <div><p role="alert">{source.error}</p><button type="button" className={button} onClick={source.reload}>重读来源</button></div>}
    {selected === null ? null : <>
      <blockquote className="whitespace-pre-wrap break-words">{selected.evidence.excerpt}</blockquote>
      {selected.referenceStatus === 'recorded' ? null : <p role="alert">此来源已失效。</p>}
    </>}
    <button type="button" className={`${button} self-start`} disabled={!valid || save.pending}
      data-testid="artifact-caption-save" onClick={async () => {const outcome = await save.run(); if (outcome.ok) changed();}}>
      {save.pending ? '正在保存…' : '保存图注声明'}</button>
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{save.error}</p>}
  </div>;
}

function useChangedAfterAction(onChanged: () => void): () => void {
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  return () => {if (mounted.current) onChanged();};
}

function RelationRecord({client, relation, canReview, onChanged}: {
  client: RocClient; relation: ResearchEvidenceRelation; canReview: boolean; onChanged: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const [historyNonce, setHistoryNonce] = useState(0);
  const [showDocument, setShowDocument] = useState(false);
  const changed = useChangedAfterAction(onChanged);
  const review = useAsyncAction((decision: 'confirm' | 'reject') => client.api.research.reviewEvidenceRelation({
    projectId: relation.projectId, relationId: relation.id, expectedVersion: relation.version,
    expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest,
    decision, note: note.trim() === '' ? null : note.trim()
  }), {label: '审核证据关系'});
  const history = useAsyncResource(historyNonce === 0 ? null : `relation-history:${relation.projectId}:${relation.id}:${relation.version}:${historyNonce}`,
    () => client.api.research.evidenceRelationHistory({projectId: relation.projectId, relationId: relation.id}),
    {label: '读取关系修订历史'});
  const source = relation.source;
  return <article data-testid={`artifact-relation-${relation.id}`} className="flex flex-col gap-1 border-t-[0.5px] border-line pt-2">
    <p className="flex flex-wrap gap-x-3 font-medium"><span>{kinds[relation.kind]}</span><span>{statuses[relation.status]}</span></p>
    <p className="break-words text-muted">{source.evidence.title}，{source.evidence.locator}</p>
    <blockquote className="whitespace-pre-wrap break-words">{source.evidence.excerpt}</blockquote>
    {relation.condition === null ? null : <p className="whitespace-pre-wrap break-words">适用条件：{relation.condition}</p>}
    {relation.proposer === null ? null : <p className="break-all text-muted">{relation.proposer.kind === 'agent' ? '模型提出的关系推断' : '用户提出'}
      {' '}{relation.proposer.id}</p>}
    {relation.reviewer === null ? null : <p className="break-all text-muted">审核人 {relation.reviewer.id}，{relation.reviewedAt}</p>}
    {relation.decisionNote === null ? null : <p className="whitespace-pre-wrap break-words text-muted">审核说明：{relation.decisionNote}</p>}
    {relation.invalidatedReason === null ? null : <p className="text-[var(--st-warn)]">{reasons[relation.invalidatedReason]}</p>}
    <details data-reading-key={`relation-source:${relation.id}`} className="text-muted">
      <summary data-reading-key={`relation-source-summary:${relation.id}`} className="cursor-pointer">固定来源与版本</summary>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[length:var(--font-meta-size)]">
        <dt>证据</dt><dd className="break-all">{relation.evidenceId}</dd>
        <dt>来源版本</dt><dd className="break-all">{source.evidence.sourceVersion}</dd>
        <dt>主张版本</dt><dd>{relation.claimVersion}</dd>
        <dt>关系版本</dt><dd>{relation.version}</dd>
        <dt>来源校验</dt><dd className="break-all font-mono">{relation.sourceDigest}</dd>
        <dt>主张校验</dt><dd className="break-all font-mono">{relation.claimHash}</dd>
      </dl>
      {source.sourceLocator === null ? <p>没有托管文档坐标，保留原始定位文字。</p> : <pre
        className="mt-1 whitespace-pre-wrap break-all text-[length:var(--font-meta-size)]">{JSON.stringify(source.sourceLocator, null, 2)}</pre>}
      {source.sourceLocator === null ? null : <>
        <button type="button" className={`${button} mt-2`} aria-expanded={showDocument}
          data-testid={`artifact-relation-document-source-toggle-${relation.id}`}
          data-reading-key={`relation-document-source-toggle:${relation.id}`} onClick={() => setShowDocument(open => !open)}>
          {showDocument ? '收起关系原文固定版本' : '查看关系原文固定版本'}
        </button>
        {!showDocument ? null : <Suspense fallback={<p role="status">加载关系原文阅读器…</p>}>
          <DocumentSource client={client} evidence={source.evidence} locator={source.sourceLocator}/>
        </Suspense>}
      </>}
    </details>
    {relation.status !== 'proposed' ? null : canReview ? <div className="mt-1 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-muted">审核说明（可空）
        <textarea value={note} maxLength={10000} disabled={review.pending} onChange={event => setNote(event.target.value)}
          data-testid={`artifact-relation-note-${relation.id}`} className={`${inputClass} min-h-16 resize-y`}/>
      </label>
      <div className="flex flex-wrap gap-2">{(['confirm', 'reject'] as const).map(decision =>
        <button key={decision} type="button" className={button} disabled={review.pending}
          data-testid={`artifact-relation-${decision}-${relation.id}`} onClick={async () => {
            const outcome = await review.run(decision); if (outcome.ok) changed();
          }}>{decision === 'confirm' ? '确认此关系' : '拒绝此关系'}</button>)}</div>
      {review.pending ? <p role="status">正在保存审核…</p> : null}
      {review.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{review.error}</p>}
    </div> : <p className="text-muted">此工件或来源需要重新核对，当前不能审核。</p>}
    <button type="button" className={`${button} mt-1 self-start`} disabled={history.status === 'loading'}
      data-testid={`artifact-relation-history-${relation.id}`} onClick={() => setHistoryNonce(value => value + 1)}>
      {historyNonce === 0 ? '读取修订历史' : '重新读取修订历史'}</button>
    {history.status === 'loading' ? <p role="status">正在读取历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null ? null : <ol className="flex flex-col gap-1 text-muted">
      {history.data.map(revision => <li key={revision.relation.version} className="break-words">
        版本 {revision.relation.version}，{statuses[revision.relation.status]}，{revision.actor?.id ?? '未记录历史审核人'}，{revision.recordedAt}
      </li>)}
    </ol>}
  </article>;
}

function RelationProposal({client, snapshot, claim, onChanged}: {
  client: RocClient; snapshot: Snapshot; claim: ResearchClaim; onChanged: () => void
}): React.JSX.Element {
  const [evidenceId, setEvidenceId] = useState('');
  const [kind, setKind] = useState<'supports' | 'contradicts' | 'qualifies' | 'depends_on' | 'supersedes'>('supports');
  const [condition, setCondition] = useState('');
  const [previousId, setPreviousId] = useState('');
  const changed = useChangedAfterAction(onChanged);
  const source = useAsyncResource(evidenceId === '' ? null : `proposal-source:${snapshot.artifact.projectId}:${evidenceId}`,
    () => client.api.research.inspectEvidence({projectId: snapshot.artifact.projectId, evidenceId}), {label: '读取提议来源'});
  const proposal = useAsyncAction(() => {
    if (source.status !== 'ready' || source.data === null) throw new Error('research_relation_source_required');
    return client.api.research.proposeEvidenceRelation({projectId: snapshot.artifact.projectId, claimId: claim.id,
      expectedClaimVersion: claim.version, evidenceId, expectedSourceDigest: source.data.sourceDigest,
      kind, condition: condition.trim() === '' ? null : condition.trim(), supersedesRelationId: kind === 'supersedes' ? previousId : null});
  }, {label: '保存关系提议'});
  const valid = source.status === 'ready' && source.data !== null && source.data.source.evidence.id === evidenceId &&
    source.data.source.referenceStatus === 'recorded' && (kind !== 'qualifies' || condition.trim() !== '') &&
    (kind !== 'supersedes' || previousId !== '');
  return <details data-reading-key={`relation-proposal:${claim.id}`}>
    <summary data-reading-key={`relation-proposal-summary:${claim.id}`} className="cursor-pointer">新增关系提议</summary>
    <div className="mt-2 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-muted">证据来源
        <select className={inputClass} value={evidenceId} disabled={proposal.pending}
          data-testid={`artifact-relation-source-${claim.id}`} onChange={event => setEvidenceId(event.target.value)}>
          <option value="">选择已保存证据</option>
          {snapshot.evidence.map(item => <option key={item.evidence.id} value={item.evidence.id}>{item.evidence.title}
            {item.referenceStatus === 'superseded' ? '（旧来源已失效）' : ''}</option>)}
        </select>
      </label>
      {source.status === 'loading' ? <p role="status">正在读取固定来源…</p> : null}
      {source.error === null ? null : <div><p role="alert" className="text-[var(--st-warn)]">{source.error}</p>
        <button type="button" className={button} onClick={source.reload}>重读来源</button></div>}
      {source.status !== 'ready' || source.data === null || source.data.source.evidence.id !== evidenceId ? null : <>
        <p className="break-words text-muted">{source.data.source.evidence.locator}</p>
        <blockquote className="whitespace-pre-wrap break-words">{source.data.source.evidence.excerpt}</blockquote>
        {source.data.source.referenceStatus === 'recorded' ? null : <p role="alert" className="text-[var(--st-warn)]">此来源已失效，不能提议新关系。</p>}
      </>}
      <label className="flex flex-col gap-1 text-muted">关系类型
        <select value={kind} disabled={proposal.pending} className={inputClass}
          data-testid={`artifact-relation-kind-${claim.id}`} onChange={event => setKind(event.target.value as typeof kind)}>
          {(['supports', 'contradicts', 'qualifies', 'depends_on', 'supersedes'] as const).map(value => <option key={value} value={value}>{kinds[value]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-muted">{kind === 'qualifies' ? '适用条件（必填）' : '适用条件（可空）'}
        <textarea value={condition} maxLength={10000} disabled={proposal.pending} className={`${inputClass} min-h-16 resize-y`}
          data-testid={`artifact-relation-condition-${claim.id}`} onChange={event => setCondition(event.target.value)}/>
      </label>
      {kind !== 'supersedes' ? null : <label className="flex flex-col gap-1 text-muted">替代的旧关系
        <select value={previousId} disabled={proposal.pending} className={inputClass}
          data-testid={`artifact-relation-previous-${claim.id}`} onChange={event => setPreviousId(event.target.value)}>
          <option value="">选择旧关系</option>
          {snapshot.relations.filter(relation => relation.claimId === claim.id && relation.claimVersion === claim.version &&
            ['confirmed', 'historical'].includes(relation.status)).map(relation => <option key={relation.id} value={relation.id}>
            {kinds[relation.kind]}：{relation.source.evidence.title}</option>)}
        </select>
      </label>}
      <button type="button" className={`${button} self-start`} disabled={!valid || proposal.pending}
        data-testid={`artifact-relation-propose-${claim.id}`} onClick={async () => {
          const outcome = await proposal.run(); if (outcome.ok) changed();
        }}>保存提议，待人工审核</button>
      {proposal.pending ? <p role="status">正在保存提议…</p> : null}
      {proposal.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{proposal.error}</p>}
    </div>
  </details>;
}
