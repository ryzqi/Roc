import { useVisiblePolling } from '../shared/view-activity';
import type {ResearchWikiSnapshot} from '../../shared/schemas/research-wiki';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ResearchBibliographyFormat,
  ResearchClaim,
  ResearchDocument,
  ResearchDocumentContent,
  ResearchDocumentRun,
  ResearchEvidence,
  ResearchLibraryItem,
  ResearchLiterature,
  ResearchParseTier
} from '../../shared/types';
import { useAsyncResource, type AsyncStatus } from '../app/use-async-resource';
import { useDebouncedValue } from '../app/use-debounced-value';
import type { IpcLikeResult } from '../app/loaded-state';
import { runIpcAction } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import {
  archiveLibraryItem,
  cancelDocumentParse,
  captureEvidence,
  exportBibliography,
  getDocumentContent,
  importBibliographyFile,
  importDocument,
  importLibraryRecord,
  linkLibraryItem,
  listDocuments,
  parseDocument,
  parseDocuments,
  setLibraryCitationKey,
  upsertKnowledgeDocument,
  writeWorkspaceText
} from './library-store';
import { buildLiteratureAssistantPrompt, documentImportFallback, libraryItemTitle } from './format';
import type { ImportTabRequest } from './hub-route';
import {requestReadingChange} from './reading-interactions';
import {useLibraryPages} from './use-library-pages';
import {useLibraryDocumentStatuses, type LibraryDocumentStatus, type LibraryDocumentStatusSource} from './use-library-document-statuses';

/**
 * The one literature store, created once in `AppShell` and shared by the sidebar's
 * 文献 tab and the canvas 文献 view (T5.1).
 *
 * Sharing matters more than it looks: if each surface owned its own copy, then
 * importing a paper in the canvas would leave the sidebar showing the old list,
 * and selecting an item in one place would not select it in the other — the exact
 * "two states, one truth" drift the phase takes as its acceptance criterion. The
 * store therefore owns list + selection + the import/parse actions, and both
 * surfaces render from it.
 *
 * Contract discipline encoded here (F16):
 *
 *   - the library query is **server-side** (`library.list` takes `query`), so the
 *     typing latency is a debounce on the *IPC key*, not a client-side filter;
 *   - every write passes back the `revision` it read (archive / citation key are
 *     optimistic-concurrency calls);
 *   - parse progress comes from `document.runs` real statuses, and is polled only
 *     while something is actually parsing.
 */

/** Typing debounce before the server-side library query is re-issued. */
const LIBRARY_QUERY_DEBOUNCE_MS = 250;

/** Poll interval while at least one document of the selected item is parsing. */
const PARSE_POLL_INTERVAL_MS = 1_200;

export type LiteratureImportOutcome =
  | { ok: true; createdCount: number; duplicateCount: number; documentId?: string; libraryItemId?: string }
  | { ok: false; message: string };

export type LiteratureActionState = {
  pending: boolean;
  error: string | null;
};

/**
 * State of the reader's 「问助手」 action.
 *
 * `threadId` is the shell's cue: the store starts a **real** run through
 * `chat.startRun` (the same call the composer makes), and once a thread exists the
 * shell selects it and opens the panel — which then finds the running run through
 * P4's `getActiveRun` + event replay. Keeping the run here rather than in the view
 * means the shell owns navigation while the store owns the IPC call.
 */
export type LiteratureAssistantState = {
  pending: boolean;
  error: string | null;
  threadId: string | null;
};

export type LiteratureStore = {
  client: RocClient;
  projectId: string | null;
  writable: boolean;
  status: AsyncStatus;
  error: string | null;
  items: ResearchLibraryItem[];
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  loadMoreError: string | null;
  loadMore: () => void;
  query: string;
  setQuery: (next: string) => void;
  includeArchived: boolean;
  setIncludeArchived: (next: boolean) => void;
  reload: () => void;
  selectedId: string | null;
  selectedStatus: AsyncStatus;
  selectedError: string | null;
  reloadSelected: () => void;
  selected: ResearchLibraryItem | null;
  /** The optional continuation lets the shell accept its route before committing selection. */
  select: (id: string | null, whenReady?: (commitSelection: () => void) => void) => void;
  action: LiteratureActionState;
  clearActionError: () => void;
  archiveItem: (item: ResearchLibraryItem, archived: boolean) => Promise<boolean>;
  setCitationKey: (item: ResearchLibraryItem, citationKey: string) => Promise<boolean>;
  linkItem: (item: ResearchLibraryItem, linked: boolean) => Promise<boolean>;
  importDoi: (doi: string) => Promise<LiteratureImportOutcome>;
  importBibliographyFile: (sourcePath: string, format: ResearchBibliographyFormat) => Promise<LiteratureImportOutcome>;
  importRecord: (record: ResearchLiterature, citationKey: string) => Promise<LiteratureImportOutcome>;
  documents: ResearchDocument[];
  documentsStatus: AsyncStatus;
  documentsError: string | null;
  reloadDocuments: () => void;
  documentStatuses: ReadonlyMap<string, LibraryDocumentStatus>;
  documentStatusSource: LibraryDocumentStatusSource;
  documentStatusesStatus: AsyncStatus;
  documentStatusesError: string | null;
  reloadDocumentStatuses: () => void;
  parsingDocumentIds: ReadonlySet<string>;
  addPdfToNewItem: (input: {
    sourcePath: string;
    title: string;
    citationKey: string;
    metadataMode?: 'automatic' | 'provided';
  }) => Promise<LiteratureImportOutcome>;
  addDroppedPdf: (file: File) => Promise<LiteratureImportOutcome>;
  addPdfToItem: (input: { sourcePath: string; libraryItemId: string; parseAutomatically?: boolean }) => Promise<LiteratureImportOutcome>;
  startParse: (documentId: string, tier?: ResearchParseTier | null) => Promise<boolean>;
  /**
   * 批量重解析（提案 §8.5）：用户换了解析模型/档位后，显式把待重解析的文档一次性重跑。
   * `documentIds` 传 null 表示“全部待重解析的”，由后端枚举，不在前端拼一份会过期的列表。
   * 返回失败项而不是整体失败：一篇坏文件不该让其余文档也跟着不解析。
   */
  startParseMany: (input: { documentIds: string[] | null; tier: ResearchParseTier | null }) => Promise<{ ok: number; failed: number } | null>;
  /**
   * The document whose parse this store started and has not seen finish.
   *
   * Needed because `document.parse` is a long backend job that the renderer does
   * **not** await: the reader must show 「解析中」 (and offer 取消) while it runs, and
   * the backend only reports `status: 'parsing'` after a document re-read — this
   * field keeps the poll alive across that gap instead of leaving a dead button.
   */
  parseInFlight: string | null;
  cancelParse: (input: { documentId: string; parseId: string }) => Promise<boolean>;
  loadDocumentContent: (request: Parameters<RocClient['api']['research']['getDocumentContent']>[0]) => Promise<IpcLikeResult<DocumentContentResult>>;
  /**
   * Captures the chunk behind a retrieval hit as evidence.
   *
   * `chunkId` is mandatory in the contract (B15), so this is only reachable from a
   * RAG hit — never from arbitrary text or a paragraph.
   */
  captureChunkEvidence: (chunkId: string) => Promise<boolean>;
  /** Saves a retrieval hit as a knowledge document so it is retrievable later. */
  saveKnowledgeNote: (input: {
    title: string;
    content: string;
    locator: string | null;
    sourceId: string;
  }) => Promise<boolean>;
  /**
   * `library.export` serialization.
   *
   * Returns the content; there is no save-as dialog on this path (F16), so the
   * caller copies it or writes it with `writeToWorkspace`.
   */
  exportItem: (
    item: ResearchLibraryItem,
    format: ResearchBibliographyFormat
  ) => Promise<{ filename: string; content: string } | null>;
  /** Writes text into the **bound workspace** and returns the relative path used. */
  writeToWorkspace: (input: { relativePath: string; content: string }) => Promise<string | null>;
  /** State of the reader's 「问助手」 run (see `LiteratureAssistantState`). */
  assistant: LiteratureAssistantState;
  /**
   * Hands an instruction to the research assistant, in the current project.
   *
   * One entry point, because three surfaces do it: the reader asks about the selected
   * paper, the knowledge base asks about a concept, and the graph asks about a node.
   * Each writing its own `chat.startRun` would be three places to keep `mode`, the
   * capability list and the thread-adoption contract in agreement.
   */
  askAssistant: (prompt: string) => Promise<void>;
  /** Starts a real `chat.startRun` for the selected paper. */
  askAssistantAboutSelected: () => Promise<void>;
  askAssistantAboutItem: (item: ResearchLibraryItem) => Promise<void>;
  /** Called by the shell once it has adopted `assistant.threadId`. */
  adoptAssistantThread: () => void;
  /**
   * Claims + evidence for the current project, or `null` while unloaded.
   *
   * They live in the store rather than in the derived views because **three**
   * consumers need the same snapshot: the wiki projection, the graph projection,
   * and the ⌘K 概念 group. Fetching them per consumer would let the palette
   * disagree with the panel behind it.
   */
  claims: ResearchClaim[] | null;
  evidence: ResearchEvidence[] | null;
  wikiSnapshot: ResearchWikiSnapshot | null;
  derivedStatus: AsyncStatus;
  derivedError: string | null;
  reloadDerived: () => void;
  /**
   * The pending request to open the import dialog; zero means already consumed.
   *
   * The dialog lives in the canvas hub, but the 文献 tab in the sidebar has its own
   * 导入 button, and both surfaces share this store. Monotonic request IDs let the
   * hub acknowledge each request without consuming a newer one. Consumption lives
   * here so remounting the hub cannot replay a dialog the user already closed.
   */
  importRequestId: number;
  importRequestTab: ImportTabRequest;
  requestImport: (tab?: ImportTabRequest) => void;
  consumeImportRequest: (id: number) => void;
};

type DocumentContentResult = { run: ResearchDocumentRun; content: ResearchDocumentContent };

export function useLiteratureStore(client: RocClient, projectId: string | null, writable = true): LiteratureStore {
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const debouncedQuery = useDebouncedValue(query, LIBRARY_QUERY_DEBOUNCE_MS);
  const [selection, setSelection] = useState<{projectId: string | null; id: string | null}>({projectId, id: null});
  const selectedId = selection.projectId === projectId ? selection.id : null;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectionRequest = useRef(0);
  const scopeRef = useRef({client, projectId, writable});
  if (scopeRef.current.client !== client || scopeRef.current.projectId !== projectId || scopeRef.current.writable !== writable) {
    scopeRef.current = {client, projectId, writable};
  }
  const scope = scopeRef.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; selectionRequest.current++;};
  }, []);
  const [pending, setPending] = useState(false);
  const actionCounts = useRef(new Map<typeof scope, number>());
  const [parseState, setParseState] = useState<{scope: typeof scope; ids: ReadonlySet<string>}>({scope, ids: new Set()});
  const parseIds = parseState.scope === scope ? parseState.ids : new Set<string>();
  const parseRequests = useRef(new Map<string, {scope: typeof scope; promise: Promise<boolean>}>());
  const doiRequests = useRef(new Map<string, string>());
  const [importRequest, setImportRequest] = useState<{ id: number; tab: ImportTabRequest; pending: boolean }>({ id: 0, tab: 'document', pending: false });
  const consumeImportRequest = useCallback((id: number): void => {
    setImportRequest(current => current.id === id && current.pending ? {...current, pending: false} : current);
  }, []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assistantPending, setAssistantPending] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  const assistantBusy = useRef<typeof scope | null>(null);
  useEffect(() => {
    setPending(false); setActionError(null);
    setAssistantPending(false); setAssistantError(null); setAssistantThreadId(null);
  }, [scope]);

  const list = useLibraryPages(client, projectId, debouncedQuery, includeArchived, query !== debouncedQuery);
  const items = list.items;
  const statusIds = useMemo(() => items.map(item => item.id), [items]);
  const documentStatuses = useLibraryDocumentStatuses(client, projectId, statusIds);

  const select = useCallback((id: string | null, whenReady?: (commitSelection: () => void) => void): void => {
    if (!mounted.current || scopeRef.current !== scope) return;
    const revision = ++selectionRequest.current;
    if (id === selectedIdRef.current && whenReady === undefined) return;
    requestReadingChange(projectId ?? '', () => {
      if (!mounted.current || scopeRef.current !== scope || revision !== selectionRequest.current) return;
      const commitSelection = (): void => {
        if (!mounted.current || scopeRef.current !== scope || revision !== selectionRequest.current) return;
        selectedIdRef.current = id;
        setSelection({projectId, id});
      };
      if (whenReady) whenReady(commitSelection);
      else commitSelection();
    });
  }, [projectId, scope]);

  const listedSelection = useMemo(() => items.find(item => item.id === selectedId) ?? null, [items, selectedId]);
  const selectedResource = useAsyncResource(
    projectId === null || selectedId === null || listedSelection !== null ? null : `literature-item:${projectId}:${selectedId}`,
    () => client.api.research.getLibraryItem({id: selectedId ?? ''}),
    {label: '读取选中文献'}
  );
  const selected = listedSelection ?? selectedResource.data;
  const documentsKey = projectId === null || selectedId === null ? null : `literature-docs:${projectId}:${selectedId}`;
  const documents = useAsyncResource(
    documentsKey,
    () => listDocuments(client, selectedId ?? ''),
    { label: '读取文献文档' }
  );
  const parseInFlight = documents.data?.find(document => parseIds.has(document.id))?.id ?? null;

  /**
   * Claims + evidence for the whole project.
   *
   * Keyed on the project (not on the sub-view): switching to 知识库 / 图谱 must
   * not re-fetch what the previous sub-view already had, and the ⌘K 概念 group
   * reads the same snapshot. Both lists are small (ids, titles, locators).
   */
  const derived = useAsyncResource(
    projectId === null ? null : `literature-derived:${projectId}`,
    () => client.api.research.wikiSnapshot({projectId: projectId ?? ''}),
    { label: '读取主张与证据' }
  );

  const evidence = useMemo(() => derived.data?.sources.map(source => source.evidence) ?? null, [derived.data]);
  const reloadDerived = derived.reload;
  // Relation reviews and source replacements may happen in another window.
  useVisiblePolling(reloadDerived, 5000, projectId !== null);
  useEffect(() => {
    if (projectId === null) return;
    const refresh = () => { if (document.visibilityState === 'visible') reloadDerived(); };
    const unsubscribe = client.api.research.onLibraryChanged(event => {
      if (event.affectedProjectIds.includes(projectId)) refresh();
    });
    window.addEventListener('focus', refresh);
    return () => { unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [client, projectId, reloadDerived]);

  const reloadDocuments = documents.reload;
  const reloadList = list.reload;

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      documentStatuses.reload();
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; reloadList(); }, 100);
    };
    const unsubscribe = client.api.research.onLibraryChanged((event) => {
      if (projectId === null || event.affectedProjectIds.includes(projectId)) refresh();
    });
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, projectId, reloadList, documentStatuses.reload]);

  /**
   * Polls while a parse is in flight.
   *
   * `document.parse` is a long backend job with no push channel, so the only
   * honest way to show progress is to re-read the documents. The interval exists
   * only while something is actually parsing, so an idle panel costs nothing —
   * and a hidden/minimized window releases the interval until it becomes visible.
   *
   * `parseInFlight` is part of the condition on purpose: `parse` does not return
   * until the backend job finishes, so between the click and the next document
   * re-read the row still says `imported`. Keying only on the loaded rows would
   * stop the poll before it ever saw `parsing` — the 「解析中」/取消 state would be
   * unreachable exactly when it matters.
   */
  const parsing = parseIds.size > 0 || (documents.data ?? []).some(document => document.status === 'parsing');
  useVisiblePolling(reloadDocuments, PARSE_POLL_INTERVAL_MS, parsing);
  const processingStatuses = [...documentStatuses.items.values()].some(item => item.documents.some(document =>
    document.status === 'parsing' || document.indexStatus === 'queued' || document.indexStatus === 'running'));
  useVisiblePolling(documentStatuses.reload, PARSE_POLL_INTERVAL_MS, parsing || processingStatuses);

  const runAction = useCallback(
    async <Result,>(run: () => Promise<IpcLikeResult<Result>>, write = true): Promise<Result | null> => {
      if (!mounted.current || scopeRef.current !== scope) return null;
      if (write && !scope.writable) {
        actionErrorRef.current = '当前项目只读，无法修改文献。';
        setActionError(actionErrorRef.current);
        return null;
      }
      actionCounts.current.set(scope, (actionCounts.current.get(scope) ?? 0) + 1);
      setPending(true);
      setActionError(null);
      // Written **before** the await: import wrappers read this ref in the same
      // tick as the failure, before React commits the state update.
      actionErrorRef.current = null;
      try {
        const result = await runIpcAction(run);
        if (!mounted.current || scopeRef.current !== scope) return null;
        if (!result.ok) {
          actionErrorRef.current = result.error;
          setActionError(result.error);
          return null;
        }
        return result.data;
      } finally {
        const remaining = (actionCounts.current.get(scope) ?? 1) - 1;
        if (remaining === 0) actionCounts.current.delete(scope);
        else actionCounts.current.set(scope, remaining);
        if (mounted.current && scopeRef.current === scope) setPending(remaining > 0);
      }
    },
    [scope]
  );

  const toOutcome = (result: { createdCount: number; duplicateCount: number } | null): LiteratureImportOutcome =>
    result === null ? { ok: false, message: actionErrorRef.current ?? '导入失败' } : { ok: true, ...result };

  // `runAction` stores the backend message in state; this mirror lets the
  // import wrappers read it back synchronously (state would still be stale in
  // the same tick) so a failed import can return its own message without adding
  // a second error channel to keep in sync.
  const actionErrorRef = useRef<string | null>(null);
  actionErrorRef.current = actionError;

  const archiveItem = useCallback(
    async (item: ResearchLibraryItem, archived: boolean): Promise<boolean> => {
      const updated = await runAction(() =>
        archiveLibraryItem(client, { id: item.id, expectedRevision: item.revision, archived })
      );
      if (updated !== null) {
        reloadList();
      }
      return updated !== null;
    },
    [client, reloadList, runAction]
  );

  const setCitationKey = useCallback(
    async (item: ResearchLibraryItem, citationKey: string): Promise<boolean> => {
      const updated = await runAction(() =>
        setLibraryCitationKey(client, { id: item.id, expectedRevision: item.revision, citationKey })
      );
      if (updated !== null) {
        reloadList();
      }
      return updated !== null;
    },
    [client, reloadList, runAction]
  );

  const linkItem = useCallback(
    async (item: ResearchLibraryItem, linked: boolean): Promise<boolean> => {
      if (!mounted.current || scopeRef.current !== scope) return false;
      if (projectId === null) {
        setActionError('尚未进入项目，无法关联文献。');
        return false;
      }
      const updated = await runAction(() => linkLibraryItem(client, { id: item.id, projectId, linked }));
      if (updated !== null) {
        reloadList();
      }
      return updated !== null;
    },
    [client, projectId, reloadList, runAction, scope]
  );

  const importDoi = useCallback(
    async (doi: string): Promise<LiteratureImportOutcome> => {
      const key = JSON.stringify([projectId, doi.toLowerCase()]);
      let requestId = doiRequests.current.get(key);
      if (requestId === undefined) {requestId = crypto.randomUUID(); doiRequests.current.set(key, requestId);}
      const result = await runAction(() => client.api.research.addLiterature({
        projectId, requestId, destination: projectId === null ? 'library_only' : 'current_project',
        ingestionPolicy: 'fulltext_auto', entries: [{kind: 'doi', doi}]
      }));
      if (result !== null) {
        reloadList();
        // Only an observed terminal receipt ends this intent; unknown IPC failures keep its id.
        // A late caller sharing the old id must not release a newer intent's request.
        if (result.status !== 'queued' && result.status !== 'running' && doiRequests.current.get(key) === requestId) {
          doiRequests.current.delete(key);
        }
        const {counts} = result;
        if (counts.failed + counts.cancelled + counts.skippedArchived + counts.notProcessed > 0) {
          return {ok: false, message: counts.skippedArchived > 0
            ? '文献已归档，请先恢复后再加入。' : '文献导入未完成，请重试。'};
        }
        return {ok: true, createdCount: counts.created + counts.linked, duplicateCount: counts.alreadyPresent};
      }
      return {ok: false, message: actionErrorRef.current ?? 'DOI 导入失败'};
    },
    [client, projectId, reloadList, runAction]
  );

  const importBibliographyFileAction = useCallback(
    async (sourcePath: string, format: ResearchBibliographyFormat): Promise<LiteratureImportOutcome> => {
      const result = await runAction(() => importBibliographyFile(client, { sourcePath, format, projectId }));
      if (result !== null) {
        reloadList();
      }
      return toOutcome(result);
    },
    [client, projectId, reloadList, runAction]
  );

  const importRecord = useCallback(
    async (record: ResearchLiterature, citationKey: string): Promise<LiteratureImportOutcome> => {
      const result = await runAction(() => importLibraryRecord(client, { record, citationKey, projectId }));
      if (result !== null) {
        reloadList();
      }
      return toOutcome(result);
    },
    [client, projectId, reloadList, runAction]
  );

  /**
   * Starts the parse **without** blocking the reader on it.
   *
   * `document.parse` is a single long IPC call (the worker runs for minutes) and it
   * resolves with the document once the job ends — success or failure. Awaiting it
   * in the UI would freeze the reader on a disabled button with no progress and no
   * way to cancel, which is exactly the fake-progress-free promise T5.3 makes. So
   * the call is fired, `parseInFlight` keeps the poll alive, the backend's own
   * `status: 'parsing'` takes over, and the final state arrives via a document
   * re-read.
   */
  const startParse = useCallback(
    async (documentId: string, tier: ResearchParseTier | null = null): Promise<boolean> => {
      if (!mounted.current || scopeRef.current !== scope || !scope.writable) return false;
      const existing = parseRequests.current.get(documentId);
      if (existing?.scope === scope) return existing.promise;
      setParseState(current => ({scope, ids: new Set([...(current.scope === scope ? current.ids : []), documentId])}));
      setActionError(null);
      const settled = parseDocument(client, documentId, tier)
        .then((result) => {
          if (!mounted.current || scopeRef.current !== scope) return false;
          if (!result.ok) {
            setActionError(result.error.message);
            return false;
          }
          if (result.data.id !== documentId) {setActionError('解析返回的文档与请求不一致。'); return false;}
          if (result.data.status === 'failed' || result.data.status === 'cancelled') {
            setActionError(result.data.error ?? (result.data.status === 'failed' ? '全文解析失败，请重试。' : '全文解析已取消。'));
            return false;
          }
          return result.data.status === 'ready' && result.data.currentParseId !== null;
        })
        .catch((error: unknown) => {
          if (mounted.current && scopeRef.current === scope) setActionError(error instanceof Error ? error.message : String(error));
          return false;
        })
        .finally(() => {
          if (parseRequests.current.get(documentId)?.promise === settled) parseRequests.current.delete(documentId);
          if (!mounted.current || scopeRef.current !== scope) return;
          setParseState(current => {
            if (current.scope !== scope) return current;
            const ids = new Set(current.ids); ids.delete(documentId);
            return {scope, ids};
          });
          reloadDocuments(); reloadList(); documentStatuses.reload();
        });
      parseRequests.current.set(documentId, {scope, promise: settled});
      // One immediate re-read so a backend that already marked the run running is
      // reflected without waiting a whole poll interval.
      reloadDocuments();
      return await settled;
    },
    [client, reloadDocuments, reloadList, documentStatuses.reload, scope]
  );

  const acceptDocument = useCallback((document: ResearchDocument, parseAutomatically = true): LiteratureImportOutcome => {
    reloadList(); reloadDocuments(); documentStatuses.reload();
    // Reimporting an already parsed source reuses its receipt. Imported/failed
    // sources start the default backend pipeline without holding the import UI.
    if (parseAutomatically && document.status !== 'parsing' && !(document.status === 'ready' && document.currentParseId !== null)) {
      void startParse(document.id);
    }
    return {ok: true, createdCount: 1, duplicateCount: 0, documentId: document.id, libraryItemId: document.libraryItemId};
  }, [reloadList, reloadDocuments, documentStatuses.reload, startParse]);

  const addPdfToNewItem = useCallback(async (input: {
    sourcePath: string; title: string; citationKey: string; metadataMode?: 'automatic' | 'provided';
  }): Promise<LiteratureImportOutcome> => {
    const document = await runAction(() => importDocument(client, {target: 'new-item', ...input, projectId}));
    return document === null ? {ok: false, message: actionErrorRef.current ?? '导入 PDF 失败'} : acceptDocument(document);
  }, [client, projectId, runAction, acceptDocument]);

  const addPdfToItem = useCallback(async (input: {sourcePath: string; libraryItemId: string; parseAutomatically?: boolean}): Promise<LiteratureImportOutcome> => {
    if (projectId === null) return {ok: false, message: '尚未进入项目，无法导入 PDF。'};
    const document = await runAction(() => importDocument(client, {
      target: 'library-item', sourcePath: input.sourcePath, libraryItemId: input.libraryItemId, projectId
    }));
    if (document !== null && document.libraryItemId !== input.libraryItemId) {
      setActionError('导入返回的文献与请求不一致。');
      return {ok: false, message: '导入返回的文献与请求不一致。'};
    }
    return document === null ? {ok: false, message: actionErrorRef.current ?? '导入 PDF 失败'} : acceptDocument(document, input.parseAutomatically);
  }, [client, projectId, runAction, acceptDocument]);

  const addDroppedPdf = useCallback(async (file: File): Promise<LiteratureImportOutcome> => {
    if (!/\.pdf$/iu.test(file.name)) return {ok: false, message: '请拖入 PDF 文件。'};
    const bridge = window.rocPdfDrop;
    if (bridge === undefined) return {ok: false, message: '文件拖放暂不可用，请使用导入按钮选择 PDF。'};
    const document = await runAction(() => bridge.importPdf(file, {
      ...documentImportFallback(file.name), projectId, metadataMode: 'automatic'
    }));
    return document === null ? {ok: false, message: actionErrorRef.current ?? '导入 PDF 失败'} : acceptDocument(document);
  }, [projectId, runAction, acceptDocument]);

  const cancelParseAction = useCallback(
    async (input: { documentId: string; parseId: string }): Promise<boolean> => {
      const document = await runAction(() => cancelDocumentParse(client, input));
      if (document === null) {
        return false;
      }
      reloadDocuments();
      return true;
    },
    [client, reloadDocuments, runAction]
  );

  /**
   * 批量重解析。与 `startParse` 不同，这里**等待**整批结束：批量是一次显式操作，
   * 用户要的是一份“成功 N 篇、失败 M 篇”的交代，而不是又一个看不见进度的按钮。
   * 单篇的错误不抛出去——后端已经逐篇隔离，这里只统计。
   */
  const startParseMany = useCallback(
    async (input: { documentIds: string[] | null; tier: ResearchParseTier | null }) => {
      if (!mounted.current || scopeRef.current !== scope || !scope.writable) return null;
      setActionError(null);
      try {
        const result = await parseDocuments(client, input);
        if (!mounted.current || scopeRef.current !== scope) return null;
        if (!result.ok) {
          setActionError(result.error.message);
          return null;
        }
        if (result.data.failed.length > 0) {
          setActionError(`${result.data.failed.length} 篇解析失败：${result.data.failed[0].error}`);
        }
        return { ok: result.data.documents.length, failed: result.data.failed.length };
      } catch (error: unknown) {
        if (mounted.current && scopeRef.current === scope) setActionError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        if (mounted.current && scopeRef.current === scope) reloadDocuments();
      }
    },
    [client, reloadDocuments, scope]
  );

  const loadDocumentContent = useCallback(
    async (request: Parameters<RocClient['api']['research']['getDocumentContent']>[0]) => await getDocumentContent(client, request),
    [client]
  );

  /**
   * Captures a retrieval hit's chunk as evidence.
   *
   * Refreshes the derived snapshot on success so the 知识库 / 图谱 panels and the
   * ⌘K 概念 group see the new evidence without a manual reload — they all read
   * `derived`, which is why the evidence list lives in this store at all.
   */
  const captureChunkEvidence = useCallback(
    async (chunkId: string): Promise<boolean> => {
      if (projectId === null) {
        setActionError('尚未进入项目，无法捕获证据。');
        return false;
      }
      const captured = await runAction(() => captureEvidence(client, { projectId, chunkId }));
      if (captured === null) {
        return false;
      }
      derived.reload();
      return true;
    },
    [client, derived, projectId, runAction]
  );

  /**
   * Saves a retrieval hit as a knowledge document (`knowledge.upsert`).
   *
   * The id is derived from the source chunk so that "save the same hit twice" is
   * an update rather than a second document — the backend replaces chunks for the
   * same id, and an id with a random suffix would silently duplicate the content
   * into the index.
   */
  const saveKnowledgeNote = useCallback(
    async (input: { title: string; content: string; locator: string | null; sourceId: string }): Promise<boolean> => {
      const saved = await runAction(() =>
        upsertKnowledgeDocument(client, {
          id: `note:${input.sourceId}`,
          projectId,
          sourceType: 'note',
          sourceId: input.sourceId,
          title: input.title,
          content: input.content,
          chunks: [{ content: input.content, locator: input.locator }],
          embeddingConfigId: null
        })
      );
      return saved !== null;
    },
    [client, projectId, runAction]
  );

  const exportItem = useCallback(
    async (
      item: ResearchLibraryItem,
      format: ResearchBibliographyFormat
    ): Promise<{ filename: string; content: string } | null> => {
      const exported = await runAction(() => exportBibliography(client, { ids: [item.id], format }), false);
      if (exported === null) {
        return null;
      }
      return { filename: exported.filename, content: exported.content };
    },
    [client, runAction]
  );

  const writeToWorkspace = useCallback(
    async (input: { relativePath: string; content: string }): Promise<string | null> => {
      const written = await runAction(() =>
        writeWorkspaceText(client, { ...input, source: 'literature-export' })
      );
      return written === null ? null : written.relativePath;
    },
    [client, runAction]
  );

  /**
   * Hands an instruction to the research assistant.
   *
   * The workspace is deliberately left to the backend: with `researchProjectId`
   * set, the agent resolves the project's own directory (and ignores a renderer
   * supplied path), so passing one from here could only ever disagree with the
   * project record.
   */
  const askAssistant = useCallback(
    async (prompt: string): Promise<void> => {
      if (!mounted.current || scopeRef.current !== scope || !scope.writable || assistantBusy.current === scope) return;
      if (projectId === null) {
        setAssistantError('先进入一个研究项目，助手才拿得到项目工具与工作目录。');
        return;
      }
      assistantBusy.current = scope;
      setAssistantPending(true);
      setAssistantError(null);
      try {
        const result = await client.api.chat.startRun({
          input: prompt,
          mode: 'chat',
          enabledCapabilities: { mcpServers: [], skills: [] },
          researchProjectId: projectId
        });
        if (!mounted.current || scopeRef.current !== scope) return;
        if (!result.ok) {
          setAssistantError(result.error.message);
          return;
        }
        setAssistantThreadId(result.data.threadId);
      } catch (error) {
        if (mounted.current && scopeRef.current === scope) setAssistantError(error instanceof Error ? error.message : String(error));
      } finally {
        if (assistantBusy.current === scope) assistantBusy.current = null;
        if (mounted.current && scopeRef.current === scope) setAssistantPending(false);
      }
    },
    [client, projectId, scope]
  );

  /**
   * Starts a real assistant run about the selected paper.
   *
   * The prompt names the item and, when one exists, the parsed document, so the agent
   * reads the same paper the reader is showing instead of guessing from the title.
   */
  const askAssistantAboutSelected = useCallback(async (): Promise<void> => {
    if (selected === null) {
      setAssistantError('先进入项目并选一条文献。');
      return;
    }
    const activeDocument = (documents.data ?? [])[0] ?? null;
    await askAssistant(
      buildLiteratureAssistantPrompt({
        title: libraryItemTitle(selected),
        authors: selected.metadata.authors,
        year: selected.metadata.publishedYear,
        citationKey: selected.bibliography.citationKey,
        libraryItemId: selected.id,
        documentId: activeDocument?.id ?? null
      })
    );
  }, [askAssistant, documents.data, selected]);

  const askAssistantAboutItem = useCallback(async (item: ResearchLibraryItem): Promise<void> => {
    if (!mounted.current || scopeRef.current !== scope || projectId === null || !item.projectIds.includes(projectId)) return;
    const activeDocument = item.id === selectedId ? documents.data?.[0] ?? null : null;
    await askAssistant(buildLiteratureAssistantPrompt({
      title: libraryItemTitle(item), authors: item.metadata.authors, year: item.metadata.publishedYear,
      citationKey: item.bibliography.citationKey, libraryItemId: item.id, documentId: activeDocument?.id ?? null
    }));
  }, [askAssistant, documents.data, selectedId, projectId, scope]);

  return {
    client,
    projectId,
    writable,
    status: list.status,
    error: list.error,
    items,
    total: list.total,
    hasMore: list.hasMore,
    loadingMore: list.loadingMore,
    refreshing: list.refreshing,
    loadMoreError: list.loadMoreError,
    loadMore: list.loadMore,
    query,
    setQuery,
    includeArchived,
    setIncludeArchived,
    reload: reloadList,
    selectedId,
    selected,
    selectedStatus: listedSelection !== null ? 'ready' : selectedResource.status,
    selectedError: selectedResource.error,
    reloadSelected: selectedResource.reload,
    select,
    action: { pending, error: actionError },
    clearActionError: () => setActionError(null),
    archiveItem,
    setCitationKey,
    linkItem,
    importDoi,
    importBibliographyFile: importBibliographyFileAction,
    importRecord,
    documents: documents.data ?? [],
    documentsStatus: documents.status,
    documentsError: documents.error,
    reloadDocuments,
    documentStatuses: documentStatuses.items,
    documentStatusSource: documentStatuses.source,
    documentStatusesStatus: documentStatuses.status,
    documentStatusesError: documentStatuses.error,
    reloadDocumentStatuses: documentStatuses.reload,
    parsingDocumentIds: parseIds,
    claims: derived.data?.claims ?? null,
    evidence,
    wikiSnapshot: derived.data,
    derivedStatus: derived.status,
    derivedError: derived.error,
    reloadDerived: derived.reload,
    importRequestId: importRequest.pending ? importRequest.id : 0,
    importRequestTab: importRequest.tab,
    requestImport: (tab = 'document') => setImportRequest(current => ({ id: current.id + 1, tab, pending: true })),
    consumeImportRequest,
    addPdfToNewItem,
    addPdfToItem,
    addDroppedPdf,
    startParse,
    startParseMany,
    cancelParse: cancelParseAction,
    loadDocumentContent,
    parseInFlight,
    captureChunkEvidence,
    saveKnowledgeNote,
    exportItem,
    writeToWorkspace,
    assistant: { pending: assistantPending, error: assistantError, threadId: assistantThreadId },
    askAssistant,
    askAssistantAboutSelected,
    askAssistantAboutItem,
    adoptAssistantThread: () => setAssistantThreadId(null)
  };
}
