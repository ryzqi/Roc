import { useVisiblePolling } from '../shared/view-activity';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowLeft, BookOpen, Plus, RefreshCw, Search} from 'lucide-react';
import {EmptyState} from '../shell/EmptyState';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import './knowledge-workspace.css';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {useDebouncedValue} from '../app/use-debounced-value';
import {ActionButton, formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';
import type {ResearchWikiSnapshot} from '../../shared/schemas/research-wiki';
import type {WikiPage, WikiSection, WikiPaperKnowledgeSource, WikiSummary, WikiTemplate} from '../../shared/schemas/research-wiki-pages';
import {ScientificPaperKnowledge, ScientificStatementReference} from './ScientificPaperKnowledge';
import {WikiScientificExplanation} from './WikiScientificExplanation';
import {statementReferenceKey} from './scientific-wiki';
import {useLiteratureEditor} from './literature-editor-guard';
import type {PaperSource} from '../../shared/schemas/research-paper-card';
import type {z} from 'zod';
import type {knowledgeContextResultSchema} from '../../shared/schemas/research-knowledge-context';

const ScientificMarkdown = retryableLazy(() => import('./ScientificMarkdown'));
const button = formSecondaryButtonClass;
const field = formInputClass;
const kinds = {source: '论文与来源', topic: '主题', comparison: '比较', dispute: '争议'};
const layers = {L1: 'L1 论文来源', L2: 'L2 领域知识', L3: 'L3 研究综合'};
const templates: Record<WikiTemplate, string> = {paper_source: '论文来源', concept: '概念', method: '方法',
  equation: '公式', algorithm: '算法', dataset: '数据集', metric: '指标', protocol: '实验协议', research_synthesis: '研究综合'};
const templateEntries = Object.entries(templates) as [WikiTemplate, string][];
function classification(page: WikiSummary): {layer: keyof typeof layers; template: WikiTemplate} {
  const template = page.template ?? (page.kind === 'source' ? 'paper_source' : 'research_synthesis');
  return {template, layer: page.layer ?? (template === 'paper_source' ? 'L1' : template === 'research_synthesis' ? 'L3' : 'L2')};
}
const jobs = {queued: '排队中', running: '编译中', ready: '已编译', failed: '编译失败'};
const paperJobs = {queued: '排队中', running: '生成中', ready: '已生成', failed: '生成失败'};
const jobStates = {queued: 'pending', running: 'pending', ready: 'success', failed: 'error'} as const;
const reasons = {compile: '来源编译', human: '人工编辑', assistant: '助手草稿', rollback: '历史恢复'};
type Props = {client: RocClient; projectId: string; snapshot?: ResearchWikiSnapshot; writable: boolean;
  onAskAssistant?: (prompt: string) => void; onLock: (locked: boolean) => void};

export function WikiPages({client, projectId, snapshot, writable, onAskAssistant, onLock}: Props): React.JSX.Element {
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(true);
  const [layer, setLayer] = useState<keyof typeof layers | ''>(''), [template, setTemplate] = useState<WikiTemplate | ''>('');
  const searchQuery = useDebouncedValue(query, 250);
  const pages = useAsyncResource(`wiki-pages:${projectId}:${searchQuery}:${offset}:${layer}:${template}`,
    () => client.api.research.searchWiki({projectId, query: searchQuery, offset,
      ...(layer ? {layers: [layer]} : {}), ...(template ? {templates: [template]} : {})}), {label: '读取 Wiki 页面'});
  const locked = creating || editing;
  useEffect(() => {onLock(locked); return () => onLock(false);}, [locked, onLock]);
  const onEditing = useCallback((value: boolean) => {onLock(value); setEditing(value);}, [onLock]);
  useVisiblePolling(pages.reload, 3000);
  return <div className="knowledge-pages flex min-h-0 min-w-0 flex-1 flex-col" data-testid="wiki-pages" data-browsing={browsing && !creating}>
    <header className="knowledge-toolbar">
      <label className="knowledge-search"><Search size={15} aria-hidden="true"/>
        <input type="search" aria-label="搜索持久页面" value={query} disabled={locked}
          onChange={event => {setQuery(event.target.value); setOffset(0); setBrowsing(true);}} placeholder="搜索知识页面"/>
      </label>
      <label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs">层级
        <select className={field} aria-label="筛选知识层级" value={layer} disabled={locked}
          onChange={event => {setLayer(event.target.value as typeof layer); setOffset(0); setBrowsing(true);}}>
          <option value="">全部层级</option>{Object.entries(layers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs">模板
        <select className={field} aria-label="筛选页面模板" value={template} disabled={locked}
          onChange={event => {setTemplate(event.target.value as typeof template); setOffset(0); setBrowsing(true);}}>
          <option value="">全部模板</option>{templateEntries.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button type="button" className={formPrimaryButtonClass} disabled={locked || !writable}
        onClick={() => {onLock(true); setCreating(true); setBrowsing(false);}}><Plus size={14} aria-hidden="true"/>新建主题页</button>
      <ActionButton variant="compact" loading={pages.status === 'loading'} loadingLabel={<span className="sr-only">正在刷新列表…</span>}
        onClick={pages.reload} aria-label="刷新列表" title="刷新列表"><RefreshCw size={14} aria-hidden="true"/></ActionButton>
    </header>
    {pages.error && <ActionStatus state="error" className="p-3">{pages.error}</ActionStatus>}
    {searchQuery && pages.data?.degradation === 'embedding_failed' && <ActionStatus state="idle" role="status" className="px-3 pb-2 text-xs text-subtle" testId="wiki-search-status">
      语义检索暂不可用，已显示关键词结果。
    </ActionStatus>}
    <div className="knowledge-browser">
      <aside className="knowledge-directory" aria-label="持久页面列表">
        <div className="knowledge-directory-heading"><span>页面目录</span><span>{pages.data?.pages.length ?? 0} 页</span></div>
        <div className="knowledge-directory-scroll">
        {pages.data === null && !pages.error && <ActionStatus state="pending" icon={null} className="p-2 text-xs text-subtle">正在读取页面…</ActionStatus>}
        {pages.data?.pages.length === 0 && <p className="p-2 text-xs text-subtle">{layer || template ? '没有符合筛选条件的页面。' : searchQuery ? '没有命中。可尝试原始文献检索。' : '暂无页面。先解析论文或捕获原始证据。'}</p>}
        {pages.data?.pages.map(page => <button key={page.id} disabled={locked} aria-current={selected === page.id ? 'page' : undefined}
          data-testid="wiki-page-row" className="knowledge-page-row"
          onClick={() => {setSelected(page.id); setBrowsing(false);}}>
          <span className="block break-words">{page.title}</span>
          <span className="flex flex-wrap gap-x-2 text-xs text-subtle">
            <span>{kinds[page.kind]}</span>
            <span>{classification(page).layer}</span><span>{templates[classification(page).template]}</span>
            <span>{page.job ? jobs[page.job.status] : '待编译'}</span>
          </span>
          {page.matches[0] && <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-subtle"><span>{page.matches[0].title}</span><span>{page.matches[0].snippet.slice(0, 100)}</span></span>}
        </button>)}
        </div>
        <div className="knowledge-directory-footer"><button className={button} disabled={locked || offset === 0}
          onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</button>
          <button className={button} disabled={locked || pages.data?.nextOffset == null}
            onClick={() => setOffset(pages.data?.nextOffset ?? offset)}>下一页</button></div>
      </aside>
      <div className="knowledge-detail">
        <button type="button" className={`knowledge-back ${button}`} disabled={locked}
          onClick={() => setBrowsing(true)}><ArrowLeft size={14} aria-hidden="true"/>返回页面目录</button>
        <div className="knowledge-detail-scroll"><div className="knowledge-reading-column">
        {creating ? <CreatePage client={client} projectId={projectId} snapshot={snapshot} writable={writable}
          onClose={() => {setCreating(false); setBrowsing(selected === null);}} onCreated={id => {
            setSelected(id); setCreating(false); setLayer(''); setTemplate(''); setQuery(''); setOffset(0); pages.reload();
          }}/> :
          selected === null ? <EmptyState icon={BookOpen} title="选择一页知识"/> :
          <PageDetail key={selected} client={client} projectId={projectId} pageId={selected} writable={writable}
            onAskAssistant={onAskAssistant} onEditing={onEditing} onNavigate={id => {setSelected(id); setBrowsing(false);}} onChanged={pages.reload}/>}
        </div></div>
      </div>
    </div>
  </div>;
}

type CreateDraft = {title: string; kind: 'topic' | 'comparison' | 'dispute';
  template: Exclude<WikiTemplate, 'paper_source'>; evidenceIds: string[]; claimIds: string[]};
const emptyCreateDraft = (): CreateDraft => ({title: '', kind: 'topic', template: 'research_synthesis', evidenceIds: [], claimIds: []});

function CreatePage({client, projectId, snapshot, writable, onClose, onCreated}: Pick<Props, 'client' | 'projectId' | 'snapshot' | 'writable'> & {
  onClose: () => void; onCreated: (id: string) => void}): React.JSX.Element {
  const [draft, setDraft] = useState<CreateDraft>(emptyCreateDraft);
  const current = useRef(draft), submitting = useRef(false), mounted = useRef(true);
  const {title, kind, template, evidenceIds, claimIds} = draft;
  const [filter, setFilter] = useState(''), [offset, setOffset] = useState(0);
  const create = useAsyncAction((value: CreateDraft) => client.api.research.createWiki({projectId, ...value}), {label: '创建 Wiki 页'});
  const editor = useLiteratureEditor({label: 'Wiki 主题草稿', dirty: () => current.current.title !== '' ||
    current.current.kind !== 'topic' || current.current.template !== 'research_synthesis' ||
    current.current.evidenceIds.length + current.current.claimIds.length > 0,
    busy: () => submitting.current, discard: () => {
      current.current = emptyCreateDraft(); setDraft(current.current); create.reset(); editor.notify();
    }});
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const change = (patch: Partial<CreateDraft>): void => {
    if (!writable || submitting.current) return;
    current.current = {...current.current, ...patch}; setDraft(current.current); editor.notify();
  };
  const submit = async (): Promise<void> => {
    const value = current.current;
    if (!writable || submitting.current || !value.title.trim() || value.evidenceIds.length + value.claimIds.length === 0) return;
    submitting.current = true; editor.notify();
    try {
      const result = await create.run(value);
      if (!mounted.current || !result.ok) return;
      current.current = emptyCreateDraft(); onCreated(result.data.page.id);
    } finally {
      submitting.current = false;
      if (mounted.current) editor.notify();
    }
  };
  const disabled = !writable || create.pending;
  const choices = (snapshot?.sources ?? []).filter(source => source.referenceStatus === 'recorded' &&
    `${source.evidence.title}\n${source.evidence.excerpt}`.toLowerCase().includes(filter.toLowerCase()));
  return <form className="space-y-3" data-testid="wiki-create" aria-busy={create.pending} onSubmit={event => {event.preventDefault(); void submit();}}>
    <h3 className="text-[length:var(--font-h3-size)] font-medium">新建主题页</h3>
    <label className="flex flex-col gap-1.5 text-xs">标题<input aria-label="页面标题" className={field} value={title} maxLength={300} required disabled={disabled} onChange={event => change({title: event.target.value})}/></label>
    <label className="flex flex-col gap-1.5 text-xs">页面类型<select aria-label="页面类型" className={field} value={kind} disabled={disabled}
      onChange={event => change({kind: event.target.value as typeof kind})}><option value="topic">主题</option><option value="comparison">比较</option><option value="dispute">争议</option></select></label>
    <label className="flex flex-col gap-1.5 text-xs">页面模板<select aria-label="页面模板" className={field} value={template} disabled={disabled}
      onChange={event => change({template: event.target.value as typeof template})}>
      {templateEntries.filter(([value]) => value !== 'paper_source').map(([value, label]) => <option key={value} value={value}>
        {value === 'research_synthesis' ? 'L3' : 'L2'} {label}
      </option>)}
    </select></label>
    <label className="flex flex-col gap-1.5 text-xs">选择原始证据（最多 50 条）<input aria-label="筛选原始证据" className={field} value={filter} disabled={disabled}
      onChange={event => {setFilter(event.target.value); setOffset(0);}}/></label>
    <div className="ui-scroll-region max-h-52 rounded-control border-[0.5px] border-line p-2">
      {choices.slice(offset, offset + 20).map(source => <label key={source.evidence.id} className="flex items-start gap-2 py-1 text-xs">
        <input type="checkbox" checked={evidenceIds.includes(source.evidence.id)} disabled={disabled || (!evidenceIds.includes(source.evidence.id) && evidenceIds.length >= 50)}
          onChange={event => change({evidenceIds: event.target.checked ? [...current.current.evidenceIds, source.evidence.id] :
            current.current.evidenceIds.filter(id => id !== source.evidence.id)})}/>
        <span className="min-w-0 break-words">
          <span className="flex flex-wrap gap-x-2"><span>{source.evidence.title}</span><span className="text-subtle">{source.evidence.locator}</span></span>
          <span className="block text-subtle">{source.evidence.excerpt.slice(0, 160)}</span>
        </span>
      </label>)}
      {choices.length === 0 && <p className="text-xs">没有符合条件的有效证据。</p>}
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs"><span className="tabular-nums">已选 {evidenceIds.length} 条</span><button type="button" className={button} disabled={create.pending || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 20))}>前 20 条</button>
      <button type="button" className={button} disabled={create.pending || offset + 20 >= choices.length} onClick={() => setOffset(v => v + 20)}>后 20 条</button></div>
    <details><summary className="cursor-pointer text-xs">关联主张（可选）</summary>
      {(snapshot?.claims ?? []).filter(claim => claim.evidenceIds.some(id => evidenceIds.includes(id))).slice(0, 50).map(claim =>
        <label key={claim.id} className="flex items-start gap-2 py-1 text-xs"><input type="checkbox" checked={claimIds.includes(claim.id)} disabled={disabled}
          onChange={event => change({claimIds: event.target.checked ? [...current.current.claimIds, claim.id] :
            current.current.claimIds.filter(id => id !== claim.id)})}/><span>{claim.content.slice(0, 200)}</span></label>)}
    </details>
    {create.error && <ActionStatus state="error">{create.error}</ActionStatus>}
    <div className="flex flex-wrap gap-2"><ActionButton variant="primary" type="submit" aria-label="创建草稿" loading={create.pending} loadingLabel="正在创建草稿…"
      disabled={disabled || title.trim() === '' || evidenceIds.length + claimIds.length === 0}>创建草稿</ActionButton>
      <button type="button" className={button} disabled={create.pending} onClick={() => editor.request(onClose, '继续将放弃尚未创建的 Wiki 主题草稿。')}>取消</button></div>
  </form>;
}

function PageDetail({client, projectId, pageId, writable, onAskAssistant, onEditing, onNavigate, onChanged}: Omit<Props, 'snapshot' | 'onLock'> & {
  pageId: string; onEditing: (value: boolean) => void; onNavigate: (id: string) => void; onChanged: () => void}): React.JSX.Element {
  const page = useAsyncResource(`wiki-page:${projectId}:${pageId}`, () => client.api.research.readWiki({projectId, pageId}), {label: '读取 Wiki 草稿'});
  const [edit, setEdit] = useState<{section: WikiSection; page: WikiPage} | null>(null), [sectionOffset, setSectionOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false), [historyPending, setHistoryPending] = useState(false);
  const compiling = useRef(false), historyBusy = useRef(false), mounted = useRef(true);
  const compile = useAsyncAction((expectedRevision: number) => client.api.research.compileWiki({projectId, pageId, expectedRevision}), {label: '重新编译 Wiki'});
  const retryPaper = useAsyncAction(() => client.api.research.retryWikiPaper({projectId, pageId}), {label: '生成论文卡片'});
  const synthesize = useAsyncAction((data: WikiPage, sectionId: string) => client.api.research.resynthesizeWiki({
    projectId, pageId, expectedRevision: data.page.revision, expectedBasisDigest: data.basisDigest, sectionIds: [sectionId]
  }), {label: '更新助手章节'});
  const editor = useLiteratureEditor({label: 'Wiki 修订操作', dirty: () => false,
    busy: () => compiling.current || historyBusy.current, discard: () => {}});
  const pending = compile.pending || retryPaper.pending || synthesize.pending || historyPending, locked = edit !== null || pending;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {onEditing(locked); return () => onEditing(false);}, [locked, onEditing]);
  const onHistoryPending = useCallback((value: boolean): void => {
    historyBusy.current = value; setHistoryPending(value);
    onEditing(edit !== null || compiling.current || value); editor.notify();
  }, [edit, editor, onEditing]);
  const mutate = async (work: () => Promise<{ok: boolean}>): Promise<void> => {
    if (!writable || edit !== null || editor.busy()) return;
    compiling.current = true; onEditing(true); editor.notify();
    try {
      const result = await work();
      if (!mounted.current || !result.ok) return;
      page.reload(); onChanged();
    } finally {
      compiling.current = false;
      if (mounted.current) {onEditing(edit !== null || historyBusy.current); editor.notify();}
    }
  };
  useVisiblePolling(page.reload, 3000, !locked);
  const data = page.data;
  if (data === null) return <div><ActionStatus state={page.error ? 'error' : 'pending'} icon={page.error ? undefined : null}>{page.error ?? '正在读取页面…'}</ActionStatus>
    <ActionButton variant="compact" aria-label="重试读取" loading={page.status === 'loading'} loadingLabel="正在读取页面…" onClick={page.reload}>重试读取</ActionButton></div>;
  // Routine provenance notes stay in the audit data; reading only surfaces actionable issues.
  const checks = [...new Map(data.lint.filter(issue => issue.code !== 'uncited' && issue.code !== 'isolated')
    .map(issue => [`${issue.code}:${issue.message}`, issue])).values()];
  return <article className="knowledge-article space-y-3" data-testid="wiki-page-detail" aria-busy={pending}>
    <h2 className="break-words text-[length:var(--font-h2-size)] font-medium">{data.page.title}</h2>
    <div className="flex flex-wrap gap-x-2 text-xs text-subtle" data-testid="wiki-page-status">
      <span>{kinds[data.page.kind]}</span><span>草稿</span>
      <ActionStatus key={data.page.job ? `${data.page.job.generation}:${data.page.job.status}` : 'uncompiled'}
        state={data.page.job ? jobStates[data.page.job.status] : 'idle'} announce={false}>
        {data.page.job ? jobs[data.page.job.status] : '待编译'}
      </ActionStatus>
      {data.paperJob && data.paperJob.status !== 'ready' && <ActionStatus key={`${data.paperJob.generation}:${data.paperJob.status}`}
        state={jobStates[data.paperJob.status]} announce={false}>论文卡片：{paperJobs[data.paperJob.status]}</ActionStatus>}
      {data.current && <span>{reasons[data.current.reason]}</span>}
      <span>{layers[classification(data.page).layer]}</span><span>{templates[classification(data.page).template]}</span>
    </div>
    <div className="knowledge-page-actions">
      <ActionButton variant="compact" aria-label="刷新页面" disabled={locked} loading={page.status === 'loading'}
        loadingLabel="正在刷新页面…" onClick={page.reload}>刷新页面</ActionButton>
      <details className="knowledge-maintenance"><summary>页面操作</summary>
        <div className="knowledge-maintenance-actions">
      <ActionButton variant="compact" aria-label="重新编译" loading={compile.pending} loadingLabel="正在提交编译…"
        disabled={!writable || locked || ['running', 'queued'].includes(data.page.job?.status ?? '')}
        onClick={() => {void mutate(() => compile.run(data.page.revision));}}>重新编译</ActionButton>
      {data.paperJob && <ActionButton variant="compact" aria-label="重新生成论文卡片" loading={retryPaper.pending} loadingLabel="正在提交生成…"
        disabled={!writable || locked || ['running', 'queued'].includes(data.paperJob.status)}
        onClick={() => {void mutate(() => retryPaper.run());}}>重新生成论文卡片</ActionButton>}
      <button className={button} disabled={locked} aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>修订历史</button>
        </div>
      </details>
      <details className="knowledge-maintenance" data-testid="wiki-page-diagnostics"><summary>页面诊断</summary>
        <p className="break-all py-2 text-xs tabular-nums text-subtle">草稿修订 r{data.page.revision}</p>
      </details>
      {onAskAssistant && <button className={button} disabled={locked} onClick={() => onAskAssistant(
        `请用 research_wiki_read 读取当前项目的 Wiki 页面 ${pageId}（${data.page.title}），核对 lint 与原始证据后综合主题草稿。每个事实注明原始 evidenceId；过期依据先回原文检索。可用 research_wiki_draft 保存生成章节，保留人工章节，不确认科学支持。`)}>交给助手综合</button>}
    </div>
    {synthesize.pending && <ActionStatus state="pending" testId="wiki-synthesis-status">正在更新助手章节…</ActionStatus>}
    {(page.error || compile.error || retryPaper.error || synthesize.error || data.page.job?.error || data.paperJob?.error) &&
      <ActionStatus state="error">{page.error ?? compile.error ?? retryPaper.error ?? synthesize.error ?? data.page.job?.error ?? data.paperJob?.error}</ActionStatus>}
    {historyOpen && <History key={data.page.revision} client={client} projectId={projectId} pageId={pageId} currentRevision={data.page.revision}
      writable={writable && !locked} onPending={onHistoryPending} onChanged={() => {page.reload(); onChanged();}}/>}
    {(data.page.kind === 'comparison' || data.page.kind === 'dispute') && <ClaimComparisonPanel client={client} projectId={projectId}/>}
    {checks.length > 0 && <details className="knowledge-page-checks" data-testid="wiki-page-lint"><summary className="cursor-pointer">
      <span className="inline-flex flex-wrap gap-x-2"><span>来源待处理</span><span className="tabular-nums text-subtle">{checks.length} 项</span></span>
    </summary>
      <ul className="max-h-40 overflow-auto text-xs">{checks.map(issue => <li key={`${issue.code}:${issue.message}`} className="break-words py-1">{issue.message}</li>)}</ul>
    </details>}
    {edit !== null ? <SectionEditor client={client} projectId={projectId} data={edit.page} section={edit.section} writable={writable}
      onClose={() => setEdit(null)} onSaved={() => {setEdit(null); page.reload(); onChanged();}}/> :
      <div>{data.current?.sections.slice(sectionOffset, sectionOffset + 10).map(section => <section key={section.id} className="knowledge-section">
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 flex-1 break-words text-[length:var(--font-h3-size)] font-medium">{section.title}</h3>
          <button className={`${button} shrink-0`} disabled={!writable || pending} onClick={() => {
            if (editor.busy()) return;
            onEditing(true); setEdit({section, page: data});
          }}>编辑章节</button></div>
        <p className="flex flex-wrap gap-x-2 text-xs text-subtle">
          <span>{section.owner === 'human' ? '人工维护' : '生成草稿'}</span>
          {section.status === 'stale' && <span>依据已改变，待更新</span>}
        </p>
        {section.owner === 'assistant' && section.status === 'stale' && <button className={button} disabled={!writable || pending}
          onClick={() => {void mutate(() => synthesize.run(data, section.id));}}>更新此助手章节</button>}
        {onAskAssistant && data.page.kind !== 'source' && section.owner !== 'human' && Boolean(section.paperKnowledgeSources?.length) &&
          <button className={button} disabled={!writable || pending} onClick={() => onAskAssistant(
            `请为此 Wiki 章节补充新论文来源。当前操作上下文：${JSON.stringify({projectId, pageId,
              sectionIds: [section.id], expectedRevision: data.page.revision, expectedBasisDigest: data.basisDigest,
              existingPaperKnowledgeSources: section.paperKnowledgeSources})}。先用 research_wiki_read 核对当前修订，读取相关新论文已发布的科研知识代次；` +
            '若来源或目标不明确，先询问我。调用 research_wiki_update_sources 仅更新此节的 paperKnowledgeSources，保留人工章节和历史修订。' +
            '依据更新收据中的最新 revision 与 basisDigest 调用 research_wiki_resynthesize，仅重建此节。展示原始来源、未解决问题与未人工审核状态。'
          )}>用新论文更新此节</button>}
        {section.scientificExplanation ? <>
          <WikiScientificExplanation client={client} projectId={projectId} explanation={section.scientificExplanation}
            current={section.status === 'current'} sourceReady={page.status === 'ready'}/>
          <details className="knowledge-auxiliary"><summary>完整章节记录与原始条件</summary>
            <div className="knowledge-section-body" data-testid="wiki-section-body"><LazyBoundary fallback={<p className="whitespace-pre-wrap">{section.body}</p>}><ScientificMarkdown text={section.body}/></LazyBoundary></div>
          </details>
        </> : <div className="knowledge-section-body" data-testid="wiki-section-body"><LazyBoundary fallback={<p className="whitespace-pre-wrap">{section.body}</p>}><ScientificMarkdown text={section.body}/></LazyBoundary></div>}
        {page.status !== 'ready' ? null : <>
          {section.scientificStatements?.map((statement, index) => <ScientificStatementReference
            key={`${statementReferenceKey(statement)}:${index}`} client={client} projectId={projectId} statement={statement}/>)}
          {section.paperKnowledgeSources?.map(source => <ScientificPaperSourceReference
            key={JSON.stringify(source)} client={client} projectId={projectId} source={source}/>)}
        </>}
        {section.paperSources?.map(source => <PaperOriginal key={`${source.chunkId}:${source.indexedVersion}`}
          client={client} projectId={projectId} source={source}/>)}
        {section.evidenceIds.map(id => {const source = data.sources.find(item => item.evidenceId === id); return <details key={id}>
          <summary className="cursor-pointer break-words text-xs">
            <span className="inline-flex flex-wrap gap-x-2"><span>原始证据：{source?.title ?? id}</span>
              <span className="text-subtle">{source?.status === 'recorded' ? '已记录来源' : '失效或缺失'}</span>
            </span>
          </summary>
          <p className="flex flex-wrap gap-x-2 break-all text-xs text-subtle"><span>{id}</span><span>{source?.locator}</span></p>
          <blockquote className="ui-scroll-region max-h-60 whitespace-pre-wrap break-words border-l-[0.5px] border-line pl-3 text-xs">{source?.excerpt ?? '此证据已不可读取，请核对来源。'}</blockquote>
        </details>;})}
        <div className="flex flex-wrap gap-2">{section.links.map(id => <button key={id} className={button} disabled={pending}
          onClick={() => {if (!editor.busy()) onNavigate(id);}}>
          {data.links.find(link => link.id === id)?.title ?? '链接已缺失'}</button>)}</div>
      </section>)}</div>}
    {edit === null && (data.current?.sections.length ?? 0) > 10 && <div className="flex flex-wrap gap-2"><button className={button} disabled={pending || sectionOffset === 0} onClick={() => setSectionOffset(v => Math.max(0, v - 10))}>前 10 节</button>
      <button className={button} disabled={pending || sectionOffset + 10 >= (data.current?.sections.length ?? 0)} onClick={() => setSectionOffset(v => v + 10)}>后 10 节</button></div>}
  </article>;
}

function SectionEditor({client, projectId, data, section, writable, onClose, onSaved}: {
  client: RocClient; projectId: string; data: WikiPage; section: WikiSection; writable: boolean; onClose: () => void; onSaved: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState({title: section.title, body: section.body});
  const current = useRef(draft), baseline = useRef(draft), submitting = useRef(false), mounted = useRef(true);
  const {title, body} = draft;
  const save = useAsyncAction((value: typeof draft) => client.api.research.saveWiki({projectId, pageId: data.page.id, expectedRevision: data.page.revision,
    expectedBasisDigest: data.basisDigest, section: {id: section.id, ...value, evidenceIds: section.evidenceIds,
      claimIds: section.claimIds, links: section.links, paperSources: section.paperSources,
      paperKnowledgeSources: section.paperKnowledgeSources,
      ...(value.body === section.body && section.scientificExplanation ? {scientificExplanation: section.scientificExplanation} : {}),
      ...(value.body === section.body && section.scientificStatements ? {scientificStatements: section.scientificStatements} : {})
    }}), {label: '保存人工章节'});
  const editor = useLiteratureEditor({label: 'Wiki 人工章节', dirty: () => current.current.title !== baseline.current.title ||
    current.current.body !== baseline.current.body, busy: () => submitting.current, discard: () => {
      current.current = baseline.current; setDraft(current.current); save.reset(); editor.notify();
    }});
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const change = (patch: Partial<typeof draft>): void => {
    if (!writable || submitting.current) return;
    current.current = {...current.current, ...patch}; setDraft(current.current); editor.notify();
  };
  const submit = async (): Promise<void> => {
    const value = current.current;
    if (!writable || submitting.current || !value.title.trim() || !value.body.trim()) return;
    submitting.current = true; editor.notify();
    try {
      const result = await save.run(value);
      if (!mounted.current || !result.ok) return;
      baseline.current = value; onSaved();
    } finally {
      submitting.current = false;
      if (mounted.current) editor.notify();
    }
  };
  const disabled = !writable || save.pending;
  return <form className="space-y-3" data-testid="wiki-section-editor" aria-busy={save.pending} onSubmit={event => {event.preventDefault(); void submit();}}>
    <label className="flex flex-col gap-1.5 text-xs">章节标题<input aria-label="章节标题" className={field} value={title} maxLength={300} required disabled={disabled} onChange={event => change({title: event.target.value})}/></label>
    <div className="knowledge-editor-preview">
      <label className="flex min-w-0 flex-col gap-2 text-xs">章节正文<textarea aria-label="章节正文" className={`${field} min-h-64 resize-y py-2`} value={body} maxLength={6000} required disabled={disabled} onChange={event => change({body: event.target.value})}/></label>
      <section className="knowledge-live-preview" aria-label="章节实时预览" data-testid="wiki-section-preview">
        <h4>实时预览</h4><LazyBoundary fallback={<p className="whitespace-pre-wrap">{body}</p>}><ScientificMarkdown text={body}/></LazyBoundary>
      </section>
    </div>
    {save.error && <ActionStatus state="error">{save.error}</ActionStatus>}
    <div className="flex flex-wrap gap-2"><ActionButton variant="primary" type="submit" aria-label="保存人工章节" loading={save.pending}
      loadingLabel="正在保存人工章节…" disabled={disabled || !body.trim() || !title.trim()}>保存人工章节</ActionButton>
      <button type="button" className={button} disabled={save.pending} onClick={() => editor.request(onClose, '继续将放弃尚未保存的 Wiki 人工章节。')}>取消编辑</button></div>
  </form>;
}

function ScientificPaperSourceReference({client, projectId, source}: {
  client: RocClient; projectId: string; source: WikiPaperKnowledgeSource
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs">科研知识来源状态</summary>
    {open ? <ScientificPaperKnowledge client={client} projectId={projectId} reference={source}/> : null}
  </details>;
}

function PaperOriginal({client, projectId, source}: {client: RocClient; projectId: string; source: PaperSource}): React.JSX.Element {
  const [original, setOriginal] = useState<z.infer<typeof knowledgeContextResultSchema> | null>(null);
  const read = useAsyncAction(() => client.api.research.readKnowledgeContext({
    projectId, chunkId: source.chunkId, expectedIndexedVersion: source.indexedVersion, maxChars: 4000, neighbors: true
  }), {label: '读取论文原文'});
  return <details>
    <summary className="cursor-pointer break-words text-xs">论文原文：{source.sectionPath.join(' / ') || source.locator}</summary>
    <p className="text-xs text-subtle">{source.locator}</p>
    <ActionButton variant="compact" aria-label="读取原文上下文" loading={read.pending} loadingLabel="正在读取原文上下文…"
      onClick={() => {void read.run().then(result => {if (result.ok) setOriginal(result.data);});}}>读取原文上下文</ActionButton>
    {read.error && <ActionStatus state="error" className="text-xs">{read.error}</ActionStatus>}
    {original && <blockquote className="ui-scroll-region max-h-60 whitespace-pre-wrap break-words border-l-[0.5px] border-line pl-3 text-xs">
      {original.context.content}{original.neighbors.map(context => `\n\n${context.locator ?? ''}\n${context.content}`).join('')}
    </blockquote>}
  </details>;
}

function History({client, projectId, pageId, currentRevision, writable, onPending, onChanged}: {
  client: RocClient; projectId: string; pageId: string; currentRevision: number; writable: boolean;
  onPending: (value: boolean) => void; onChanged: () => void
}): React.JSX.Element {
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<number | null>(null);
  const submitting = useRef(false), mounted = useRef(true);
  const history = useAsyncResource(`wiki-history:${pageId}:${offset}`, () => client.api.research.wikiHistory({projectId, pageId, offset}), {label: '读取修订历史'});
  const old = useAsyncResource(selected === null ? null : `wiki-revision:${pageId}:${selected}`,
    () => client.api.research.wikiRevision({projectId, pageId, revision: selected!}), {label: '读取历史修订'});
  const rollback = useAsyncAction((targetRevision: number) => client.api.research.rollbackWiki({
    projectId, pageId, expectedRevision: currentRevision, targetRevision
  }), {label: '恢复历史草稿'});
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; onPending(false);};
  }, [onPending]);
  const restore = async (): Promise<void> => {
    if (!writable || submitting.current || selected === null || selected === currentRevision || old.data === null) return;
    submitting.current = true; onPending(true);
    try {
      const result = await rollback.run(selected);
      if (mounted.current && result.ok) onChanged();
    } finally {
      submitting.current = false;
      if (mounted.current) onPending(false);
    }
  };
  return <section className="space-y-2 border-t-[0.5px] border-line pt-3" data-testid="wiki-history">
    <p className="text-xs">恢复会新增修订并保留旧依据；旧来源仍需核查。生成章节在下一次来源更新时可能重新编译。</p>
    {history.status === 'loading' && <ActionStatus state="pending" className="text-xs">正在读取修订历史…</ActionStatus>}
    <div className="flex flex-wrap gap-2">{history.data?.map(item => <button key={item.revision} className={`${button} aria-pressed:bg-[var(--overlay-active)]`}
      aria-pressed={selected === item.revision} disabled={rollback.pending} onClick={() => setSelected(item.revision)}>
      <span className="tabular-nums">r{item.revision}</span><span>{reasons[item.reason]}</span>
    </button>)}</div>
    {(history.error || old.error || rollback.error) && <ActionStatus state="error">{history.error ?? old.error ?? rollback.error}</ActionStatus>}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={rollback.pending || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>较新修订</button>
      <button className={button} disabled={rollback.pending || history.data?.length !== 50} onClick={() => setOffset(v => v + 50)}>更早修订</button></div>
    {old.status === 'loading' && <ActionStatus state="pending" className="text-xs">正在读取历史 r{selected}…</ActionStatus>}
    {old.data && <div className="ui-scroll-region max-h-60 space-y-2" data-testid="wiki-history-content">
      <p className="flex flex-wrap gap-x-2 text-xs"><span className="tabular-nums">历史 r{old.data.revision}</span><span>以下为当时保存的内容与引用 ID</span></p>
      {old.data.sections.map(section => <div key={section.id}><h4>{section.title}</h4><p className="whitespace-pre-wrap break-words text-xs">{section.body}</p>
        <p className="break-all text-xs text-subtle">引用：{section.evidenceIds.join('、') || '无'}</p></div>)}</div>}
    {selected !== null && selected !== currentRevision && <ActionButton variant="compact" aria-label={`恢复 r${selected} 为新修订`}
      loading={rollback.pending} loadingLabel={`正在恢复 r${selected}…`} disabled={!writable || rollback.pending || old.data === null}
      onClick={() => {void restore();}}>恢复 r{selected} 为新修订</ActionButton>}
  </section>;
}
import {ClaimComparisonPanel} from './ClaimComparisonPanel';
