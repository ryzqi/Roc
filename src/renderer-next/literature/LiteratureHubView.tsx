import { useEffect, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Loader2, Plus } from 'lucide-react';
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

/**
 * The literature hub (P5): 阅读 / RAG / 知识库 / 图谱, plus the library list.
 *
 * The four sub-views are the new frontend's information architecture. They live in
 * one canvas view with an internal tab strip rather than four `?view=` values
 * because they all read *the same selection*: separate views would let a deep link
 * land on 图谱 with no selected paper and no way back.
 *
 * The sub-view itself is **component state**, not a URL parameter. That is a
 * deliberate divergence from ADR-M05's "navigation state lives in the URL": adding
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
 */

type SubViewId = LiteratureSubView;

const SUB_VIEWS: Array<{ id: SubViewId; label: string }> = [
  { id: 'reader', label: '阅读' },
  { id: 'rag', label: 'RAG' },
  { id: 'wiki', label: '知识库' },
  { id: 'graph', label: '图谱' }
];

export function LiteratureHubView(): React.JSX.Element {
  const store = useLiterature();
  const scope = useWorkspaceScope();
  const [subView, setSubView] = useState<SubViewId>('reader');
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportTabRequest>('document');
  const [focus, setFocus] = useState<{ documentId: string | null; locator: string | null }>({
    documentId: null,
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
    <div className="flex h-full min-h-0 flex-col" data-testid="literature-hub" data-sub-view={subView}>
      <div role="tablist" aria-label="文献工作区" className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        {SUB_VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === subView}
            tabIndex={entry.id === subView ? 0 : -1}
            onClick={() => setSubView(entry.id)}
            data-testid={`literature-subview-${entry.id}`}
            className={
              entry.id === subView
                ? 'h-[var(--control-height-compact)] rounded-control bg-accent-soft px-2.5 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)]'
                : 'h-[var(--control-height-compact)] rounded-control px-2.5 text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
            }
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => openImport('document')}
          data-testid="literature-hub-import"
          className="ml-auto flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
        >
          <Plus size={11} aria-hidden="true" />
          导入
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The hub's own copy of the sidebar tab; below `lg` the sidebar is the only
            list, so this column collapses instead of competing with it. */}
        <aside className="hidden w-72 shrink-0 border-r border-line lg:flex" aria-label="文献列表">
          <LibraryList onRequestImport={() => openImport('document')} />
        </aside>

        <div className="flex min-h-0 flex-1 flex-col" data-testid={`literature-panel-${subView}`}>
          {subView === 'reader' ? (
            <PaperReader
              literature={store}
              loadDocumentContent={store.loadDocumentContent}
              openInFilesView={scope.openFileInCanvas}
              focusDocumentId={focus.documentId}
              focusLocator={focus.locator}
            />
          ) : null}

          {subView === 'rag' ? (
            <RagStudio
              literature={store}
              openInFilesView={scope.openFileInCanvas}
              onOpenInReader={(target) => {
                setFocus({ documentId: target.documentId, locator: target.locator });
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
                  setFocus({ documentId: null, locator: null });
                  setSubView('graph');
                }}
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

      <p className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1 text-subtle text-[var(--font-micro-size)]">
        <BookOpen size={10} aria-hidden="true" />
        来源：research.library.* · research.document.* · research.index.* · research.knowledge.search · research.evidence.* · research.claims.*
      </p>

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
