import { useVisiblePolling } from '../shared/view-activity';
import {useEffect, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import type {ResearchWikiSnapshot} from '../../shared/schemas/research-wiki';
import type {WikiPage, WikiSection} from '../../shared/schemas/research-wiki-pages';

const button = 'rounded-control border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50 focus-visible:outline focus-visible:outline-2';
const field = 'w-full min-w-0 rounded-control border border-line bg-transparent p-2 text-sm focus-visible:outline focus-visible:outline-2';
const kinds = {source: '来源摘录', topic: '主题', comparison: '比较', dispute: '争议'};
const jobs = {queued: '排队中', running: '编译中', ready: '已编译', failed: '编译失败'};
const reasons = {compile: '来源编译', human: '人工编辑', assistant: '助手草稿', rollback: '历史恢复'};
type Props = {client: RocClient; projectId: string; snapshot?: ResearchWikiSnapshot; writable: boolean;
  onAskAssistant?: (prompt: string) => void; onLock: (locked: boolean) => void};

export function WikiPages({client, projectId, snapshot, writable, onAskAssistant, onLock}: Props): React.JSX.Element {
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState(false);
  const pages = useAsyncResource(`wiki-pages:${projectId}:${query}:${offset}`,
    () => client.api.research.searchWiki({projectId, query, offset}), {label: '读取 Wiki 页面'});
  const locked = creating || editing;
  useEffect(() => {onLock(locked); return () => onLock(false);}, [locked, onLock]);
  useVisiblePolling(pages.reload, 3000);
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="wiki-pages">
    <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
      <input aria-label="搜索持久页面" className={`${field} flex-1`} value={query} disabled={locked}
        onChange={event => {setQuery(event.target.value); setOffset(0);}} placeholder="搜索页面标题与正文"/>
      <button className={button} disabled={locked || !writable} onClick={() => setCreating(true)}>新建主题页</button>
      <button className={button} onClick={pages.reload}>刷新列表</button>
    </div>
    <p className="px-3 py-2 text-xs text-subtle">捕获证据后自动生成来源摘录；主题综合为草稿，科学支持仍以原始关系的人工审核为准。</p>
    {pages.error && <p role="alert" className="p-3">{pages.error}</p>}
    <div className="flex min-h-0 flex-1 flex-wrap overflow-auto">
      <aside className="w-52 shrink-0 border-r border-line p-2" aria-label="持久页面列表">
        {pages.data?.length === 0 && <p className="p-2 text-xs text-subtle">暂无页面。先在检索或阅读中捕获原始证据。</p>}
        {pages.data?.map(page => <button key={page.id} disabled={locked} aria-current={selected === page.id ? 'page' : undefined}
          data-testid="wiki-page-row" className="mb-1 block w-full rounded-control p-2 text-left hover:bg-hover aria-[current=page]:bg-hover disabled:opacity-50"
          onClick={() => setSelected(page.id)}>
          <span className="block break-words text-sm">{page.title}</span>
          <span className="text-xs text-subtle">{kinds[page.kind]} · r{page.revision} · {page.job ? jobs[page.job.status] : '待编译'}</span>
        </button>)}
        <div className="flex flex-wrap gap-2 py-2"><button className={button} disabled={locked || offset === 0}
          onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</button>
          <button className={button} disabled={locked || pages.data?.length !== 50} onClick={() => setOffset(value => value + 50)}>下一页</button></div>
      </aside>
      <div className="min-w-0 flex-1 basis-72 p-3">
        {creating ? <CreatePage client={client} projectId={projectId} snapshot={snapshot}
          onClose={() => setCreating(false)} onCreated={id => {setSelected(id); setCreating(false); pages.reload();}}/> :
          selected === null ? <p className="text-sm text-subtle">选择页面查看草稿、来源与修订记录。</p> :
          <PageDetail key={selected} client={client} projectId={projectId} pageId={selected} writable={writable}
            onAskAssistant={onAskAssistant} onEditing={setEditing} onNavigate={setSelected} onChanged={pages.reload}/>}
      </div>
    </div>
  </div>;
}

function CreatePage({client, projectId, snapshot, onClose, onCreated}: Pick<Props, 'client' | 'projectId' | 'snapshot'> & {
  onClose: () => void; onCreated: (id: string) => void}): React.JSX.Element {
  const [title, setTitle] = useState(''), [kind, setKind] = useState<'topic' | 'comparison' | 'dispute'>('topic');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]), [claimIds, setClaimIds] = useState<string[]>([]);
  const [filter, setFilter] = useState(''), [offset, setOffset] = useState(0);
  const create = useAsyncAction(() => client.api.research.createWiki({projectId, title, kind, evidenceIds, claimIds}), {label: '创建 Wiki 页'});
  const choices = (snapshot?.sources ?? []).filter(source => source.referenceStatus === 'recorded' &&
    `${source.evidence.title}\n${source.evidence.excerpt}`.toLowerCase().includes(filter.toLowerCase()));
  return <form className="space-y-3" data-testid="wiki-create" onSubmit={event => {event.preventDefault();
    void create.run().then(result => {if (result.ok) onCreated(result.data.page.id);});}}>
    <h3 className="text-sm font-medium">新建持久主题页</h3>
    <label className="block text-xs">标题<input aria-label="页面标题" className={field} value={title} maxLength={300} required onChange={event => setTitle(event.target.value)}/></label>
    <label className="block text-xs">页面类型<select aria-label="页面类型" className={field} value={kind}
      onChange={event => setKind(event.target.value as typeof kind)}><option value="topic">主题</option><option value="comparison">比较</option><option value="dispute">争议</option></select></label>
    <label className="block text-xs">选择原始证据（最多 50 条）<input aria-label="筛选原始证据" className={field} value={filter}
      onChange={event => {setFilter(event.target.value); setOffset(0);}}/></label>
    <div className="max-h-52 overflow-auto rounded-control border border-line p-2">
      {choices.slice(offset, offset + 20).map(source => <label key={source.evidence.id} className="flex items-start gap-2 py-1 text-xs">
        <input type="checkbox" checked={evidenceIds.includes(source.evidence.id)} disabled={!evidenceIds.includes(source.evidence.id) && evidenceIds.length >= 50}
          onChange={event => setEvidenceIds(ids => event.target.checked ? [...ids, source.evidence.id] : ids.filter(id => id !== source.evidence.id))}/>
        <span className="break-words">{source.evidence.title} · {source.evidence.locator}<span className="block text-subtle">{source.evidence.excerpt.slice(0, 160)}</span></span>
      </label>)}
      {choices.length === 0 && <p className="text-xs">没有符合条件的有效证据。</p>}
    </div>
    <div className="flex gap-2 text-xs"><span>已选 {evidenceIds.length} 条</span><button type="button" className={button} disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 20))}>前 20 条</button>
      <button type="button" className={button} disabled={offset + 20 >= choices.length} onClick={() => setOffset(v => v + 20)}>后 20 条</button></div>
    <details><summary className="cursor-pointer text-xs">关联主张（可选）</summary>
      {(snapshot?.claims ?? []).filter(claim => claim.evidenceIds.some(id => evidenceIds.includes(id))).slice(0, 50).map(claim =>
        <label key={claim.id} className="flex items-start gap-2 py-1 text-xs"><input type="checkbox" checked={claimIds.includes(claim.id)}
          onChange={event => setClaimIds(ids => event.target.checked ? [...ids, claim.id] : ids.filter(id => id !== claim.id))}/><span>{claim.content.slice(0, 200)}</span></label>)}
    </details>
    {create.error && <p role="alert">{create.error}</p>}
    <div className="flex gap-2"><button type="submit" className={button} disabled={create.pending || title.trim() === '' || evidenceIds.length + claimIds.length === 0}>创建草稿</button>
      <button type="button" className={button} disabled={create.pending} onClick={onClose}>取消</button></div>
  </form>;
}

function PageDetail({client, projectId, pageId, writable, onAskAssistant, onEditing, onNavigate, onChanged}: Omit<Props, 'snapshot' | 'onLock'> & {
  pageId: string; onEditing: (value: boolean) => void; onNavigate: (id: string) => void; onChanged: () => void}): React.JSX.Element {
  const page = useAsyncResource(`wiki-page:${projectId}:${pageId}`, () => client.api.research.readWiki({projectId, pageId}), {label: '读取 Wiki 草稿'});
  const [edit, setEdit] = useState<{section: WikiSection; page: WikiPage} | null>(null), [sectionOffset, setSectionOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const compile = useAsyncAction((expectedRevision: number) => client.api.research.compileWiki({projectId, pageId, expectedRevision}), {label: '重新编译 Wiki'});
  useEffect(() => {onEditing(edit !== null); return () => onEditing(false);}, [edit, onEditing]);
  useVisiblePolling(page.reload, 3000, edit === null);
  const data = page.data;
  if (data === null) return <div><p role={page.error ? 'alert' : 'status'}>{page.error ?? '正在读取页面…'}</p><button className={button} onClick={page.reload}>重试读取</button></div>;
  return <article className="space-y-3" data-testid="wiki-page-detail">
    <h2 className="break-words text-base font-medium">{data.page.title}</h2>
    <p className="text-xs text-subtle">{kinds[data.page.kind]} · 草稿 r{data.page.revision} · {data.page.job ? jobs[data.page.job.status] : '待编译'} · {data.current ? reasons[data.current.reason] : ''}</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={edit !== null} onClick={page.reload}>刷新页面</button>
      <button className={button} disabled={!writable || edit !== null || compile.pending || ['running', 'queued'].includes(data.page.job?.status ?? '')}
        onClick={() => {void compile.run(data.page.revision).then(result => {if (result.ok) {page.reload(); onChanged();}});}}>重新编译</button>
      <button className={button} disabled={edit !== null} aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>修订历史</button>
      {onAskAssistant && <button className={button} disabled={edit !== null} onClick={() => onAskAssistant(
        `请用 research_wiki_read 读取当前项目的 Wiki 页面 ${pageId}（${data.page.title}），核对 lint 与原始证据后综合主题草稿。每个事实注明原始 evidenceId；过期依据先回原文检索。可用 research_wiki_draft 保存生成章节，保留人工章节，不确认科学支持。`)}>交给助手综合</button>}
    </div>
    {(page.error || compile.error || data.page.job?.error) && <p role="alert">{page.error ?? compile.error ?? data.page.job?.error}</p>}
    {historyOpen && <History key={data.page.revision} client={client} projectId={projectId} pageId={pageId} currentRevision={data.page.revision}
      writable={writable && edit === null} onChanged={() => {page.reload(); onChanged();}}/>}
    <details open data-testid="wiki-page-lint"><summary className="cursor-pointer text-sm">页面检查 · {data.lint.length} 项</summary>
      <p className="text-xs text-subtle">检查依赖和引用结构，不代表语义或科学支持审核。</p>
      <ul className="max-h-40 overflow-auto text-xs">{data.lint.map((issue, index) => <li key={index} className="break-words py-1">{issue.message}</li>)}</ul>
    </details>
    {edit !== null ? <SectionEditor client={client} projectId={projectId} data={edit.page} section={edit.section}
      onClose={() => setEdit(null)} onSaved={() => {setEdit(null); page.reload(); onChanged();}}/> :
      <div>{data.current?.sections.slice(sectionOffset, sectionOffset + 10).map(section => <section key={section.id} className="space-y-2 border-t border-line py-3">
        <div className="flex items-start justify-between gap-2"><h3 className="break-words text-sm font-medium">{section.title}</h3>
          <button className={`${button} shrink-0`} disabled={!writable} onClick={() => setEdit({section, page: data})}>编辑章节</button></div>
        <p className="text-xs text-subtle">{section.owner === 'human' ? '人工维护 · 自动编译保留' : '生成草稿 · 待核查'}</p>
        <p className="whitespace-pre-wrap break-words text-sm" data-testid="wiki-section-body">{section.body}</p>
        {section.evidenceIds.map(id => {const source = data.sources.find(item => item.evidenceId === id); return <details key={id}>
          <summary className="cursor-pointer break-words text-xs">原始证据：{source?.title ?? id} · {source?.status === 'recorded' ? '已记录来源' : '失效或缺失'}</summary>
          <p className="break-all text-xs text-subtle">{id} · {source?.locator}</p>
          <blockquote className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-l border-line pl-3 text-xs">{source?.excerpt ?? '此证据已不可读取，请核对来源。'}</blockquote>
        </details>;})}
        <div className="flex flex-wrap gap-2">{section.links.map(id => <button key={id} className={button} onClick={() => onNavigate(id)}>
          {data.links.find(link => link.id === id)?.title ?? '链接已缺失'}</button>)}</div>
      </section>)}</div>}
    {edit === null && (data.current?.sections.length ?? 0) > 10 && <div className="flex gap-2"><button className={button} disabled={sectionOffset === 0} onClick={() => setSectionOffset(v => Math.max(0, v - 10))}>前 10 节</button>
      <button className={button} disabled={sectionOffset + 10 >= (data.current?.sections.length ?? 0)} onClick={() => setSectionOffset(v => v + 10)}>后 10 节</button></div>}
  </article>;
}

function SectionEditor({client, projectId, data, section, onClose, onSaved}: {
  client: RocClient; projectId: string; data: WikiPage; section: WikiSection; onClose: () => void; onSaved: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(section.title), [body, setBody] = useState(section.body);
  const save = useAsyncAction(() => client.api.research.saveWiki({projectId, pageId: data.page.id, expectedRevision: data.page.revision,
    expectedBasisDigest: data.basisDigest, section: {id: section.id, title, body, evidenceIds: section.evidenceIds,
      claimIds: section.claimIds, links: section.links}}), {label: '保存人工章节'});
  return <form className="space-y-3" data-testid="wiki-section-editor" onSubmit={event => {event.preventDefault(); void save.run().then(result => {if (result.ok) onSaved();});}}>
    <p className="text-xs">保存后此章节由人工维护；保留本次原始依据，不会批准科学支持。</p>
    <label className="block text-xs">章节标题<input aria-label="章节标题" className={field} value={title} maxLength={300} required onChange={event => setTitle(event.target.value)}/></label>
    <label className="block text-xs">章节正文<textarea aria-label="章节正文" className={`${field} min-h-48`} value={body} maxLength={6000} required onChange={event => setBody(event.target.value)}/></label>
    {save.error && <p role="alert">{save.error}</p>}
    <div className="flex gap-2"><button className={button} disabled={save.pending || !body.trim() || !title.trim()}>保存人工章节</button>
      <button type="button" className={button} disabled={save.pending} onClick={onClose}>取消编辑</button></div>
  </form>;
}

function History({client, projectId, pageId, currentRevision, writable, onChanged}: {
  client: RocClient; projectId: string; pageId: string; currentRevision: number; writable: boolean; onChanged: () => void
}): React.JSX.Element {
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<number | null>(null);
  const history = useAsyncResource(`wiki-history:${pageId}:${offset}`, () => client.api.research.wikiHistory({projectId, pageId, offset}), {label: '读取修订历史'});
  const old = useAsyncResource(selected === null ? null : `wiki-revision:${pageId}:${selected}`,
    () => client.api.research.wikiRevision({projectId, pageId, revision: selected!}), {label: '读取历史修订'});
  const rollback = useAsyncAction(() => client.api.research.rollbackWiki({projectId, pageId, expectedRevision: currentRevision, targetRevision: selected!}), {label: '恢复历史草稿'});
  return <section className="space-y-2 rounded-control border border-line p-2" data-testid="wiki-history">
    <p className="text-xs">恢复会新增修订并保留旧依据；旧来源仍需核查。生成章节在下一次来源更新时可能重新编译。</p>
    <div className="flex flex-wrap gap-2">{history.data?.map(item => <button key={item.revision} className={button} onClick={() => setSelected(item.revision)}>r{item.revision} · {reasons[item.reason]}</button>)}</div>
    {(history.error || old.error || rollback.error) && <p role="alert">{history.error ?? old.error ?? rollback.error}</p>}
    <div className="flex gap-2"><button className={button} disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>较新修订</button>
      <button className={button} disabled={history.data?.length !== 50} onClick={() => setOffset(v => v + 50)}>更早修订</button></div>
    {old.data && <div className="max-h-60 space-y-2 overflow-auto" data-testid="wiki-history-content"><p className="text-xs">历史 r{old.data.revision} · 以下为当时保存的内容与引用 ID</p>
      {old.data.sections.map(section => <div key={section.id}><h4 className="text-sm">{section.title}</h4><p className="whitespace-pre-wrap break-words text-xs">{section.body}</p>
        <p className="break-all text-xs text-subtle">引用：{section.evidenceIds.join('、') || '无'}</p></div>)}</div>}
    {selected !== null && selected !== currentRevision && <button className={button} disabled={!writable || rollback.pending || old.data === null}
      onClick={() => {void rollback.run().then(result => {if (result.ok) onChanged();});}}>恢复 r{selected} 为新修订</button>}
  </section>;
}
