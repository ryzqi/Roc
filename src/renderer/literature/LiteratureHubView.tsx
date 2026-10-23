import { useEffect, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Database, Layers, Loader2, Plus, Share2 } from 'lucide-react';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ImportDialog } from './ImportDialog';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import { LibraryList } from './LibraryList';
import { PaperReader } from './PaperReader';
import { RagStudio } from './RagStudio';
import { WikiView } from './WikiView';
import type { ImportTabRequest, LiteratureSubView } from './hub-route';
import { useLiterature } from './literature-scope';
import { useLiteratureImportActions } from './use-literature-import-actions';
import { libraryItemTitle } from './format';

/**
 * The literature hub (P5): 阅读 / RAG / 知识库 / 图谱, plus the library list.
 *
 * The four sub-views are the new frontend's information architecture. They live in
 * one canvas view with an internal tab strip rather than four `?view=` values
 * because they all read *the same selection*: separate views would let a deep link
 * land on 图谱 with no selected paper and no way back.
 *
 * The sub-view itself is **component state**, not a URL parameter. That is a
 * deliberate exception to "navigation state lives in the URL": adding
 * `?literature=` would have meant extending the frozen route contract (and its
 * round-trip tests) for a selector the legacy shell also kept in component state,
 * and none of P5's gates require a deep link into a sub-view. Registered in the
 * phase's deviation table.
 *
 * Where the data comes from, without exception:
 *   - library list + selection + claims/evidence: the shared `useLiteratureStore`
 *     (created in `AppShell`, so the sidebar's 文献 tab sees the same state);
 *   - Wiki / 图谱: `derive-wiki` / `derive-graph` over those real claims + evidence;
 *   - RAG: `research.index.*` + `research.knowledge.search`, never a local retriever.
 *
 * No mock path exists: when the backend has nothing, each sub-view shows its empty
 * state (gate 4).
 *
 * ## The header
 *
 * One recessed tab track on the left (four equal chips, the active one raised) and the
 * 「导入」 action on the right as the screen's single solid primary button. One detail is deliberate:
 *
 *   - the labels are 阅读 / 检索 / 知识库 / 图谱: 知识库 is this product's established word
 *     for the derived concept view (its testids and docs all say `wiki`/知识库);
 * The cross-view `FocusRequest` hand-off (检索 → 阅读, 知识库 → 图谱) is unchanged.
 */

type SubViewId = LiteratureSubView;

const SUB_VIEWS: Array<{ id: SubViewId; label: string; icon: typeof BookOpen; iconClass: string }> = [
  { id: 'reader', label: '阅读', icon: BookOpen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'rag', label: '检索', icon: Database, iconClass: 'text-[var(--icon-rag)]' },
  { id: 'wiki', label: '知识库', icon: Layers, iconClass: 'text-[var(--icon-wiki)]' },
  { id: 'graph', label: '图谱', icon: Share2, iconClass: 'text-[var(--icon-graph)]' }
];

const SUB_TAB_BASE =
  'flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip px-3 text-[var(--font-meta-size)] transition-colors duration-[var(--duration-fast)]';

export function LiteratureHubView(): React.JSX.Element {
  const store = useLiterature();
  const scope = useWorkspaceScope();
  const [subView, setSubView] = useState<SubViewId>('reader');
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
  const derivedReady = claims !== null && evidence !== null;

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
    <div className="literature-hub-container flex h-full min-h-0 flex-col" data-testid="literature-hub" data-sub-view={subView}>
      <div className="no-scrollbar flex h-11 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-line px-3">
        <div
          role="tablist"
          aria-label="文献工作区"
          className="flex shrink-0 items-center gap-1 rounded-control border border-line bg-surface p-0.5"
        >
          {SUB_VIEWS.map((entry) => {
            const selected = entry.id === subView;
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setSubView(entry.id)}
                data-testid={`literature-subview-${entry.id}`}
                className={
                  selected
                    ? `${SUB_TAB_BASE} bg-[var(--surface-card-hover)] font-semibold text-ink shadow-[var(--shadow-card)]`
                    : `${SUB_TAB_BASE} text-muted hover:text-ink active:bg-[var(--overlay-active)]`
                }
              >
                <Icon size={13} aria-hidden="true" className={entry.iconClass} />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => openImport('document')}
            data-testid="literature-hub-import"
            className="flex h-7 items-center gap-1.5 rounded-control bg-accent px-3 font-medium text-on-accent text-[var(--font-meta-size)] shadow-[var(--shadow-card)] transition-colors duration-[var(--duration-fast)] hover:bg-accent-deep active:opacity-90"
          >
            <Plus size={13} aria-hidden="true" />
            导入
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* At narrow canvas widths, the selector above replaces this list. */}
        <aside className="literature-library-column hidden w-72 shrink-0 border-r border-line lg:flex" aria-label="文献列表">
          <LibraryList onRequestImport={() => openImport('document')} />
        </aside>

        <div className="flex min-h-0 flex-1 flex-col" data-testid={`literature-panel-${subView}`}>
          <label className="literature-paper-picker hidden shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span className="shrink-0 text-muted text-[var(--font-meta-size)]">当前文献</span>
            <select
              aria-label="选择当前文献"
              value={store.selectedId ?? ""}
              disabled={store.items.length === 0}
              onChange={(event) => {
                const id = event.target.value || null;
                store.select(id);
                if (id !== null) {
                  setFocus({ parseId: null, locator: null });
                  setSubView('reader');
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-ink text-[var(--font-meta-size)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50"
            >
              <option value="">选择一篇文献</option>
              {store.items.map((item) => (
                <option key={item.id} value={item.id}>{libraryItemTitle(item)}</option>
              ))}
            </select>
          </label>
          {subView === 'reader' ? (
            <PaperReader
              literature={store}
              loadDocumentContent={store.loadDocumentContent}
              openInFilesView={scope.openFileInCanvas}
              focusParseId={focus.parseId}
              focusLocator={focus.locator}
            />
          ) : null}

          {subView === 'rag' ? (
            <RagStudio
              literature={store}
              openInFilesView={scope.openFileInCanvas}
              onOpenInReader={(target) => {
                setFocus({ parseId: target.parseId, locator: target.locator });
                if (target.libraryItemId !== null) {
                  store.select(target.libraryItemId);
                }
                setSubView('reader');
              }}
            />
          ) : null}

          {subView === 'wiki' ? (
            derivedReady ? (
              <WikiView
                claims={claims}
                evidence={evidence}
                libraryItems={store.items}
                onOpenClaim={(claimId) => {
                  setGraphClaimFocusId(claimId);
                  setFocus({ parseId: null, locator: null });
                  setSubView('graph');
                }}
                onOpenPaper={(libraryItemId) => {
                  // Select the item, then land in the reader: selecting first is what makes the
                  // reader show *this* paper.
                  store.select(libraryItemId);
                  setFocus({ parseId: null, locator: null });
                  setSubView('reader');
                }}
                onAskAssistant={(prompt) => void store.askAssistant(prompt)}
              />
            ) : (
              derivedPanel
            )
          ) : null}

          {subView === 'graph' ? (
            derivedReady ? (
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
            )
          ) : null}
        </div>
      </div>

      {store.action.error === null ? null : (
        <p
          role="alert"
          data-testid="literature-action-error"
          className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1.5 text-[var(--st-bad)] text-[var(--font-micro-size)]"
        >
          <AlertCircle size={11} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{store.action.error}</span>
          <button
            type="button"
            onClick={store.clearActionError}
            className="rounded-control border border-line px-1.5 text-muted hover:text-ink"
          >
            知道了
          </button>
        </p>
      )}

      <ImportDialog
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
        addDocumentToNewItem={store.addPdfToNewItem}
        addDocumentToItem={store.addPdfToItem}
      />
      {actions.pickError === null ? null : (
        <p role="alert" className="px-3 pb-1 text-[var(--st-bad)] text-[var(--font-micro-size)]">
          选择文件失败：{actions.pickError}
        </p>
      )}
    </div>
  );
}
