import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {AnimatePresence, useIsPresent} from 'motion/react';
import {AlertCircle, BookOpen, Copy, FilePlus2, ListChecks, Loader2, RefreshCw, Search, SlidersHorizontal, Sparkles, Trash2, Unlink, X} from 'lucide-react';
import type {ResearchLibraryItem} from '../../shared/types';
import type {LibraryVirtualizedRowsHandle} from './LibraryVirtualizedRows';
import type {LiteratureStore} from './use-literature-store';
import {EmptyState} from '../shell/EmptyState';
import {ErrorBar} from '../shell/ErrorBar';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import {AnchoredPopover} from '../shell/AnchoredPopover';
import {ContextMenu, type ContextMenuAction} from '../shell/ContextMenu';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import {ActionButton, formSecondaryButtonClass, formSelectClass} from '../shared/form-ui';
import {useCopyFeedback} from '../shared/hooks/use-copy-feedback';
import {useAsyncAction} from '../app/use-async-resource';
import {libraryItemTitle} from './format';
import {useLiterature} from './literature-scope';
import {LibraryPaperRow, type LibraryRowActions} from './LibraryPaperRow';
import {libraryAvailability, type LibraryStatusGroup} from './library-availability';
import {useLibraryRemoval} from './use-library-removal';
import {SelectionIndicator} from '../shared/SelectionIndicator';
import {LibraryPresence} from './LibraryPresence';
import {useLibraryRowMotion} from './use-library-row-motion';
import {LibraryLoading} from './LibraryLoading';
import {AnimatedCount} from '../shared/AnimatedCount';
import './library-list.css';

export type LibraryListProps = {
  compact?: boolean;
  writable?: boolean;
  entryType?: string | null;
  onOpenItem?: (id: string, direction: -1 | 0 | 1) => void;
  onReadItem?: (id: string) => void;
  showActionError?: boolean;
  onRequestImport: () => void;
};

type SortOrder = 'updated' | 'year' | 'title';
type ListScope = {client: LiteratureStore['client']; projectId: string | null; writable: boolean};
type RowMenu = {scope: ListScope; item: ResearchLibraryItem; anchor: {x: number; y: number}};
type IngestionState = {scope: ListScope; pending: boolean; error: string | null};
type DeleteTarget = {scope: ListScope; item: ResearchLibraryItem; cleanupPending: boolean};
type UndoFocus = {
  scope: ListScope;
  key: string;
  trigger: HTMLButtonElement;
  restoredIds: readonly string[] | null;
  started: boolean;
};
const EMPTY_IDS: ReadonlySet<string> = new Set();
const VIRTUALIZE_THRESHOLD = 60;
const STATUS_LABELS: Record<LibraryStatusGroup, string> = {all: '全部', processing: '处理中', ready: '就绪', attention: '需处理'};
const STATUS_GROUPS: readonly LibraryStatusGroup[] = ['all', 'processing', 'ready', 'attention'];
const LazyLibraryVirtualizedRows = retryableLazy(async () => {
  const module = await import('./LibraryVirtualizedRows');
  return {default: module.LibraryVirtualizedRows};
});

/**
 * The sidebar and canvas share the same store and backend search. Status filters
 * explicitly describe the loaded window; they never hide matches on later pages.
 */
export function LibraryList({compact = false, writable: writableOverride, entryType = null, onOpenItem, onReadItem, showActionError = true, onRequestImport}: LibraryListProps): React.JSX.Element {
  const literature = useLiterature();
  const writable = (writableOverride ?? true) && (literature.writable ?? true);
  const scopeRef = useRef<ListScope>({client: literature.client, projectId: literature.projectId, writable});
  if (scopeRef.current.client !== literature.client || scopeRef.current.projectId !== literature.projectId || scopeRef.current.writable !== writable) {
    scopeRef.current = {client: literature.client, projectId: literature.projectId, writable};
  }
  const scope = scopeRef.current;
  const mountedRef = useRef(false);
  useEffect(() => {mountedRef.current = true; return () => {mountedRef.current = false;};}, []);
  const isCurrent = useCallback(() => mountedRef.current && scopeRef.current === scope, [scope]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{scope: ListScope; message: string} | null>(null);
  const deletionBusy = useRef(false);
  const deletionOpenFrame = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (deletionOpenFrame.current !== undefined) cancelAnimationFrame(deletionOpenFrame.current);
    deletionOpenFrame.current = undefined;
  }, [scope]);
  const currentDelete = deleteTarget?.scope === scope ? deleteTarget : null;
  const deletion = useAsyncAction((target: DeleteTarget) => target.scope.client.api.research.deleteLibraryItem({
    id: target.item.id, expectedRevision: target.item.revision
  }), {label: '永久删除文献'});
  const confirmDelete = async (): Promise<void> => {
    if (currentDelete === null || !isCurrent() || !writable || deletionBusy.current) return;
    deletionBusy.current = true;
    try {
      const result = await deletion.run(currentDelete);
      if (!result.ok || !isCurrent()) return;
      literature.forgetDeletedItems([currentDelete.item.id]);
      if (result.data.cleanupPending) setDeleteTarget({...currentDelete, cleanupPending: true});
      else {
        setDeleteTarget(null);
        setDeleteNotice({scope, message: result.data.preservedFiles === 0 ? '文献已永久删除。'
          : `文献已删除，保留了 ${result.data.preservedFiles} 个已被修改或无法确认归 Roc 所有的文件。`});
      }
    } finally {deletionBusy.current = false;}
  };
  const removal = useLibraryRemoval(literature);
  const copy = useCopyFeedback();
  const [searchDraft, setSearchDraft] = useState(literature.query);
  const [sort, setSort] = useState<SortOrder>('updated');
  const [statusGroup, setStatusGroup] = useState<LibraryStatusGroup>('all');
  const [selecting, setSelecting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(literature.selectedId);
  const [visibleRange, setVisibleRange] = useState({startIndex: 0, endIndex: 0});
  const [virtualizerReady, setVirtualizerReady] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const menuFocusRef = useRef<HTMLElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const ingestionBusy = useRef<ListScope | null>(null);
  const [ingestion, setIngestion] = useState<IngestionState | null>(null);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const virtualizerRef = useRef<LibraryVirtualizedRowsHandle | null>(null);
  const pendingFocusId = useRef<string | null>(null);
  const undoFocusRef = useRef<UndoFocus | null>(null);
  const [undoFocusVersion, setUndoFocusVersion] = useState(0);
  const lastScrolledSelection = useRef<string | null>(null);
  const selectionKey = JSON.stringify([literature.query, literature.includeArchived, entryType, statusGroup]);
  const focusKey = JSON.stringify([selectionKey, sort]);
  const [selection, setSelection] = useState<{scope: ListScope; key: string; ids: ReadonlySet<string>}>({scope, key: selectionKey, ids: EMPTY_IDS});
  const checkedIds = selection.scope === scope && selection.key === selectionKey ? selection.ids : EMPTY_IDS;
  const baseItems = useMemo(() => literature.items.filter(item => entryType === null || item.bibliography.entryType === entryType)
    .sort((left, right) => sort === 'year' ? (right.metadata.publishedYear ?? 0) - (left.metadata.publishedYear ?? 0)
      : sort === 'title' ? libraryItemTitle(left).localeCompare(libraryItemTitle(right), 'zh-CN')
        : right.updatedAt.localeCompare(left.updatedAt)), [literature.items, entryType, sort]);
  const requestedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!literature.parsingDocumentIds?.size) return EMPTY_IDS;
    for (const receipt of literature.documentStatuses?.values() ?? []) {
      if (receipt.documents.some(document => literature.parsingDocumentIds.has(document.id))) ids.add(receipt.libraryItemId);
    }
    for (const document of literature.documents ?? []) {
      if (literature.parsingDocumentIds.has(document.id)) ids.add(document.libraryItemId);
    }
    return ids;
  }, [literature.documentStatuses, literature.parsingDocumentIds, literature.documents]);
  const availability = useMemo(() => new Map(baseItems.map(item => [item.id,
    libraryAvailability(item, literature.documentStatuses?.get(item.id), undefined, requestedIds.has(item.id))])),
  [baseItems, literature.documentStatuses, requestedIds]);
  const statusCounts = useMemo(() => {
    const counts = {all: 0, processing: 0, ready: 0, attention: 0};
    for (const item of baseItems) {
      if (removal.hiddenIds.has(item.id)) continue;
      counts.all++;
      const group = availability.get(item.id)?.group;
      if (group !== undefined && group !== 'all') counts[group]++;
    }
    return counts;
  }, [baseItems, availability, removal.hiddenIds]);
  const items = useMemo(() => statusGroup === 'all' && removal.hiddenIds.size === 0 ? baseItems
    : baseItems.filter(item => !removal.hiddenIds.has(item.id) &&
      (statusGroup === 'all' || availability.get(item.id)?.group === statusGroup)),
  [baseItems, removal.hiddenIds, statusGroup, availability]);
  const checkedItems = useMemo(() => checkedIds.size === 0 ? [] : items.filter(item => checkedIds.has(item.id)), [items, checkedIds]);
  useLibraryRowMotion(listBodyRef, items, scope, virtualizerReady, removal.hiddenIds);
  const checkedItemsKey = checkedItems.map(item => item.id).join(':');
  const selectedDocuments = useMemo(() => literature.documentsStatus === 'ready'
    ? literature.documents.filter(document => document.libraryItemId === literature.selectedId) : undefined,
  [literature.documents, literature.documentsStatus, literature.selectedId]);

  useEffect(() => {setSearchDraft(literature.query);}, [literature.query]);
  useEffect(() => {
    setSelection(previous => previous.scope === scope && previous.key === selectionKey
      ? previous : {scope, key: selectionKey, ids: EMPTY_IDS});
  }, [scope, selectionKey]);
  useEffect(() => {
    const listed = new Set(literature.items.map(item => item.id));
    setSelection(previous => {
      if (previous.scope !== scope || previous.key !== selectionKey || previous.ids.size === 0) return previous;
      const ids = new Set([...previous.ids].filter(id => listed.has(id) && !removal.hiddenIds.has(id)));
      return ids.size === previous.ids.size ? previous : {...previous, ids};
    });
  }, [literature.items, removal.hiddenIds, scope, selectionKey]);
  useEffect(() => {setFocusedId(literature.selectedId);}, [scope, literature.selectedId]);
  useEffect(() => {
    setFiltersOpen(false); setMenu(null); setDropActive(false);
    setSelecting(false); setStatusGroup('all');
  }, [scope]);
  useEffect(() => {
    if (menu !== null && !items.some(item => item.id === menu.item.id)) setMenu(null);
  }, [items, menu]);

  const virtualize = items.length > VIRTUALIZE_THRESHOLD;
  const selectedIndex = useMemo(() => items.findIndex(item => item.id === literature.selectedId), [items, literature.selectedId]);
  const activeIndex = useMemo(() => {
    const index = items.findIndex(item => item.id === focusedId);
    return index < 0 ? (items.length === 0 ? -1 : Math.max(0, selectedIndex)) : index;
  }, [items, focusedId, selectedIndex]);
  const tabStopId = virtualize && (activeIndex < visibleRange.startIndex || activeIndex > visibleRange.endIndex)
    ? items[visibleRange.startIndex]?.id : items[activeIndex]?.id;
  const setVirtualizerRef = useCallback((handle: LibraryVirtualizedRowsHandle | null): void => {
    virtualizerRef.current = handle; setVirtualizerReady(handle !== null);
  }, []);
  const onNavigationInterrupted = useCallback((): void => {
    const ownedFocus = pendingFocusId.current !== null;
    pendingFocusId.current = null;
    if (undoFocusRef.current?.started) undoFocusRef.current = null;
    if (ownedFocus && document.activeElement === document.body) listBodyRef.current?.focus({preventScroll: true});
  }, []);
  useEffect(() => {
    if (selectedIndex < 0) {lastScrolledSelection.current = null; return;}
    const key = JSON.stringify([literature.projectId, literature.selectedId, literature.query, sort, entryType, statusGroup, virtualize, virtualizerReady]);
    if (lastScrolledSelection.current === key) return;
    lastScrolledSelection.current = key;
    if (virtualize) virtualizerRef.current?.scrollIntoView({index: selectedIndex, behavior: 'auto'});
    else rowRefs.current.get(literature.selectedId!)?.scrollIntoView({block: 'nearest'});
  }, [selectedIndex, literature.projectId, literature.selectedId, literature.query, sort, entryType, statusGroup, virtualize, virtualizerReady]);

  const currentRef = useRef({literature, scope, selectionKey, focusKey, items, virtualize, onOpenItem, onReadItem, removal, copy});
  currentRef.current = {literature, scope, selectionKey, focusKey, items, virtualize, onOpenItem, onReadItem, removal, copy};
  const focusRow = useCallback((index: number, ownsFocus?: () => boolean): void => {
    const current = currentRef.current;
    const item = current.items[index];
    if (item === undefined) return;
    setFocusedId(item.id); pendingFocusId.current = item.id;
    const focusMountedRow = (): void => {
      if (pendingFocusId.current !== item.id || currentRef.current.scope !== current.scope) return;
      if (ownsFocus !== undefined && !ownsFocus()) {pendingFocusId.current = null; return;}
      const row = rowRefs.current.get(item.id);
      if (row === undefined) return;
      pendingFocusId.current = null;
      if (current.virtualize) {
        // Virtuoso measures offsetHeight as an integer. A fractional viewport can
        // still clip its end-aligned row, and native nearest scrolling rounds it
        // away. Correct the physical boundary once while navigation owns focus.
        const scroller = row.closest<HTMLElement>('.library-virtual-list');
        if (scroller !== null) {
          const viewport = scroller.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          if (bounds.top < viewport.top) scroller.scrollTop += Math.floor(bounds.top - viewport.top);
          else if (bounds.bottom > viewport.bottom) scroller.scrollTop += Math.ceil(bounds.bottom - viewport.bottom);
        }
      }
      row.focus({preventScroll: true});
      if (!current.virtualize) row.scrollIntoView({block: 'nearest'});
    };
    if (current.virtualize) virtualizerRef.current?.scrollIntoView({index, behavior: 'auto',
      done: () => {requestAnimationFrame(focusMountedRow);}});
    else focusMountedRow();
  }, []);
  const ownsUndoFocus = useCallback((request: UndoFocus): boolean => {
    const current = currentRef.current;
    return mountedRef.current && undoFocusRef.current === request && current.scope === request.scope &&
      current.focusKey === request.key &&
      (document.activeElement === request.trigger || document.activeElement === document.body);
  }, []);
  useEffect(() => {
    const releaseFocus = (event: Event): void => {
      const request = undoFocusRef.current;
      if (request === null || event.target === request.trigger ||
        (event.type === 'focusin' && event.target === document.body)) return;
      undoFocusRef.current = null;
      if (request.started) pendingFocusId.current = null;
    };
    // A disabled/disappearing Undo button can leave focus on body. A subsequent
    // user click, scroll or focus change cancels that ownership before RPCs finish.
    document.addEventListener('focusin', releaseFocus);
    document.addEventListener('pointerdown', releaseFocus, true);
    document.addEventListener('wheel', releaseFocus, {capture: true, passive: true});
    return () => {
      undoFocusRef.current = null;
      document.removeEventListener('focusin', releaseFocus);
      document.removeEventListener('pointerdown', releaseFocus, true);
      document.removeEventListener('wheel', releaseFocus, true);
    };
  }, []);
  const undoRemoval = useCallback((trigger: HTMLButtonElement): void => {
    const current = currentRef.current;
    const request: UndoFocus | null = document.activeElement === trigger
      ? {scope: current.scope, key: current.focusKey, trigger, restoredIds: null, started: false} : null;
    undoFocusRef.current = request;
    void current.removal.undo().then(restoredIds => {
      if (request === null || !ownsUndoFocus(request)) return;
      request.restoredIds = restoredIds;
      setUndoFocusVersion(version => version + 1);
    });
  }, [ownsUndoFocus]);
  useEffect(() => {
    const request = undoFocusRef.current;
    if (request === null) return;
    if (!ownsUndoFocus(request) || request.restoredIds?.length === 0) {
      undoFocusRef.current = null;
      if (request.started) pendingFocusId.current = null;
      return;
    }
    if (request.started || request.restoredIds === null) return;
    const restored = new Set(request.restoredIds);
    const index = items.findIndex(item => restored.has(item.id));
    if (index < 0 || (virtualize && !virtualizerReady)) return;
    request.started = true;
    focusRow(index, () => ownsUndoFocus(request));
  }, [items, scope, focusKey, undoFocusVersion, virtualize, virtualizerReady, focusRow, ownsUndoFocus]);
  // Idle rows receive one stable action object. Live scopes and data are read at
  // the moment of an action rather than captured by a previous render.
  const rowActions = useMemo<LibraryRowActions>(() => ({
    register(id, element) {
      if (element !== null) {rowRefs.current.set(id, element); return;}
      const row = rowRefs.current.get(id);
      if (row?.parentElement?.contains(document.activeElement) && pendingFocusId.current === null) {
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) listBodyRef.current?.focus({preventScroll: true});
        });
      }
      rowRefs.current.delete(id);
    },
    focus: setFocusedId,
    navigate(id, key) {
      const list = currentRef.current.items;
      const index = list.findIndex(item => item.id === id);
      const next = key === 'ArrowDown' ? Math.min(list.length - 1, index + 1)
        : key === 'ArrowUp' ? Math.max(0, index - 1) : key === 'Home' ? 0 : key === 'End' ? list.length - 1 : null;
      if (next === null) return false;
      focusRow(next); return true;
    },
    open(id) {
      const current = currentRef.current;
      const previous = current.items.findIndex(item => item.id === current.literature.selectedId);
      const next = current.items.findIndex(item => item.id === id);
      const direction = previous < 0 || next < 0 || next === previous ? 0 : next > previous ? 1 : -1;
      if (current.onOpenItem) current.onOpenItem(id, direction); else current.literature.select(id);
    },
    read(id) {currentRef.current.onReadItem?.(id);},
    ask(item) {void currentRef.current.literature.askAssistantAboutItem?.(item);},
    copy(value) {currentRef.current.copy.copy(value);},
    check(id, checked) {
      const current = currentRef.current;
      setSelection(previous => {
        const ids = new Set(previous.scope === current.scope && previous.key === current.selectionKey ? previous.ids : EMPTY_IDS);
        if (checked) ids.add(id); else ids.delete(id);
        return {scope: current.scope, key: current.selectionKey, ids};
      });
    },
    remove(papers) {currentRef.current.removal.remove(papers);},
    menu(item, target, point) {
      const current = currentRef.current;
      menuFocusRef.current = target;
      const bounds = target.getBoundingClientRect();
      setFiltersOpen(false);
      setMenu({scope: current.scope, item, anchor: point ?? {x: bounds.right, y: bounds.bottom}});
    }
  }), [focusRow]);
  const clearSelection = (): void => setSelection({scope, key: selectionKey, ids: EMPTY_IDS});
  const canAsk = writable && literature.projectId !== null && typeof literature.askAssistantAboutItem === 'function';
  const canRemove = writable && literature.projectId !== null && typeof literature.linkItem === 'function';
  const currentMenu = menu?.scope === scope ? menu : null;
  const menuActions: ContextMenuAction[] = currentMenu === null ? [] : [
    {id: 'read', label: '阅读文献', icon: <BookOpen size={14}/>, shortcut: 'Enter',
      disabled: onReadItem === undefined, onSelect: () => {if (isCurrent()) onReadItem?.(currentMenu.item.id);}},
    {id: 'copy', label: '复制引用键', icon: <Copy size={14}/>, shortcut: 'C',
      onSelect: () => {if (isCurrent()) copy.copy(currentMenu.item.bibliography.citationKey);}},
    {id: 'ask', label: '问 AI', icon: <Sparkles size={14}/>, shortcut: 'A', disabled: !canAsk,
      onSelect: () => {if (isCurrent()) void literature.askAssistantAboutItem(currentMenu.item);}},
    {id: 'remove', label: '从当前项目移除', icon: <Unlink size={14}/>, danger: true,
      disabled: !canRemove || removal.pending || !currentMenu.item.projectIds.includes(literature.projectId!),
      onSelect: () => {if (isCurrent()) removal.remove([currentMenu.item]);}},
    ...(writable ? [{id: 'delete', label: '永久删除文献', icon: <Trash2 size={14}/>, danger: true,
      disabled: deletion.pending || removal.pending,
      onSelect: () => {
        if (!isCurrent() || deletionBusy.current || deletionOpenFrame.current !== undefined) return;
        deletion.reset(); setDeleteNotice(null);
        // The closing menu returns focus in a microtask. Open the modal after
        // that handoff so cancel owns focus and its opener is the stable row.
        deletionOpenFrame.current = requestAnimationFrame(() => {
          deletionOpenFrame.current = undefined;
          if (isCurrent()) setDeleteTarget({scope, item: currentMenu.item, cleanupPending: false});
        });
      }}] : [])
  ];
  const ingestFiles = async (files: File[]): Promise<void> => {
    if (!isCurrent() || !writable || literature.projectId === null || ingestionBusy.current === scope) return;
    const pdfs = files.filter(file => /\.pdf$/iu.test(file.name));
    if (pdfs.length === 0) {setIngestion({scope, pending: false, error: '请拖入 PDF 文件。'}); return;}
    ingestionBusy.current = scope; setIngestion({scope, pending: true, error: null});
    try {
      let error: string | null = null;
      for (const file of pdfs) {
        if (!isCurrent()) return;
        const result = await literature.addDroppedPdf(file);
        if (!isCurrent()) return;
        if (!result.ok) error = result.message;
      }
      if (isCurrent()) setIngestion({scope, pending: false, error});
    } catch (caught) {
      if (isCurrent()) setIngestion({scope, pending: false, error: caught instanceof Error ? caught.message : '导入 PDF 失败。'});
    } finally {if (ingestionBusy.current === scope) ingestionBusy.current = null;}
  };
  const unfilteredEmpty = literature.status === 'ready' && literature.items.length === 0 &&
    literature.query.trim().length === 0 && entryType === null && !literature.includeArchived;
  const currentIngestion = ingestion?.scope === scope ? ingestion : null;
  const feedbackError = currentIngestion?.error ?? removal.error ?? copy.error ?? (showActionError ? literature.action.error : null);
  const renderRow = (_index: number, item: ResearchLibraryItem): React.JSX.Element => <LibraryPaperRow item={item}
    selected={item.id === literature.selectedId} selecting={selecting} checked={checkedIds.has(item.id)}
    tabIndex={item.id === tabStopId ? 0 : -1} hasReader={onReadItem !== undefined} canAsk={canAsk && !literature.assistant?.pending}
    requested={requestedIds.has(item.id)} statusSource={literature.documentStatusSource}
    fallbackDocuments={item.id === literature.selectedId ? selectedDocuments : undefined} actions={rowActions}/>;

  return <div className="library-list" data-compact={compact} data-selecting={selecting} data-testid="literature-list"
    onScrollCapture={() => {if (menu !== null) setMenu(null);}}
    onDragEnter={event => {
      if (!event.dataTransfer.types.includes('Files') || !writable || literature.projectId === null) return;
      event.preventDefault(); setDropActive(true);
    }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files') || !writable || literature.projectId === null) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    }}
    onDragLeave={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      // External file drags can report no relatedTarget while crossing a child.
      // Only the list boundary ends the drop affordance.
      if (event.relatedTarget === null) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX >= bounds.left && event.clientX < bounds.right &&
          event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
      }
      setDropActive(false);
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); setDropActive(false);
      void ingestFiles(Array.from(event.dataTransfer.files));
    }}
    onPaste={event => {
      if (!writable || literature.projectId === null || ingestionBusy.current === scope ||
        (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'))) return;
      const match = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/iu.exec(event.clipboardData.getData('text/plain').trim());
      if (match === null) return;
      event.preventDefault(); ingestionBusy.current = scope; setIngestion({scope, pending: true, error: null});
      void literature.importDoi(match[1]!).then(result => {
        if (isCurrent()) setIngestion({scope, pending: false, error: result.ok ? null : result.message});
      }).catch((caught: unknown) => {
        if (isCurrent()) setIngestion({scope, pending: false, error: caught instanceof Error ? caught.message : 'DOI 导入失败。'});
      }).finally(() => {if (ingestionBusy.current === scope) ingestionBusy.current = null;});
    }}>
    <div className="library-list-toolbar" data-testid="literature-list-toolbar" data-empty={unfilteredEmpty}>
      {unfilteredEmpty ? <span className="library-empty-heading">文献库</span> : <>
        <div className="library-state-track">
          <LibraryStatusSegments value={statusGroup} counts={statusCounts} onChange={setStatusGroup}/>
        </div>
        <div className="library-search-row">
          <label className="library-search">
            <Search size={14} aria-hidden="true"/>
            <input type="search" value={searchDraft} aria-label="搜索文献" placeholder="搜索文献"
              data-testid="literature-search"
              onChange={event => {setSearchDraft(event.target.value); literature.setQuery(event.target.value);}}/>
          </label>
          <AnchoredPopover open={filtersOpen} onOpenChange={setFiltersOpen} label="文献筛选"
            testId="literature-filter-popover" renderTrigger={props => <button {...props} type="button"
              className="library-icon-button" aria-label="文献筛选" title="文献筛选"
              aria-pressed={literature.includeArchived || statusGroup !== 'all'} data-testid="literature-filter-toggle">
              <SlidersHorizontal size={14} aria-hidden="true"/>
            </button>}>
            <div className="library-filter-options">
              <div className="library-state-filter">
                <span className="library-filter-label">已加载文献状态</span>
                <LibraryStatusSegments value={statusGroup} counts={statusCounts} onChange={setStatusGroup} inFilter/>
              </div>
              <label className="library-filter-field"><span>已加载结果排序</span>
                <select aria-label="已加载结果排序" value={sort} onChange={event => setSort(event.target.value as SortOrder)}
                  data-testid="literature-sort" className={formSelectClass}>
                  <option value="updated">最近更新</option><option value="year">发表年份</option><option value="title">文献题名</option>
                </select>
              </label>
              <label className="library-filter-option">
                <input type="checkbox" checked={literature.includeArchived}
                  onChange={event => literature.setIncludeArchived(event.target.checked)} data-testid="literature-archived-toggle"/>
                显示已归档
              </label>
              <button type="button" className="library-filter-command" aria-pressed={selecting}
                data-testid="literature-multiselect" onClick={() => {
                  setSelecting(current => !current); clearSelection(); setFiltersOpen(false);
                }}><ListChecks size={14} aria-hidden="true"/>{selecting ? '结束多选' : '多选文献'}</button>
              {selecting ? <label className="library-filter-option">
                <input type="checkbox" checked={items.length > 0 && checkedItems.length === items.length} disabled={items.length === 0}
                  onChange={event => setSelection({scope, key: selectionKey, ids: new Set(event.target.checked ? items.map(item => item.id) : [])})}/>
                选择已加载结果
              </label> : null}
              <button type="button" onClick={() => {literature.reload(); literature.reloadDocumentStatuses?.();}} className="library-filter-command"
                aria-label="重新读取文献库" data-testid="literature-refresh"
                disabled={literature.status === 'loading' || literature.refreshing} aria-busy={literature.status === 'loading' || literature.refreshing}>
                <RefreshCw size={14} aria-hidden="true"/>重新读取文献库
              </button>
            </div>
          </AnchoredPopover>
        </div>
      </>}
      <button type="button" onClick={onRequestImport} disabled={!writable} className="library-import-button"
        aria-label="导入文献" title="导入文献" data-testid="literature-import-open">
        <FilePlus2 size={14} aria-hidden="true"/><span>导入</span>
      </button>
    </div>
    <div ref={listBodyRef} className="library-list-body" data-testid="literature-list-body" role="group"
      aria-label="文献列表导航" tabIndex={-1} onKeyDown={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
        const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, activeIndex + 1)
          : event.key === 'ArrowUp' ? Math.max(0, activeIndex - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next !== null) {event.preventDefault(); focusRow(next);}
      }}>
      {literature.status === 'error' && items.length === 0 ? <EmptyState compact tone="error"
        title={literature.error ?? '读取文献库失败'} action={{label: '重新读取文献库', onClick: literature.reload}}/>
        : literature.status === 'loading' && literature.items.length === 0
          ? <LibraryLoading/>
          : unfilteredEmpty ? <div className="library-empty" data-testid="literature-empty">
            <div className="library-drop-zone" data-testid="literature-drop-zone">
              <FilePlus2 size={24} aria-hidden="true"/><p>{writable ? '拖入 PDF 或粘贴 DOI' : '当前文献库为空'}</p>
            </div>
          </div>
            : items.length === 0 && literature.status === 'ready' ? <EmptyState compact icon={BookOpen}
              title={statusGroup !== 'all' ? '当前状态没有文献'
                : entryType !== null && literature.hasMore ? '已加载文献中没有当前分类'
                  : literature.query.trim().length > 0 ? '没有匹配的文献' : entryType !== null ? '当前分类没有文献' : '尚无文献'}
              action={statusGroup !== 'all' ? {label: '清除状态筛选', onClick: () => setStatusGroup('all')}
                : literature.query.trim().length > 0 ? {label: '清除搜索', onClick: () => literature.setQuery('')} : undefined}
              testId="literature-empty"/>
              : virtualize ? <LazyBoundary fallback={<p role="status" className="p-3 text-muted">正在准备文献列表…</p>}>
                <LazyLibraryVirtualizedRows ref={setVirtualizerRef} items={items} initialIndex={Math.max(0, selectedIndex)}
                  navigationScope={JSON.stringify([literature.projectId, literature.selectedId, literature.query, literature.includeArchived, sort, entryType, statusGroup])}
                  onRangeChanged={setVisibleRange} onNavigationInterrupted={onNavigationInterrupted} renderRow={renderRow}/>
              </LazyBoundary> : <ul aria-label="文献列表" className="library-plain-list">
                {items.map((item, index) => <li key={item.id}>{renderRow(index, item)}</li>)}
              </ul>}
    </div>
    {literature.status === 'ready' ? <div className="library-list-footer">
      <span data-testid="literature-count">已加载 <AnimatedCount value={literature.items.length}/> / <AnimatedCount value={literature.total ?? literature.items.length}/> 条</span>
      {entryType !== null ? <span>当前分类 {items.length.toLocaleString('zh-CN')} 条</span> : null}
      {statusGroup !== 'all' ? <span>已加载文献状态</span> : null}
      {literature.includeArchived ? <span>含已归档</span> : null}
      {literature.hasMore ? <button type="button" className={formSecondaryButtonClass} data-testid="literature-load-more"
        disabled={literature.loadingMore || literature.refreshing} aria-busy={literature.loadingMore} onClick={literature.loadMore}>
        {literature.loadingMore ? '正在加载…' : literature.loadMoreError === null ? '加载更多' : '重试加载'}
      </button> : null}
    </div> : null}
    <div className="library-floating-actions">
      <AnimatePresence initial={false}>
      {selecting && checkedItems.length > 0 ? <LibraryPresence key="bulk"><BulkCitationActions key={checkedItemsKey} items={checkedItems}
        literature={literature} isCurrent={isCurrent} canRemove={canRemove} pendingRemoval={removal.pending}
        onRemove={() => removal.remove(checkedItems)} onClear={clearSelection}/></LibraryPresence> : null}
      {removal.undoCount > 0 ? <LibraryPresence key="undo"><div className="library-undo-toast" data-testid="literature-undo-toast" role="status">
        <span>已移除 {removal.undoCount.toLocaleString('zh-CN')} 篇</span>
        <button type="button" onClick={event => undoRemoval(event.currentTarget)} disabled={removal.pending} data-testid="literature-undo">
          {removal.pending ? '正在恢复…' : '撤销'}
        </button>
        <button type="button" onClick={removal.dismiss} aria-label="关闭撤销提示" className="library-icon-button"><X size={14} aria-hidden="true"/></button>
      </div></LibraryPresence> : null}
      </AnimatePresence>
      {feedbackError === null || feedbackError === undefined ? null : <LibraryPresence key={feedbackError} event="error"><p role="alert" className="library-feedback-error">
        <AlertCircle size={14} aria-hidden="true"/><span>{feedbackError}</span>
      </p></LibraryPresence>}
      {literature.loadMoreError ? <p role="alert" className="library-feedback-error">{literature.loadMoreError}</p> : null}
      {literature.error && (literature.status === 'ready' || items.length > 0)
        ? <div data-testid="literature-refresh-error"><ErrorBar error={{level: 'page', message: literature.error, retry: literature.reload}}/></div> : null}
      {literature.documentStatusesError
        ? <div data-testid="literature-status-error"><ErrorBar error={{level: 'page', message: literature.documentStatusesError,
          retry: literature.reloadDocumentStatuses}}/></div> : null}
      {copy.copied ? <p className="library-ingestion-status" role="status">已复制引用键</p> : null}
      {deleteNotice?.scope === scope ? <p className="library-ingestion-status" role="status">{deleteNotice.message}</p> : null}
      {currentIngestion?.pending ? <p className="library-ingestion-status" role="status"><Loader2 size={14} aria-hidden="true"/>正在导入 PDF / DOI…</p> : null}
    </div>
    {dropActive ? <div className="library-drop-overlay" data-testid="literature-drop-overlay" aria-hidden="true">
      <FilePlus2 size={24}/><span>松开以导入 PDF</span>
    </div> : null}
    <ContextMenu open={currentMenu !== null} onOpenChange={open => {if (!open) setMenu(null);}}
      label="文献操作" anchor={currentMenu?.anchor ?? {x: 0, y: 0}} returnFocusRef={menuFocusRef}
      actions={menuActions} testId="literature-row-menu"/>
    <ConfirmDialog open={currentDelete !== null} title={currentDelete?.cleanupPending ? '文献文件仍待清理' : '永久删除文献'}
      message={currentDelete?.cleanupPending ? '文献已从文献库移除。剩余文件将自动重试清理，也可以立即重试。'
        : `永久删除“${currentDelete ? libraryItemTitle(currentDelete.item) : ''}”${currentDelete?.item.projectIds.length ? `及其在 ${currentDelete.item.projectIds.length} 个项目中的关联` : ''}？`}
      detail={currentDelete?.cleanupPending ? undefined : '此操作会清理 Roc 管理的全文、解析结果、索引、衍生 Wiki 内容及关联阅读笔记和批注，无法撤销。'}
      confirmLabel={currentDelete?.cleanupPending ? '重试清理' : '永久删除'} cancelLabel={currentDelete?.cleanupPending ? '关闭' : '取消'}
      tone={currentDelete?.cleanupPending ? 'default' : 'destructive'} pending={deletion.pending} error={deletion.error}
      onConfirm={confirmDelete} onCancel={() => setDeleteTarget(null)} testId="literature-delete-confirm"/>
  </div>;
}

function LibraryStatusSegments({value, counts, onChange, inFilter = false}: {
  value: LibraryStatusGroup;
  counts: Record<LibraryStatusGroup, number>;
  onChange: (value: LibraryStatusGroup) => void;
  inFilter?: boolean;
}): React.JSX.Element {
  const indicatorId = useId();
  const groups = STATUS_GROUPS.filter(group => group === 'all' || counts[group] > 0);
  return <div className="library-status-segments" role="radiogroup" aria-label="已加载文献状态">
    {groups.map(group => <button key={group} type="button" role="radio" aria-checked={value === group}
      tabIndex={value === group || (!groups.includes(value) && group === 'all') ? 0 : -1}
      data-testid={`literature-status-${inFilter ? 'filter-' : ''}${group}`} title={`${STATUS_LABELS[group]} ${counts[group].toLocaleString('zh-CN')} 篇`}
      onClick={() => onChange(group)} onKeyDown={event => {
        const index = groups.indexOf(group);
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % groups.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + groups.length - 1) % groups.length : null;
        if (next === null) return;
        event.preventDefault(); onChange(groups[next]!);
        const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons?.[next]?.focus();
      }}>{value === group ? <SelectionIndicator layoutId={`library-status-${indicatorId}`}
        className="library-status-indicator" testId={`literature-status-indicator-${inFilter ? 'filter' : 'toolbar'}`}/> : null}
        <span className="library-status-label">{STATUS_LABELS[group]}</span></button>)}
  </div>;
}

function BulkCitationActions({items, literature, isCurrent, canRemove, pendingRemoval, onRemove, onClear}: {
  items: ResearchLibraryItem[]; literature: LiteratureStore; isCurrent: () => boolean;
  canRemove: boolean; pendingRemoval: boolean; onRemove: () => void; onClear: () => void;
}): React.JSX.Element {
  const present = useIsPresent();
  const {copied, error, copy} = useCopyFeedback();
  const mounted = useRef(false);
  useEffect(() => {mounted.current = present; return () => {mounted.current = false;};}, [present]);
  const exportAction = useAsyncAction(() => literature.client.api.research.exportBibliography({
    ids: items.map(item => item.id), format: 'bibtex'
  }), {label: '导出引用'});
  return <div className="library-bulk-pill" data-testid="literature-bulk-actions">
    <span role="status" className="library-bulk-count">{copied ? '已复制' : `已选 ${items.length.toLocaleString('zh-CN')} 篇`}</span>
    <ActionButton variant="compact" disabled={exportAction.pending}
      onClick={() => copy(items.map(item => item.bibliography.citationKey).join(','))}>复制引用键</ActionButton>
    <ActionButton variant="compact" loading={exportAction.pending} loadingLabel="正在导出…"
      onClick={() => {
        if (!isCurrent()) return;
        void exportAction.run().then(result => {if (mounted.current && isCurrent() && result.ok) copy(result.data.content);});
      }}><Copy size={14} aria-hidden="true"/>复制 BibTeX</ActionButton>
    {canRemove ? <button type="button" className="library-bulk-remove" disabled={pendingRemoval}
      data-testid="literature-bulk-remove" onClick={onRemove}><Unlink size={14} aria-hidden="true"/><span>移除</span></button> : null}
    <button type="button" className="library-icon-button" onClick={onClear} aria-label="清除选择" data-testid="literature-bulk-clear">
      <X size={14} aria-hidden="true"/>
    </button>
    {error === null && exportAction.error === null ? null : <p role="alert" className="library-bulk-error">{error ?? exportAction.error}</p>}
  </div>;
}
