import {useRef, useState} from 'react';
import type {ResearchReviewCorpusInspection} from '../../shared/schemas/research-review-corpus';
import type {ResearchReviewDuplicateInspection, ResearchReviewDuplicateSave} from '../../shared/schemas/research-review-deduplication';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';

const input = `${formInputClass} border-[0.5px]`;
const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewDuplicateEditor({client, corpus, leftHitId, rightHitId, parent, writable, onPending, onSaved}: {
  client: RocClient; corpus: ResearchReviewCorpusInspection; leftHitId: string; rightHitId: string;
  parent: ResearchReviewDuplicateInspection | null; writable: boolean; onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const projectId = corpus.snapshot.request.projectId, corpusId = corpus.snapshot.id;
  const left = useAsyncResource(`review:dedup-left:${corpus.snapshotHash}:${leftHitId}`,
    () => client.api.research.getReviewCorpusHit({projectId, corpusId, hitId: leftHitId}), {label: '读取记录 A'});
  const right = useAsyncResource(`review:dedup-right:${corpus.snapshotHash}:${rightHitId}`,
    () => client.api.research.getReviewCorpusHit({projectId, corpusId, hitId: rightHitId}), {label: '读取记录 B'});
  const history = useAsyncResource(parent === null ? null : `review:duplicate-history:${corpus.snapshotHash}:${parent.snapshot.id}`,
    () => {
      if (parent === null) throw new Error('research_review_duplicate_required');
      return client.api.research.getReviewDuplicateDecisionHistory({projectId, corpusId, decisionId: parent.snapshot.id});
    }, {label: '读取成对决定历史'});
  const [editing, setEditing] = useState(parent === null);
  const [decision, setDecision] = useState<ResearchReviewDuplicateSave['decision'] | ''>(parent?.snapshot.request.decision ?? '');
  const [ruleName, setRuleName] = useState(parent?.snapshot.request.rule.name ?? '');
  const [ruleVersion, setRuleVersion] = useState(parent?.snapshot.request.rule.version ?? '');
  const [reason, setReason] = useState(parent?.snapshot.request.reason ?? '');
  const [revisionReason, setRevisionReason] = useState('');
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const save = useAsyncAction((request: ResearchReviewDuplicateSave) => client.api.research.saveReviewDuplicateDecision(request), {label: '保存人工去重决定'});
  const ready = left.status === 'ready' && right.status === 'ready';
  const canEdit = writable && corpus.currentProtocol && editing;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-duplicate-editor">
    <h3 className="font-medium">成对核查</h3>
    {([['记录 A', left], ['记录 B', right]] as const).map(([label, resource]) => <section key={label} className="flex flex-col gap-1">
      <h4 className="font-medium">{label}</h4>
      {resource.status !== 'loading' ? null : <p role="status">正在读取{label}…</p>}
      {resource.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{resource.error}</p>}
      {resource.status !== 'ready' ? null : <>
        <p className="break-words">{resource.data!.record.record.title}</p>
        <p className="text-muted break-words">{resource.data!.record.record.doi ?? 'DOI 未提供'}</p>
        <p className="text-muted">数据库 {resource.data!.source.databaseIndex + 1} 检索式 {resource.data!.source.queryIndex + 1}
          原始记录 {resource.data!.reference.recordIndex + 1}</p>
      </>}
    </section>)}
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-duplicate-current">
      <p>最新决定：{parent.snapshot.request.decision === 'duplicate' ? '同一报告' : '不同报告，均保留'} 版本 {parent.snapshot.version}</p>
      {parent.snapshot.request.decision !== 'duplicate' ? null : <p className="text-muted">
        移除原始记录 {parent.snapshot.left.hit.recordIndex + 1}（检索式 {parent.snapshot.left.source.queryIndex + 1}），
        保留原始记录 {parent.snapshot.right.hit.recordIndex + 1}（检索式 {parent.snapshot.right.source.queryIndex + 1}）
      </p>}
      <p className="break-words">{parent.snapshot.request.reason}</p>
      <p className="text-muted break-words">规则 {parent.snapshot.request.rule.name} 版本 {parent.snapshot.request.rule.version}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`} data-testid="artifact-review-duplicate-revise"
        onClick={() => setEditing(true)}>修订此决定</button>}
    </section>}
    {!editing || !writable ? null : <form className="flex flex-col gap-2" onSubmit={event => {
      event.preventDefault();
      if (!canEdit || !ready || busy.current || decision === '' || leftHitId === rightHitId) return;
      const body = {projectId, corpusId, expectedCorpusHash: corpus.snapshotHash, leftHitId, rightHitId, decision,
        rule: {name: ruleName, version: ruleVersion}, reason, parentDecisionId: parent?.snapshot.id ?? null,
        expectedParentHash: parent?.snapshotHash ?? null, revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {busy.current = false; onPending(false); if (result.ok) onSaved();});
    }}>
      <fieldset disabled={!canEdit || !ready || save.pending} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-muted">去重决定
          <select required aria-label="去重决定" className={input} value={decision}
            onChange={event => setDecision(event.target.value as typeof decision)}>
            <option value="">选择人工决定</option>
            <option value="duplicate">同一报告，移除 A，保留 B</option>
            <option value="distinct">不同报告，均保留</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted">去重规则
          <input required maxLength={300} className={input} value={ruleName} onChange={event => setRuleName(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-muted">规则版本
          <input required maxLength={300} className={input} value={ruleVersion} onChange={event => setRuleVersion(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-muted">核查理由
          <textarea aria-label="核查理由" required maxLength={10000} rows={3} value={reason}
            className={`${input} h-auto resize-y py-1`} onChange={event => setReason(event.target.value)} />
        </label>
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">决定修订原因
          <textarea aria-label="决定修订原因" required maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
            value={revisionReason} onChange={event => setRevisionReason(event.target.value)} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={leftHitId === rightHitId || decision === ''} data-testid="artifact-review-duplicate-save">保存人工决定</button>
      </fieldset>
    </form>}
    {leftHitId !== rightHitId ? null : <p role="alert" className="text-[var(--st-warn)]">请选择两个不同的原始命中。</p>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-duplicate-history">
      <summary className="cursor-pointer text-muted">决定修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="break-words text-muted">
        版本 {item.snapshot.version} {item.snapshot.request.decision === 'duplicate' ? '同一报告' : '不同报告'} {item.snapshot.request.reason}
        <p>{item.snapshot.request.revisionReason}</p><p>记录人 {item.snapshot.actor.id} {item.snapshot.recordedAt}</p>
      </li>)}</ul>
    </details>}
  </section>;
}
