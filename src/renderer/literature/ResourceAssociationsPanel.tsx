import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {ResourceSummary} from '../../shared/schemas/research-resources';
import type {ResourceTarget, ResourceAssociationSave, ResourceAssociationResult} from '../../shared/schemas/research-resource-associations';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import {useLiteratureEditor} from './literature-editor-guard';

const states: Record<ResourceAssociationResult['currentState'], string> = {
  current: '目标版本一致', target_changed: '目标版本已变化', target_unavailable: '目标已不可用'
};
const control = 'w-full min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink';
export default function ResourceAssociationsPanel({client, resource, writable, onLockChange}: {
  client: RocClient; resource: ResourceSummary; writable: boolean; onLockChange: (locked: boolean) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<ResourceTarget['kind']>('literature');
  const [targetOffset, setTargetOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [target, setTarget] = useState<{target: ResourceTarget; title: string} | null>(null);
  const [rationale, setRationale] = useState('');
  const [request, setRequest] = useState<ResourceAssociationSave | null>(null);
  const [saved, setSaved] = useState<ResourceAssociationResult | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false), fields = useRef({target: false, rationale: ''});
  const requestRef = useRef<ResourceAssociationSave | null>(null);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((input: ResourceAssociationSave) => client.api.research.associateResource(input), {label: '保存资源关联'});
  const targets = useAsyncResource(JSON.stringify([resource.projectId, kind, targetOffset]),
    () => client.api.research.getResourceTargets({projectId: resource.projectId, kind, offset: targetOffset, limit: 20}),
    {label: '读取可关联版本'});
  const history = useAsyncResource(JSON.stringify([resource.projectId, resource.id, historyOffset]),
    () => client.api.research.getResourceAssociationHistory({projectId: resource.projectId, resourceId: resource.id,
      target: null, offset: historyOffset, limit: 20}), {label: '读取资源关联'});
  const dirty = target !== null || rationale !== '' || request !== null;
  const editor = useLiteratureEditor({label: '资源关联', dirty: () => fields.current.target || fields.current.rationale !== '' || requestRef.current !== null,
    busy: () => submitting.current, discard: () => discard()});
  const reportLock = (): void => {
    onLockChange(submitting.current || fields.current.target || fields.current.rationale !== '' || requestRef.current !== null);
    editor.notify();
  };
  useLayoutEffect(() => {onLockChange(dirty || save.pending);}, [dirty, save.pending, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  const locked = save.pending || request !== null;
  const submit = async (input: ResourceAssociationSave): Promise<void> => {
    if (!writable || submitting.current || (requestRef.current !== null && requestRef.current !== input)) return;
    submitting.current = true; requestRef.current = input; reportLock();
    setRequest(input); setSaved(null);
    try {
      const result = await save.run(input);
      if (!mounted.current || !result.ok) return;
      requestRef.current = null; fields.current = {target: false, rationale: ''};
      setSaved(result.data); setRequest(null); setTarget(null); setRationale(''); setHistoryOffset(0); history.reload();
    } finally {
      submitting.current = false;
      if (mounted.current) reportLock();
    }
  };
  const discard = (): void => {
    requestRef.current = null; fields.current = {target: false, rationale: ''}; reportLock();
    setTarget(null); setRationale(''); setRequest(null); save.reset(); history.reload(); targets.reload();
  };
  const nextTarget = targets.data?.nextOffset ?? null, nextHistory = history.data?.nextOffset ?? null;
  return <section aria-label="资源版本关联" className="space-y-2 border-t-[0.5px] border-line pt-3" data-testid="reader-resource-associations">
    <h3 className="font-medium">资源版本关联</h3>
    <p className="text-muted">人工声明资源与目标相关；不证明实际下载或使用了哪些字节。</p>
    {!writable ? <p role="status">项目只读，保存历史仍可查看</p> : null}
    {resource.status !== 'ok' ? <p>失败观察不能关联到论文或实验</p> : <>
      <fieldset disabled={!writable || locked} className="space-y-2">
        <label className="block">目标类型
          <select className={control} value={kind} onChange={event => {
            if (!writable || submitting.current || requestRef.current !== null) return;
            fields.current.target = false; reportLock();
            setKind(event.target.value as ResourceTarget['kind']); setTargetOffset(0); setTarget(null); setSaved(null);
          }}><option value="literature">论文</option><option value="experiment">已完成的托管实验</option></select>
        </label>
        {targets.status === 'loading' ? <p role="status">读取目标版本中</p> : null}
        {targets.error === null ? null : <div role="alert"><p>{targets.error}</p>
          <button type="button" className={scholarlyButton} onClick={targets.reload}>重试目标</button></div>}
        <label className="block">目标版本
          <select className={control} value={target === null ? '' : JSON.stringify(target.target)}
            disabled={targets.status !== 'ready' || targets.data === null} onChange={event => {
            if (!writable || submitting.current || requestRef.current !== null || targets.data === null) return;
            const choice = targets.data.records.find(record => JSON.stringify(record.target) === event.target.value);
            fields.current.target = choice !== undefined; reportLock();
            setTarget(choice === undefined ? null : choice); setSaved(null);
          }}>
            <option value="">选择当前项目的具体版本</option>
            {targets.data?.records.map(record => <option key={JSON.stringify(record.target)} value={JSON.stringify(record.target)}>
              {record.title} {record.target.kind === 'literature' ? `论文版本 ${record.target.expectedRevision}` : record.target.runId}
            </option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={targetOffset === 0 || target !== null}
            onClick={() => setTargetOffset(value => Math.max(0, value - 20))}>目标上一页</button>
          <button type="button" className={scholarlyButton} disabled={nextTarget === null || target !== null}
            onClick={() => setTargetOffset(nextTarget!)}>目标下一页</button>
          <button type="button" className={scholarlyButton} disabled={target !== null} onClick={targets.reload}>刷新目标</button>
        </div>
        <label className="block">关联依据
          <textarea className={control} rows={3} maxLength={8192} value={rationale} onChange={event => {
            if (!writable || submitting.current || requestRef.current !== null) return;
            fields.current.rationale = event.target.value; reportLock();
            setRationale(event.target.value); setSaved(null);
          }}/>
        </label>
        {target === null ? null : <details><summary className="cursor-pointer text-muted">将绑定的版本身份</summary>
          <pre className="whitespace-pre-wrap break-all text-muted text-[length:var(--font-meta-size)]">{JSON.stringify(target.target, null, 2)}</pre></details>}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={scholarlyButton} disabled={!writable || locked || target === null || rationale.trim() === ''}
          onClick={() => void submit({projectId: resource.projectId, requestId: crypto.randomUUID(), resourceId: resource.id,
            resourceHash: resource.contentHash, target: target!.target, rationale})}>{save.pending ? '保存关联中' : '保存人工关联'}</button>
        {request === null || save.pending ? null : <button type="button" className={scholarlyButton} disabled={!writable}
          onClick={() => void submit(request)}>重试原关联请求</button>}
        {dirty ? <button type="button" className={scholarlyButton} disabled={save.pending}
          onClick={() => editor.request(discard, '尚未保存的目标版本、关联依据和原请求将被放弃。')}>放弃关联草稿并刷新</button> : null}
      </div>
    </>}
    {dirty ? <p role="status" className="text-muted">关联草稿未确认，暂不能切换资源</p> : null}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-bad)]">{save.error}</p>}
    {saved === null ? null : <p role="status">关联已保存：{states[saved.currentState]}</p>}
    <details open data-testid="reader-resource-association-history">
      <summary className="cursor-pointer text-muted">关联历史{history.data === null ? '' : `（${history.data.total}）`}</summary>
      {history.status === 'loading' ? <p role="status">读取关联历史中</p> : null}
      {history.error === null ? null : <div role="alert"><p>{history.error}</p>
        <button type="button" className={scholarlyButton} onClick={history.reload}>重试关联历史</button></div>}
      {history.data === null ? null : <>
        {history.data.records.length === 0 ? <p className="text-muted">尚无人工关联</p> :
          <ul className="space-y-2 py-1">{history.data.records.map(record => <li key={record.association.id} className="border-b-[0.5px] border-line pb-2">
            <p className="break-words">{record.association.targetTitle}</p>
            <p className="text-muted">{states[record.currentState]}</p>
            <p className="whitespace-pre-wrap break-words">{record.association.request.rationale}</p>
            <p className="break-words text-muted">{record.association.actor.id} {record.association.createdAt}</p>
            <details><summary className="cursor-pointer text-muted">保存的关联身份</summary>
              <pre className="whitespace-pre-wrap break-all text-muted text-[length:var(--font-meta-size)]">{JSON.stringify(record.association, null, 2)}</pre>
            </details>
          </li>)}</ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={scholarlyButton} disabled={save.pending || historyOffset === 0}
            onClick={() => setHistoryOffset(value => Math.max(0, value - 20))}>关联历史上一页</button>
          <button type="button" className={scholarlyButton} disabled={save.pending || nextHistory === null}
            onClick={() => setHistoryOffset(nextHistory!)}>关联历史下一页</button>
          <button type="button" className={scholarlyButton} disabled={save.pending} onClick={history.reload}>刷新关联历史</button>
        </div>
      </>}
    </details>
  </section>;
}
