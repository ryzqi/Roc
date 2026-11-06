import {useEffect, useRef, useState} from 'react';
import type {TaskFactsSave} from '../../../shared/schemas/research-task-facts';
import {useAsyncAction, useAsyncResource} from '../../app/use-async-resource';
import {FormSection, formPrimaryButtonClass, formSecondaryButtonClass, formSelectClass, formTextAreaClass} from '../../shared/form-ui';
import type {RocClient} from '../../shared/roc-client';

type Fact = TaskFactsSave['entries'][number];
const kinds: Record<Fact['kind'], string> = {
  constraint: '已确认约束', source_version: '来源版本', human_decision: '人工决定', hypothesis: '未验证假设',
  todo: '待办', counterevidence: '反证', evaluation_condition: '评估条件', correction: '用户纠正'
};
const states = {active: '有效记录', resolved: '已完成', superseded: '已替代'};
const sourceLabels = {user: '用户', artifact: '工件', document: '文档', execution: '执行'};
const reasons: Record<string, string> = {
  artifact_version_changed: '工件版本已改变', document_source_changed: '文档来源已改变', document_parse_changed: '解析版本已改变',
  document_unlinked: '文档已取消项目关联', execution_unlinked: '执行关联已移除', execution_manifest_changed: '执行快照已改变', source_missing: '来源已删除'
};

export function TaskFactsPanel({client, projectId, taskId}: {client: RocClient; projectId: string; taskId: string}): React.JSX.Element {
  const resource = useAsyncResource(JSON.stringify(['task-facts', projectId, taskId]),
    () => client.api.research.getTaskFacts({projectId, taskId}), {label: '读取任务事实'});
  const action = useAsyncAction((request: TaskFactsSave) => client.api.research.saveTaskFacts(request), {label: '保存任务事实'});
  const [kind, setKind] = useState<Fact['kind']>('constraint');
  const [content, setContent] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useAsyncResource(historyOpen ? JSON.stringify(['task-facts-history', projectId, taskId]) : null,
    () => client.api.research.getTaskFactsHistory({projectId, taskId, beforeRevision: null, limit: 50}), {label: '读取事实历史'});
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const reload = resource.reload;
  useEffect(() => client.api.research.onTaskUpdated(event => {
    if (event.projectId === projectId && event.taskId === taskId) reload();
  }), [client, projectId, taskId, reload]);
  const entries = resource.data?.snapshot?.entries ?? [];
  const locked = action.pending || resource.status !== 'ready';
  const save = async (next: Fact[], clearDraft: boolean): Promise<void> => {
    const result = await action.run({projectId, taskId, expectedRevision: resource.data?.snapshot?.revision ?? 0, entries: next});
    if (!mounted.current) return;
    if (result.ok) {
      if (clearDraft) setContent('');
      resource.reload(); history.reload();
    }
  };
  return <FormSection title="任务事实" testId="mgmt-task-facts">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-subtle tabular-nums">版本 {resource.data?.snapshot?.revision ?? 0}</span>
      <button type="button" className={formSecondaryButtonClass} disabled={action.pending}
        data-testid="mgmt-task-facts-refresh" onClick={resource.reload}>刷新事实</button>
      <button type="button" className={formSecondaryButtonClass} aria-expanded={historyOpen}
        onClick={() => setHistoryOpen(value => !value)}>修订历史</button>
    </div>
    {resource.status === 'loading' ? <p role="status">读取事实中…</p> : null}
    {resource.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>}
    {action.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{action.error}</p>}
    {resource.status === 'ready' && entries.length === 0 ? <p className="text-subtle">尚无任务事实。</p> : null}
    <ol className="grid gap-3">
      {entries.map(entry => <li key={entry.id} className="grid gap-1 border-b border-line pb-2" data-testid="mgmt-task-fact">
        <div className="flex flex-wrap justify-between gap-2"><span>{kinds[entry.kind]}</span><span className="text-subtle">{states[entry.state]}</span></div>
        <p className="whitespace-pre-wrap break-words">{entry.content}</p>
        <ul className="grid gap-1 text-subtle text-[var(--font-meta-size)]" aria-label="事实出处">
          {entry.sources.map((source, index) => {
            const freshness = resource.data?.freshness.find(row => row.entryId === entry.id && row.sourceIndex === index);
            const locator = source.kind === 'user' ? source.locator : source.kind === 'artifact' ? `${source.artifactId} / ${source.version}`
              : source.kind === 'document' ? `${source.documentId} / ${source.sourceHash} / ${source.parseId ?? '未解析'}`
                : `${source.executionKind} / ${source.executionId} / ${source.manifestHash}`;
            return <li key={index} className="break-all">
              {sourceLabels[source.kind]} {locator}
              {freshness?.state === 'expired' ? <span className="ml-2 text-[var(--st-warn)]">出处已失效：{reasons[freshness.reason ?? ''] ?? freshness.reason}</span> : null}
            </li>;
          })}
        </ul>
        {entry.state !== 'active' ? null : <div className="flex flex-wrap gap-2">
          {(['resolved', 'superseded'] as const).map(state => <button key={state} type="button" className={formSecondaryButtonClass}
            disabled={locked || content.trim().length > 0} onClick={() => void save(entries.map(row => row.id === entry.id ? {...row, state} : row), false)}>
            {state === 'resolved' ? '标记完成' : '标记已替代'}
          </button>)}
        </div>}
      </li>)}
    </ol>
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      if (locked || content.trim().length === 0 || entries.length >= 100) return;
      void save([...entries, {id: crypto.randomUUID(), kind, content, state: 'active',
        sources: [{kind: 'user', locator: '用户在任务事实面板录入'}]}], true);
    }}>
      <label className="grid gap-1"><span className="text-subtle">记录类型</span>
        <select className={formSelectClass} value={kind} disabled={locked} data-testid="mgmt-task-fact-kind"
          onChange={event => setKind(event.target.value as Fact['kind'])}>
          {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="grid gap-1"><span className="text-subtle">事实内容</span>
        <textarea className={formTextAreaClass} value={content} disabled={locked} maxLength={2000} rows={3}
          data-testid="mgmt-task-fact-content" onChange={event => setContent(event.target.value)} />
      </label>
      <button type="submit" className={`${formPrimaryButtonClass} justify-self-start`} data-testid="mgmt-task-fact-save"
        disabled={locked || content.trim().length === 0 || entries.length >= 100}>{action.pending ? '保存中…' : '添加事实'}</button>
    </form>
    {historyOpen ? <div className="grid gap-2" data-testid="mgmt-task-facts-history">
      {history.error === null ? null : <p role="alert">{history.error}</p>}
      {history.status === 'loading' ? <p role="status">读取历史中…</p> : null}
      {history.data?.snapshots.map(snapshot => <details key={snapshot.revision}>
        <summary className="cursor-pointer text-subtle">版本 {snapshot.revision} / {snapshot.createdAt} / {snapshot.savedBy.id}</summary>
        <ul className="grid gap-1 pt-2">{snapshot.entries.map(entry => <li key={entry.id} className="whitespace-pre-wrap break-words">
          {kinds[entry.kind]} / {states[entry.state]}：{entry.content}
        </li>)}</ul>
      </details>)}
      {history.data?.hasMore ? <p className="text-subtle">展示最近 50 个修订。</p> : null}
    </div> : null}
  </FormSection>;
}
