import { useCallback, useEffect, useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import { AlertCircle, ArrowLeft, NotebookPen, Radar, Bell, BookOpen, Database, Layers, Loader2, PanelLeft, Plus, Search, Share2 } from 'lucide-react';
import { ViewActivity, useViewActive } from '../shared/view-activity';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ImportDialog } from './ImportDialog';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import { LibraryList } from './LibraryList';
import { PaperReader } from './PaperReader';
import { RagStudio } from './RagStudio';
import {WikiWorkspace} from './WikiWorkspace';
import { workspaceForSubView, type ImportTabRequest, type LiteratureSubView, type LiteratureWorkspace } from './hub-route';
import type { ViewProps } from '../app/view-registry';
import { useLiterature } from './literature-scope';
import { useLiteratureImportActions } from './use-literature-import-actions';
import { libraryItemTitle } from './format';
import {LiteratureProcessingPanel} from './LiteratureProcessingPanel';

/**
 * One retained literature host with local tabs grouped under discovery, library and knowledge.
 * Reading surfaces share the shell library selection. Project monitors load their module and
 * authoritative receipts on first visit; unsaved or uncertain commands lock tab navigation.
 */

type SubViewId = LiteratureSubView;
const DiscoverySearch = retryableLazy(() => import('./DiscoverySearch'));
const ReadingNotesPanel = retryableLazy(() => import('./ReadingNotesPanel'));
const AcademicRadarPanel = retryableLazy(() => import('./AcademicRadarPanel'));
const MonitorsPanel = retryableLazy(() => import('./MonitorsPanel'));

const SUB_VIEWS: Array<{ id: SubViewId; label: string; icon: typeof BookOpen; iconClass: string }> = [
  { id: 'search', label: '学术搜索', icon: Search, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'reader', label: '阅读', icon: BookOpen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'notes', label: '笔记', icon: NotebookPen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'radar', label: '推荐与趋势', icon: Radar, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'rag', label: '问答', icon: Database, iconClass: 'text-[var(--icon-rag)]' },
  { id: 'wiki', label: '知识页', icon: Layers, iconClass: 'text-[var(--icon-wiki)]' },
  { id: 'monitors', label: '已保存追踪', icon: Bell, iconClass: 'text-[var(--icon-literature)]' }
];

const SUB_TAB_BASE =
  'flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-chip px-3 text-[length:var(--font-meta-size)] transition-colors duration-[var(--duration-fast)]';

export function LiteratureHubView({ view }: ViewProps): React.JSX.Element {
  const store = useLiterature();
  const hubActive = useViewActive();
  const scope = useWorkspaceScope();
  const workspace: LiteratureWorkspace = view === 'discover' || view === 'knowledge' ? view : 'library';
  const [selectedViews, setSelectedViews] = useState<Record<LiteratureWorkspace, SubViewId>>({
    discover: 'search', library: 'reader', knowledge: 'rag'
  });
  const subView = selectedViews[workspace];
  const selectedTab = subView === 'graph' ? 'wiki' : subView;
  const subViews = SUB_VIEWS.filter(entry => workspaceForSubView(entry.id) === workspace);
  const [visited, setVisited] = useState<ReadonlySet<SubViewId>>(() => new Set([subView]));
  useEffect(() => {
    setVisited(current => current.has(subView) ? current : new Set([...current, subView]));
  }, [subView]);
  const [returnToSearch, setReturnToSearch] = useState(false);
  const [readerFocusRequestId, setReaderFocusRequestId] = useState(0);
  const [navigationOverride, setNavigationOverride] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [monitorLock, setMonitorLock] = useState(false);
  const monitorLockRef = useRef(false);
  const onMonitorLock = useCallback((locked: boolean) => {monitorLockRef.current = locked; setMonitorLock(locked);}, []);
  const hubRef = useRef<HTMLDivElement>(null);
  const paperPickerRef = useRef<HTMLSelectElement>(null);
  const navigationOpen = subView === 'reader' && !scope.contextDrawerOpen && (navigationOverride ?? (!narrow && store.selected === null));
  const selectSubView = (id: SubViewId, onSelected?: () => void): void => {
    if (monitorLockRef.current && id !== 'monitors') return;
    const destination = workspaceForSubView(id);
    const proceed = (): void => {
      setVisited(current => current.has(id) ? current : new Set([...current, id]));
      setSelectedViews(current => ({ ...current, [destination]: id }));
      onSelected?.();
    };
    if (destination !== workspace) scope.openView(destination, proceed);
    else proceed();
  };
  useEffect(() => {
    const element = hubRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setNarrow(entry.contentRect.width < 1024);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    hubRef.current?.querySelector(`#literature-tab-${subView}`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [subView]);
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportTabRequest>('document');
  const [focus, setFocus] = useState<{ parseId: string | null; locator: string | null; text?: string | null }>({
    parseId: null,
    locator: null
  });
  const selectPaper = (id: string | null): void => {
    store.select(id, commitSelection => {
      commitSelection();
      setNavigationOverride(false);
      setFocus({parseId: null, locator: null});
      setReturnToSearch(false);
      requestAnimationFrame(() => paperPickerRef.current?.focus());
    });
  };
  /** Set when the user arrives at the graph from a wiki concept page. */
  const [graphFocus, setGraphFocus] = useState<{claimId: string; nonce: number} | null>(null);

  const consumedOpenRequest = useRef(0);
  useEffect(() => {
    const request = scope.literatureRequest;
    if (!hubActive || !request || request.projectId !== store.projectId || consumedOpenRequest.current === request.nonce) return;
    const {target} = request;
    const destination = target.kind === 'concept' ? 'knowledge' : 'library';
    if (workspace !== destination) return;
    consumedOpenRequest.current = request.nonce;
    const next = target.kind === 'concept' ? 'graph' : 'reader';
    setSelectedViews(current => ({...current, [destination]: next}));
    setVisited(current => current.has(next) ? current : new Set([...current, next]));
    if (target.kind === 'concept') {
      setGraphFocus({claimId: target.claimId, nonce: request.nonce});
    } else {
      setFocus({parseId: target.parseId ?? null, locator: target.locator ?? null, text: target.text});
      setReaderFocusRequestId(request.nonce);
      setNavigationOverride(false);
      setReturnToSearch(target.returnToSearch ?? false);
    }
    scope.consumeLiteratureRequest(request.nonce);
  }, [hubActive, workspace, store.projectId, scope.literatureRequest, scope.consumeLiteratureRequest]);

  const actions = useLiteratureImportActions({ store });

  /**
   * The sidebar's 导入 button lives in the same store, so a request from there has
   * to open *this* dialog (the only one). Acknowledge it in the shared store so it
   * survives a lazy mount, but never replays after this hub has been remounted.
   */
  useEffect(() => {
    if (hubActive && store.importRequestId !== 0) {
      store.consumeImportRequest(store.importRequestId);
      setImportTab(store.importRequestTab);
      setImportOpen(true);
    }
  }, [hubActive, store.importRequestId, store.importRequestTab, store.consumeImportRequest]);

  const claims = store.claims;
  const evidence = store.evidence;
  const derivedReady = claims !== null && evidence !== null && store.derivedStatus !== 'error';

  const openImport = (tab: ImportTabRequest): void => {
    setImportTab(tab);
    setImportOpen(true);
  };

  const derivedPanel =
    store.derivedStatus === 'error' ? (
      <ErrorBar error={{ level: 'page', message: store.derivedError ?? '读取主张与证据失败', retry: store.reloadDerived }} />
    ) : (
      <EmptyState tone="loading" icon={Loader2} title="正在读取主张与证据…" testId="literature-derived-loading" />
    );

  return (
    <div ref={hubRef} className="literature-hub-container flex h-full min-h-0 min-w-0 flex-col" data-testid="literature-hub" data-sub-view={subView} data-workspace={workspace}>
      <div className="literature-toolbar grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b-[0.5px] border-line px-3 py-2">
        <div
          role="tablist"
          aria-label={workspace === 'discover' ? '发现工作区' : workspace === 'knowledge' ? '知识工作区' : '文献工作区'}
          onKeyDown={(event) => {
            const index = subViews.findIndex(entry => entry.id === selectedTab);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? subViews.length - 1
              : event.key === 'ArrowRight' ? (index + 1) % subViews.length
              : event.key === 'ArrowLeft' ? (index + subViews.length - 1) % subViews.length : null;
            if (next === null || monitorLockRef.current) return;
            event.preventDefault();
            const id = subViews[next]!.id;
            selectSubView(id);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="literature-subview-${id}"]`)?.focus();
          }}
          className="literature-tabs no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto rounded-control border-[0.5px] border-line bg-surface p-1"
        >
          {subViews.map((entry) => {
            const selected = entry.id === selectedTab;
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`literature-tab-${entry.id}`}
                aria-controls="literature-active-panel"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                disabled={monitorLock && entry.id !== 'monitors'}
                onClick={() => selectSubView(entry.id)}
                data-testid={`literature-subview-${entry.id}`}
                className={
                  selected
                    ? `${SUB_TAB_BASE} bg-[var(--surface-card-hover)] font-semibold text-ink`
                    : `${SUB_TAB_BASE} text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50`
                }
              >
                <Icon size={13} aria-hidden="true" className={entry.iconClass} />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </div>

        <div className="literature-actions ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="literature-review-inspect" disabled={scope.projectId === null}
            className="h-7 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-50"
            onClick={() => {
              if (scope.projectId === null) throw new Error('research_review_project_required');
              scope.openReviewInspector({mode: 'manage', projectId: scope.projectId, versionId: null});
            }}>综述核查</button>
          {subView === 'reader' && returnToSearch ? (
            <button type="button" data-testid="literature-return-search" onClick={() => selectSubView('rag', () => setReturnToSearch(false))}
              className="h-7 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]">返回检索结果</button>
          ) : null}
          {workspace === 'library' && !navigationOpen && !scope.contextDrawerOpen ? <button
            type="button"
            disabled={!scope.writable}
            onClick={() => openImport('document')}
            data-testid="literature-hub-import"
            className="flex h-7 items-center gap-2 rounded-control bg-accent px-3 font-medium text-on-accent text-[length:var(--font-meta-size)] transition-colors duration-[var(--duration-fast)] hover:bg-accent-deep active:opacity-90"
          >
            <Plus size={13} aria-hidden="true" />
            添加文献
          </button> : null}
        </div>
      </div>

      {store.projectId === null || workspace !== 'library' ? null : <LiteratureProcessingPanel client={store.client} projectId={store.projectId}
        writable={scope.writable} pickFile={actions.pickFile} addPdfToItem={store.addPdfToItem}
        onOpenPdf={scope.openFileInCanvas} onDocumentsChanged={store.reloadDocuments}
        onOpenItem={libraryItemId => scope.openLiterature({kind: 'reader', libraryItemId})}/>}

      {subView === 'reader' ? <div className="literature-paper-picker flex shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3 py-1">
        {scope.contextDrawerOpen ? null : <button type="button" onClick={() => setNavigationOverride(!navigationOpen)}
          aria-label={navigationOpen ? '收起文献列表' : '展开文献列表'} aria-expanded={navigationOpen}
          aria-controls="literature-navigation" data-testid="literature-toggle-navigation"
          className="flex h-7 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-focus-ring">
          <PanelLeft size={14} aria-hidden="true" />
          文献列表
        </button>}
            <select
              ref={paperPickerRef}
              aria-label="选择当前文献"
              value={store.selectedId ?? ""}
              disabled={store.items.length === 0 && store.selected === null}
              onChange={(event) => selectPaper(event.target.value || null)}
              className="h-8 min-w-0 flex-1 rounded-control border-[0.5px] border-line bg-surface px-2 text-ink text-[length:var(--font-meta-size)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50"
            >
              <option value="">选择一篇文献</option>
              {store.selected !== null && !store.items.some(item => item.id === store.selected?.id) ?
                <option value={store.selected.id}>{libraryItemTitle(store.selected)}</option> : null}
              {store.items.map((item) => (
                <option key={item.id} value={item.id}>{libraryItemTitle(item)}</option>
              ))}
            </select>
      </div> : null}

      <div className="flex min-h-0 flex-1">
        <aside id="literature-navigation" style={{ display: navigationOpen ? 'flex' : 'none', width: narrow ? '100%' : 240 }} className="literature-library-column min-h-0 min-w-0 shrink-0 border-r-[0.5px] border-line" aria-label="文献列表">
          <LibraryList onRequestImport={() => openImport('document')} onOpenItem={selectPaper} />
        </aside>

        <div id="literature-active-panel" role="tabpanel" aria-labelledby={`literature-tab-${selectedTab}`} tabIndex={0} style={navigationOpen && narrow ? {display: 'none'} : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`literature-panel-${subView}`}>
          {(visited.has('reader') || subView === 'reader') ? (
            <ViewActivity active={subView === 'reader'}><div style={{ display: subView === 'reader' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            {store.selectedStatus === 'error' ? <ErrorBar error={{level: 'page', message: store.selectedError ?? '读取文献失败', retry: store.reloadSelected}} /> : null}
            <PaperReader
              literature={store}
              onClearFocus={() => setFocus({parseId: null, locator: null})}
              openInFilesView={scope.openFileInCanvas}
              focusParseId={focus.parseId}
              focusLocator={focus.locator}
              focusText={focus.text}
              focusRequestId={readerFocusRequestId}
            />
            </div>
            </div></ViewActivity>
          ) : null}

          {(visited.has('rag') || subView === 'rag') ? (
            <ViewActivity active={subView === 'rag'}><div style={{ display: subView === 'rag' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            <RagStudio
              literature={store}
              openInFilesView={scope.openFileInCanvas}
              onOpenInReader={(target) => scope.openLiterature({kind: 'reader', ...target, returnToSearch: true})}
            />
            </div>
            </div></ViewActivity>
          ) : null}

          {(visited.has('wiki') || subView === 'wiki') ? (
            <ViewActivity active={subView === 'wiki'}><div style={{ display: subView === 'wiki' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 justify-end border-b-[0.5px] border-line px-3 py-1">
              <button type="button" data-testid="literature-open-graph" onClick={() => selectSubView('graph')}
                className="flex h-7 items-center gap-1 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]">
                <Share2 size={13} aria-hidden="true" className="text-[var(--icon-graph)]"/>关系图
              </button>
            </div>
            {derivedReady ? (
              <WikiWorkspace
                client={store.client}
                projectId={store.projectId}
                writable={scope.writable}
                snapshot={store.wikiSnapshot ?? undefined}
                onRefresh={store.reloadDerived}
                claims={claims}
                evidence={evidence}
                libraryItems={store.items}
                onOpenClaim={(claimId) => scope.openLiterature({kind: 'concept', claimId})}
                onOpenPaper={(libraryItemId) => scope.openLiterature({kind: 'reader', libraryItemId})}
                onAskAssistant={(prompt) => void store.askAssistant(prompt)}
              />
            ) : (
              derivedPanel
            )}
            </div>
            </div></ViewActivity>
          ) : null}

          {(visited.has('graph') || subView === 'graph') ? (
            <ViewActivity active={subView === 'graph'}><div style={{ display: subView === 'graph' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 border-b-[0.5px] border-line px-3 py-1">
              <button type="button" data-testid="literature-return-wiki" onClick={() => selectSubView('wiki')}
                className="flex h-7 items-center gap-1 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]">
                <ArrowLeft size={13} aria-hidden="true"/>返回知识页
              </button>
            </div>
            {derivedReady ? (
              <KnowledgeGraphView
                client={store.client}
                projectId={store.projectId}
                claims={claims}
                evidence={evidence}
                libraryItems={store.items}
                focusClaimId={graphFocus?.claimId ?? null}
                focusRequestId={graphFocus?.nonce ?? 0}
                onAskAssistantAboutNode={(node) =>
                  void store.askAssistant(`请围绕实体 “${node.label}” 扩展相关原理、算法演进与代表论文。`)
                }
              />
            ) : (
              derivedPanel
            )}
            </div>
            </div></ViewActivity>
          ) : null}
          {(visited.has('notes') || subView === 'notes') ? <ViewActivity active={subView === 'notes'}><div style={{display:subView==='notes'?'contents':'none'}}>
            <LazyBoundary fallback={<p role="status" className="p-3">加载笔记…</p>}>
              {scope.projectId===null?<p className="p-3 text-muted">选择项目后使用阅读笔记</p>:<ReadingNotesPanel key={scope.projectId}
                client={scope.client} projectId={scope.projectId} items={store.items} writable={scope.writable}/>}
            </LazyBoundary></div></ViewActivity>:null}
          {(visited.has('search') || subView === 'search') ? <ViewActivity active={subView === 'search'}>
            <div className="min-h-0 flex-1" hidden={subView !== 'search'}>
              <LazyBoundary fallback={<p role="status" className="p-3">加载学术搜索…</p>}>
                <DiscoverySearch store={store} actions={actions} writable={scope.writable} onOpenLibrary={() => scope.openView('library')} />
              </LazyBoundary>
            </div>
          </ViewActivity> : null}
          {(visited.has('radar') || subView === 'radar') ? <ViewActivity active={subView === 'radar'}><div style={{display:subView==='radar'?'contents':'none'}}>
            <LazyBoundary fallback={<p role="status" className="p-3">加载学术雷达…</p>}>
              {scope.projectId===null?<p className="p-3 text-muted">选择项目后使用学术雷达</p>:<AcademicRadarPanel key={scope.projectId}
                client={scope.client} projectId={scope.projectId} writable={scope.writable} active={hubActive && subView==='radar'} onImported={store.reload}/>}
            </LazyBoundary></div></ViewActivity>:null}
          {(visited.has('monitors') || subView === 'monitors') ? (
            <ViewActivity active={subView === 'monitors'}><div style={{display: subView === 'monitors' ? 'contents' : 'none'}}>
              <LazyBoundary fallback={<p role="status" className="p-3 text-muted">加载监控界面中</p>}>
                {scope.projectId === null ? <p className="p-3 text-muted">选择项目后查看文献监控</p> :
                  <MonitorsPanel key={scope.projectId} client={scope.client} projectId={scope.projectId}
                    items={store.items} writable={scope.writable} active={hubActive && subView === 'monitors'} onLockChange={onMonitorLock}/>}
              </LazyBoundary>
            </div></ViewActivity>
          ) : null}
        </div>
      </div>

      {store.action.error === null ? null : (
        <p
          role="alert"
          data-testid="literature-action-error"
          className="flex shrink-0 items-center gap-2 border-t-[0.5px] border-line px-3 py-2 text-[var(--st-bad)] text-[length:var(--font-meta-size)]"
        >
          <AlertCircle size={11} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{store.action.error}</span>
          <button
            type="button"
            onClick={store.clearActionError}
            className="rounded-control border-[0.5px] border-line px-1.5 text-muted hover:text-ink"
          >
            知道了
          </button>
        </p>
      )}

      <ImportDialog
        key={store.projectId ?? 'library'}
        client={store.client}
        projectId={store.projectId}
        onZoteroImported={store.reload}
        open={importOpen && hubActive}
        initialTab={importTab}
        onClose={() => setImportOpen(false)}
        selectedItem={store.selected === null ? null : { id: store.selected.id, title: store.selected.metadata.title }}
        canAttachToSelection={store.selected !== null}
        importDoi={store.importDoi}
        importBibliographyFile={store.importBibliographyFile}
        importRecord={store.importRecord}
        pickFile={actions.pickFile}
        searchLiterature={actions.searchLiterature}
        addCandidate={actions.addCandidate}
        addDocumentToNewItem={store.addPdfToNewItem}
        addDocumentToItem={store.addPdfToItem}
      />
    </div>
  );
}
