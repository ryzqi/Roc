import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, NotebookPen, Radar, Bell, BookOpen, Database, Layers, Loader2, PanelLeft, Plus, Share2 } from 'lucide-react';
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
import type { ImportTabRequest, LiteratureSubView } from './hub-route';
import { useLiterature } from './literature-scope';
import { useLiteratureImportActions } from './use-literature-import-actions';
import { libraryItemTitle } from './format';

/**
 * One literature canvas with internal reading, retrieval, knowledge, graph and monitor tabs.
 * Reading surfaces share the shell library selection. Project monitors load their module and
 * authoritative receipts on first visit; unsaved or uncertain commands lock tab navigation.
 */

type SubViewId = LiteratureSubView;
const ReadingNotesPanel = lazy(() => import('./ReadingNotesPanel'));
const AcademicRadarPanel = lazy(() => import('./AcademicRadarPanel'));
const MonitorsPanel = lazy(() => import('./MonitorsPanel'));

const SUB_VIEWS: Array<{ id: SubViewId; label: string; icon: typeof BookOpen; iconClass: string }> = [
  { id: 'reader', label: '阅读', icon: BookOpen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'notes', label: '笔记', icon: NotebookPen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'radar', label: '学术雷达', icon: Radar, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'rag', label: '检索', icon: Database, iconClass: 'text-[var(--icon-rag)]' },
  { id: 'wiki', label: '知识库', icon: Layers, iconClass: 'text-[var(--icon-wiki)]' },
  { id: 'graph', label: '图谱', icon: Share2, iconClass: 'text-[var(--icon-graph)]' },
  { id: 'monitors', label: '监控', icon: Bell, iconClass: 'text-[var(--icon-literature)]' }
];

const SUB_TAB_BASE =
  'flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip px-3 text-[length:var(--font-meta-size)] transition-colors duration-[var(--duration-fast)]';

export function LiteratureHubView(): React.JSX.Element {
  const store = useLiterature();
  const hubActive = useViewActive();
  const scope = useWorkspaceScope();
  const [subView, setSubView] = useState<SubViewId>('reader');
  const [visited, setVisited] = useState<ReadonlySet<SubViewId>>(() => new Set(['reader']));
  const [returnToSearch, setReturnToSearch] = useState(false);
  const [navigationOverride, setNavigationOverride] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [monitorLock, setMonitorLock] = useState(false);
  const onMonitorLock = useCallback((locked: boolean) => setMonitorLock(locked), []);
  const hubRef = useRef<HTMLDivElement>(null);
  const navigationOpen = navigationOverride ?? !narrow;
  const selectSubView = (id: SubViewId): void => {
    if (subView === 'monitors' && monitorLock && id !== 'monitors') return;
    setVisited(current => current.has(id) ? current : new Set([...current, id]));
    setSubView(id);
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
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportTabRequest>('document');
  const [focus, setFocus] = useState<{ parseId: string | null; locator: string | null }>({
    parseId: null,
    locator: null
  });
  /** Set when the user arrives at the graph from a wiki concept page. */
  const [graphClaimFocusId, setGraphClaimFocusId] = useState<string | null>(null);

  const actions = useLiteratureImportActions({ store });

  /**
   * The sidebar's 导入 button lives in the same store, so a request from there has
   * to open *this* dialog (the only one). The counter is compared against the last
   * value seen, so a request that arrives while the hub is already mounted still
   * opens it, and re-rendering does not re-open a dialog the user just closed.
   */
  const lastImportRequest = useRef(store.importRequestId);
  useEffect(() => {
    if (store.importRequestId !== lastImportRequest.current) {
      lastImportRequest.current = store.importRequestId;
      setImportTab('document');
      setImportOpen(true);
    }
  }, [store.importRequestId]);

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
    <div ref={hubRef} className="literature-hub-container flex h-full min-h-0 min-w-0 flex-col" data-testid="literature-hub" data-sub-view={subView}>
      <div className="literature-toolbar grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b-[0.5px] border-line px-3 py-1.5">
        <button type="button" onClick={() => setNavigationOverride(!navigationOpen)}
          aria-label={navigationOpen ? '收起文献列表' : '展开文献列表'} aria-expanded={navigationOpen}
          aria-controls="literature-navigation" data-testid="literature-toggle-navigation"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)]">
          <PanelLeft size={14} aria-hidden="true" />
        </button>
        <div
          role="tablist"
          aria-label="文献工作区"
          onKeyDown={(event) => {
            const index = SUB_VIEWS.findIndex(entry => entry.id === subView);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? SUB_VIEWS.length - 1
              : event.key === 'ArrowRight' ? (index + 1) % SUB_VIEWS.length
              : event.key === 'ArrowLeft' ? (index + SUB_VIEWS.length - 1) % SUB_VIEWS.length : null;
            if (next === null || monitorLock) return;
            event.preventDefault();
            const id = SUB_VIEWS[next]!.id;
            selectSubView(id);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="literature-subview-${id}"]`)?.focus();
          }}
          className="literature-tabs no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto rounded-control border-[0.5px] border-line bg-surface p-1"
        >
          {SUB_VIEWS.map((entry) => {
            const selected = entry.id === subView;
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
                    ? `${SUB_TAB_BASE} bg-[var(--surface-card-hover)] font-semibold text-ink shadow-[var(--shadow-card)]`
                    : `${SUB_TAB_BASE} text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50`
                }
              >
                <Icon size={13} aria-hidden="true" className={entry.iconClass} />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </div>

        <div className="literature-actions ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <button type="button" data-testid="literature-review-inspect" disabled={scope.projectId === null}
            className="h-7 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-50"
            onClick={() => {
              if (scope.projectId === null) throw new Error('research_review_project_required');
              scope.openReviewInspector({mode: 'manage', projectId: scope.projectId, versionId: null});
            }}>综述核查</button>
          {subView === 'reader' && returnToSearch ? (
            <button type="button" data-testid="literature-return-search" onClick={() => { selectSubView('rag'); setReturnToSearch(false); }}
              className="h-7 rounded-control px-2 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]">返回检索结果</button>
          ) : null}
          <button
            type="button"
            onClick={() => openImport('document')}
            data-testid="literature-hub-import"
            className="flex h-7 items-center gap-1.5 rounded-control bg-accent px-3 font-medium text-on-accent text-[length:var(--font-meta-size)] shadow-[var(--shadow-card)] transition-colors duration-[var(--duration-fast)] hover:bg-accent-deep active:opacity-90"
          >
            <Plus size={13} aria-hidden="true" />
            导入
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* At narrow canvas widths, the selector above replaces this list. */}
        <aside id="literature-navigation" style={{ display: navigationOpen && !['monitors','radar','notes'].includes(subView) ? 'flex' : 'none' }} className="literature-library-column min-h-0 w-[min(240px,40cqw)] shrink-0 border-r-[0.5px] border-line" aria-label="文献列表">
          <LibraryList onRequestImport={() => openImport('document')} />
        </aside>

        <div id="literature-active-panel" role="tabpanel" aria-labelledby={`literature-tab-${subView}`} tabIndex={0} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`literature-panel-${subView}`}>
          <label style={navigationOpen || subView === 'monitors' ? { display: 'none' } : undefined} className="literature-paper-picker hidden shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3 py-2">
            <span className="shrink-0 text-muted text-[length:var(--font-meta-size)]">当前文献</span>
            <select
              aria-label="选择当前文献"
              value={store.selectedId ?? ""}
              disabled={store.items.length === 0 && store.selected === null}
              onChange={(event) => {
                const id = event.target.value || null;
                store.select(id);
                if (id !== null) {
                  setFocus({ parseId: null, locator: null });
                  selectSubView('reader');
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-control border-[0.5px] border-line bg-surface px-2 text-ink text-[length:var(--font-meta-size)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50"
            >
              <option value="">选择一篇文献</option>
              {store.selected !== null && !store.items.some(item => item.id === store.selected?.id) ?
                <option value={store.selected.id}>{libraryItemTitle(store.selected)}</option> : null}
              {store.items.map((item) => (
                <option key={item.id} value={item.id}>{libraryItemTitle(item)}</option>
              ))}
            </select>
          </label>
          {visited.has('reader') ? (
            <ViewActivity active={subView === 'reader'}><div style={{ display: subView === 'reader' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            {store.selectedStatus === 'error' ? <ErrorBar error={{level: 'page', message: store.selectedError ?? '读取文献失败', retry: store.reloadSelected}} /> : null}
            <PaperReader
              literature={store}
              onClearFocus={() => setFocus({parseId: null, locator: null})}
              openInFilesView={scope.openFileInCanvas}
              focusParseId={focus.parseId}
              focusLocator={focus.locator}
            />
            </div>
            </div></ViewActivity>
          ) : null}

          {visited.has('rag') ? (
            <ViewActivity active={subView === 'rag'}><div style={{ display: subView === 'rag' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            <RagStudio
              literature={store}
              openInFilesView={scope.openFileInCanvas}
              onOpenInReader={(target) => {
                setReturnToSearch(true);
                setFocus({ parseId: target.parseId, locator: target.locator });
                if (target.libraryItemId !== null) {
                  store.select(target.libraryItemId);
                }
                selectSubView('reader');
              }}
            />
            </div>
            </div></ViewActivity>
          ) : null}

          {visited.has('wiki') ? (
            <ViewActivity active={subView === 'wiki'}><div style={{ display: subView === 'wiki' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
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
                onOpenClaim={(claimId) => {
                  setGraphClaimFocusId(claimId);
                  setFocus({ parseId: null, locator: null });
                  selectSubView('graph');
                }}
                onOpenPaper={(libraryItemId) => {
                  // Select the item, then land in the reader: selecting first is what makes the
                  // reader show *this* paper.
                  store.select(libraryItemId);
                  setFocus({ parseId: null, locator: null });
                  selectSubView('reader');
                }}
                onAskAssistant={(prompt) => void store.askAssistant(prompt)}
              />
            ) : (
              derivedPanel
            )}
            </div>
            </div></ViewActivity>
          ) : null}

          {visited.has('graph') ? (
            <ViewActivity active={subView === 'graph'}><div style={{ display: subView === 'graph' ? 'contents' : 'none' }}>
            <div className="flex min-h-0 flex-1 flex-col">
            {derivedReady ? (
              <KnowledgeGraphView
                claims={claims}
                evidence={evidence}
                libraryItems={store.items}
                focusClaimId={graphClaimFocusId}
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
          {visited.has('notes') ? <ViewActivity active={subView === 'notes'}><div style={{display:subView==='notes'?'contents':'none'}}>
            <Suspense fallback={<p role="status" className="p-3">加载笔记…</p>}>
              {scope.projectId===null?<p className="p-3 text-muted">选择项目后使用阅读笔记</p>:<ReadingNotesPanel key={scope.projectId}
                client={scope.client} projectId={scope.projectId} items={store.items} writable={scope.writable}/>}
            </Suspense></div></ViewActivity>:null}
          {visited.has('radar') ? <ViewActivity active={subView === 'radar'}><div style={{display:subView==='radar'?'contents':'none'}}>
            <Suspense fallback={<p role="status" className="p-3">加载学术雷达…</p>}>
              {scope.projectId===null?<p className="p-3 text-muted">选择项目后使用学术雷达</p>:<AcademicRadarPanel key={scope.projectId}
                client={scope.client} projectId={scope.projectId} writable={scope.writable} active={hubActive && subView==='radar'} onImported={store.reload}/>}
            </Suspense></div></ViewActivity>:null}
          {visited.has('monitors') ? (
            <ViewActivity active={subView === 'monitors'}><div style={{display: subView === 'monitors' ? 'contents' : 'none'}}>
              <Suspense fallback={<p role="status" className="p-3 text-muted">加载监控界面中</p>}>
                {scope.projectId === null ? <p className="p-3 text-muted">选择项目后查看文献监控</p> :
                  <MonitorsPanel key={scope.projectId} client={scope.client} projectId={scope.projectId}
                    items={store.items} writable={scope.writable} active={hubActive && subView === 'monitors'} onLockChange={onMonitorLock}/>}
              </Suspense>
            </div></ViewActivity>
          ) : null}
        </div>
      </div>

      {store.action.error === null ? null : (
        <p
          role="alert"
          data-testid="literature-action-error"
          className="flex shrink-0 items-center gap-1.5 border-t-[0.5px] border-line px-3 py-1.5 text-[var(--st-bad)] text-[length:var(--font-meta-size)]"
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
        open={importOpen}
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
      {actions.pickError === null ? null : (
        <p role="alert" className="px-3 pb-1 text-[var(--st-bad)] text-[length:var(--font-meta-size)]">
          选择文件失败：{actions.pickError}
        </p>
      )}
    </div>
  );
}
