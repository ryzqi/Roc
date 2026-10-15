import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ResearchBibliographyFormat,
  ResearchDocument,
  ResearchDocumentContent,
  ResearchDocumentRun,
  ResearchLibraryItem,
  ResearchLiterature
} from '../../shared/types';
import { useAsyncResource, type AsyncStatus } from '../app/use-async-resource';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import {
  archiveLibraryItem,
  cancelDocumentParse,
  getDocumentContent,
  importBibliographyFile,
  importDocument,
  importLibraryDoi,
  importLibraryRecord,
  linkLibraryItem,
  listDocumentParses,
  listDocuments,
  listLibrary,
  parseDocument,
  setLibraryCitationKey
} from './library-store';

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
  | { ok: true; createdCount: number; duplicateCount: number }
  | { ok: false; message: string };

export type LiteratureActionState = {
  pending: boolean;
  error: string | null;
};

export type LiteratureStore = {
  client: RocClient;
  projectId: string | null;
  status: AsyncStatus;
  error: string | null;
  items: ResearchLibraryItem[];
  query: string;
  setQuery: (next: string) => void;
  includeArchived: boolean;
  setIncludeArchived: (next: boolean) => void;
  reload: () => void;
  selectedId: string | null;
  selected: ResearchLibraryItem | null;
  select: (id: string | null) => void;
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
  addPdfToNewItem: (input: {
    sourcePath: string;
    title: string;
    citationKey: string;
  }) => Promise<LiteratureImportOutcome>;
  addPdfToItem: (input: { sourcePath: string; libraryItemId: string }) => Promise<LiteratureImportOutcome>;
  startParse: (documentId: string) => Promise<boolean>;
  cancelParse: (input: { documentId: string; parseId: string }) => Promise<boolean>;
  loadDocumentContent: (documentId: string) => Promise<IpcLikeResult<DocumentContentResult>>;
};

type DocumentContentResult = { run: ResearchDocumentRun; content: ResearchDocumentContent };

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * `library.list` needs all four fields, and the backend rejects a `limit` above
 * 500 — so the page size is a named constant rather than a magic number at the
 * call site. Paging beyond this is deliberately not built: when the list is
 * truncated the UI says so instead of silently dropping rows.
 */
const LIBRARY_PAGE_LIMIT = 200;

export function useLiteratureStore(client: RocClient, projectId: string | null): LiteratureStore {
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const debouncedQuery = useDebouncedValue(query, LIBRARY_QUERY_DEBOUNCE_MS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const listKey = projectId === null ? null : `literature:${projectId}:${debouncedQuery}:${includeArchived ? '1' : '0'}`;
  const list = useAsyncResource(
    listKey,
    () =>
      listLibrary(client, {
        projectId,
        query: debouncedQuery,
        includeArchived,
        limit: LIBRARY_PAGE_LIMIT
      }),
    { label: '读取文献库' }
  );
  const items = useMemo(() => list.data ?? [], [list.data]);

  // A different project is a different library: drop the selection rather than
  // showing an item that the new project may not even contain.
  useEffect(() => {
    setSelectedId(null);
  }, [projectId]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const documentsKey = selectedId === null ? null : `literature-docs:${selectedId}`;
  const documents = useAsyncResource(
    documentsKey,
    () => listDocuments(client, selectedId ?? ''),
    { label: '读取文献文档' }
  );

  const reloadDocuments = documents.reload;
  const reloadList = list.reload;

  /**
   * Polls while a parse is in flight.
   *
   * `document.parse` is a long backend job with no push channel, so the only
   * honest way to show progress is to re-read the documents. The interval exists
   * only while `status === 'parsing'`, so an idle panel costs nothing — and a
   * hidden window stops polling because the effect is tied to the React tree.
   */
  const parsingDocumentIds = useMemo(
    () => (documents.data ?? []).filter((document) => document.status === 'parsing').map((document) => document.id),
    [documents.data]
  );
  // Joined into a string so the effect below depends on *which* documents are
  // parsing, not on the array identity that every poll recreates.
  const parsingSignature = parsingDocumentIds.join(',');
  useEffect(() => {
    if (parsingSignature.length === 0) {
      return;
    }
    const handle = window.setInterval(() => {
      reloadDocuments();
    }, PARSE_POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [parsingSignature, reloadDocuments]);

  const runAction = useCallback(
    async <Result,>(run: () => Promise<IpcLikeResult<Result>>): Promise<Result | null> => {
      setPending(true);
      setActionError(null);
      try {
        const result = await run();
        if (!result.ok) {
          setActionError(result.error.message);
          return null;
        }
        return result.data;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setPending(false);
      }
    },
    []
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
    [client, projectId, reloadList, runAction]
  );

  const importDoi = useCallback(
    async (doi: string): Promise<LiteratureImportOutcome> => {
      const result = await runAction(() => importLibraryDoi(client, { doi, projectId }));
      if (result !== null) {
        reloadList();
      }
      return toOutcome(result);
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

  const addPdfToNewItem = useCallback(
    async (input: { sourcePath: string; title: string; citationKey: string }): Promise<LiteratureImportOutcome> => {
      const document = await runAction(() =>
        importDocument(client, { target: 'new-item', ...input, projectId })
      );
      if (document === null) {
        return { ok: false, message: actionErrorRef.current ?? '导入 PDF 失败' };
      }
      reloadList();
      return { ok: true, createdCount: 1, duplicateCount: 0 };
    },
    [client, projectId, reloadList, runAction]
  );

  const addPdfToItem = useCallback(
    async (input: { sourcePath: string; libraryItemId: string }): Promise<LiteratureImportOutcome> => {
      if (projectId === null) {
        setActionError('尚未进入项目，无法导入 PDF。');
        return { ok: false, message: '尚未进入项目，无法导入 PDF。' };
      }
      const document = await runAction(() =>
        importDocument(client, { target: 'library-item', ...input, projectId })
      );
      if (document === null) {
        return { ok: false, message: actionErrorRef.current ?? '导入 PDF 失败' };
      }
      reloadList();
      reloadDocuments();
      return { ok: true, createdCount: 1, duplicateCount: 0 };
    },
    [client, projectId, reloadDocuments, reloadList, runAction]
  );

  const startParse = useCallback(
    async (documentId: string): Promise<boolean> => {
      const document = await runAction(() => parseDocument(client, documentId));
      if (document === null) {
        return false;
      }
      reloadDocuments();
      return true;
    },
    [client, reloadDocuments, runAction]
  );

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

  const loadDocumentContent = useCallback(
    async (documentId: string) => await getDocumentContentForLatestParse(client, documentId),
    [client]
  );

  return {
    client,
    projectId,
    status: list.status,
    error: list.error,
    items,
    query,
    setQuery,
    includeArchived,
    setIncludeArchived,
    reload: reloadList,
    selectedId,
    selected,
    select: setSelectedId,
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
    addPdfToNewItem,
    addPdfToItem,
    startParse,
    cancelParse: cancelParseAction,
    loadDocumentContent
  };
}

/**
 * Reads the content of the document's latest finished parse.
 *
 * `document.content` needs a `parseId`, and the document row only carries
 * `currentParseId` / `activeParseId` — neither of which is guaranteed to be a
 * *finished* parse. So the parse list is read and the newest `ready` run is
 * chosen; when there is none, this returns the backend's "no content" outcome
 * rather than requesting a run that cannot answer.
 */
export async function getDocumentContentForLatestParse(
  client: RocClient,
  documentId: string
): Promise<IpcLikeResult<DocumentContentResult>> {
  const runs = await listDocumentParses(client, documentId);
  if (!runs.ok) {
    return runs;
  }
  const ready = runs.data.filter((run) => run.status === 'ready');
  const latest = ready.at(-1);
  if (latest === undefined) {
    return { ok: false, error: { message: '这篇文献还没有解析完成的内容。', code: 'document_parse_missing' } };
  }
  return getDocumentContent(client, { documentId, parseId: latest.id });
}
