import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewDeduplicationFreeze} from '../../shared/schemas/research-review-deduplication';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewCorpusRecords} from './ReviewCorpusRecords';
import {ReviewDuplicateEditor} from './ReviewDuplicateEditor';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewDedupInspector({client, projectId, corpusId, writable, onPending}: {
  client: RocClient; projectId: string; corpusId: string; writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const corpusRead = useAsyncResource(`review:corpus:${projectId}:${corpusId}`,
    () => client.api.research.getReviewCorpus({projectId, corpusId}), {label: '读取准确固定语料'});
  const dedupRead = useAsyncResource(`review:dedup:${projectId}:${corpusId}`,
    () => client.api.research.getReviewDeduplication({projectId, corpusId}), {label: '读取人工去重权威'});
  const corpus = corpusRead.status === 'ready' ? corpusRead.data : null;
  const dedup = dedupRead.status === 'ready' ? dedupRead.data : null;
  const [leftHitId, setLeftHitId] = useState<string | null>(null), [rightHitId, setRightHitId] = useState<string | null>(null);
  const pairFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (leftHitId === null || rightHitId === null) return;
    pairFocus.current?.scrollIntoView({block: 'start', behavior: 'instant'});
    pairFocus.current?.focus();
  }, [leftHitId, rightHitId]);
  const [reviewNote, setReviewNote] = useState('');
  const [pairPending, setPairPending] = useState(false);
  const freeze = useAsyncAction((request: ResearchReviewDeduplicationFreeze) => client.api.research.freezeReviewDeduplication(request), {label: '冻结人工去重结果'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const pending = pairPending || freeze.pending;
  const editable = writable && corpus?.currentProtocol === true && dedup?.currentProtocol === true && dedup.freeze === null;
  const parent = dedup?.decisions.find(item => {
    const request = item.snapshot.request;
    return (request.leftHitId === leftHitId && request.rightHitId === rightHitId) ||
      (request.rightHitId === leftHitId && request.leftHitId === rightHitId);
  }) ?? null;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-dedup">
    <h2 className="font-medium">固定语料核查与人工去重</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || corpusRead.status === 'loading' || dedupRead.status === 'loading'}
      data-testid="artifact-review-dedup-refresh" onClick={() => {corpusRead.reload(); dedupRead.reload();}}>重读语料与去重决定</button>
    {corpusRead.status !== 'loading' && dedupRead.status !== 'loading' ? null : <p role="status">正在读取固定语料与人工决定…</p>}
    {[corpusRead.error, dedupRead.error].map((error, index) => error === null ? null :
      <p key={index} role="alert" className="text-[var(--st-warn)] break-words">{error}</p>)}
    {corpus === null || dedup === null ? null : <>
      <p className="text-muted">原始记录 {corpus.identifiedRecords} 条 {corpus.currentProtocol ? '当前协议' : '历史协议'}</p>
      <ReviewCorpusRecords key={corpus.snapshotHash} client={client} corpus={corpus} disabled={pending}
        onSelect={(side, id) => {if (side === 'left') setLeftHitId(id); else setRightHitId(id);}} />
      <div className="grid grid-cols-2 gap-2">
        {([['left', '记录 A', leftHitId], ['right', '记录 B', rightHitId]] as const).map(([side, label, value]) =>
          <label key={side} className="flex min-w-0 flex-col gap-1 text-muted">{label}
            <select aria-label={label} className={`${formInputClass} border-[0.5px]`} disabled={pending} value={value ?? ''} onChange={event => {
              const id = event.target.value === '' ? null : event.target.value;
              if (side === 'left') setLeftHitId(id); else setRightHitId(id);
            }}>
              <option value="">选择原始记录</option>
              {corpus.snapshot.hits.map((hit, index) => <option key={hit.id} value={hit.id}>原始命中 {index + 1} 查询记录 {hit.recordIndex + 1}</option>)}
            </select>
          </label>)}
      </div>
      {leftHitId === null || rightHitId === null ? <p className="text-muted">选择两个原始命中核对报告身份。</p> :
        <div ref={pairFocus} tabIndex={-1} aria-label="成对核查" data-testid="artifact-review-pair-focus">
        <ReviewDuplicateEditor key={`pair:${leftHitId}:${rightHitId}:${parent?.snapshotHash ?? 'new'}`} client={client} corpus={corpus}
          leftHitId={leftHitId} rightHitId={rightHitId} parent={parent} writable={editable && !freeze.pending}
          onPending={value => {setPairPending(value); onPending(value);}} onSaved={dedupRead.reload} /></div>}
      <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-duplicate-decisions">
        <h3 className="font-medium">当前成对决定 {dedup.decisions.length} 项</h3>
        <ul className="flex flex-col gap-2">{dedup.decisions.map(item => <li key={item.snapshot.id}>
          <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending}
            data-testid="artifact-review-duplicate-select" onClick={() => {
              setLeftHitId(item.snapshot.request.leftHitId); setRightHitId(item.snapshot.request.rightHitId);
            }}>版本 {item.snapshot.version} {item.snapshot.request.decision === 'duplicate' ? '同一报告' : '不同报告'} {item.snapshot.request.reason}</button>
        </li>)}</ul>
      </section>
      {dedup.freeze === null ? !editable ? null : <form className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" onSubmit={event => {
        event.preventDefault();
        if (busy.current || !editable) return;
        const body = {projectId, corpusId, expectedCorpusHash: corpus.snapshotHash,
          decisions: dedup.decisions.map(item => ({decisionId: item.snapshot.id, expectedHash: item.snapshotHash})), reviewNote};
        const signature = JSON.stringify(body);
        let requestId = requests.current.get(signature);
        if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
        busy.current = true; onPending(true);
        void freeze.run({...body, requestId}).then(result => {busy.current = false; onPending(false); if (result.ok) dedupRead.reload();});
      }}>
        <label className="flex flex-col gap-1 text-muted">整轮去重审核说明
          <textarea required aria-label="整轮去重审核说明" maxLength={10000} rows={3} value={reviewNote} disabled={pending}
            className={`${formInputClass} border-[0.5px] h-auto py-1 resize-y`} onChange={event => {setReviewNote(event.target.value); freeze.reset();}} />
        </label>
        <p className="text-muted">冻结使用当前全部 {dedup.decisions.length} 项决定；未声明重复的原始命中保留用于筛选。</p>
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={pending || reviewNote.trim() === ''}
          data-testid="artifact-review-dedup-freeze">确认并冻结去重结果</button>
      </form> : <section className="flex flex-col gap-1" data-testid="artifact-review-dedup-frozen">
        <h3 className="font-medium">去重已冻结</h3>
        <p>原始记录 {dedup.freeze.identifiedRecords} = 重复移除 {dedup.freeze.removedDuplicates} + 待筛选 {dedup.freeze.recordsToScreen}</p>
        <p className="text-muted break-all">审核人 {dedup.freeze.actor.id} {dedup.freeze.frozenAt}</p>
        <p className="break-words">{dedup.freeze.request.reviewNote}</p>
      </section>}
    </>}
    {freeze.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{freeze.error}</p>}
  </section>;
}
