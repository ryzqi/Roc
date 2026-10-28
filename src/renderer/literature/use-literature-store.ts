import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
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
import { IpcResourceError, unwrapIpcResource } from '../app/ipc-resource';
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
  importLibraryDoi,
  importLibraryRecord,
  linkLibraryItem,
  listClaims,
  listDocumentParses,
  listDocuments,
  listEvidence,
  listLibrary,
  parseDocument,
  parseDocuments,
  setLibraryCitationKey,
  upsertKnowledgeDocument,
  writeWorkspaceText
} from './library-store';
import { buildLiteratureAssistantPrompt, libraryItemTitle } from './format';

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
  loadDocumentContent: (documentId: string) => Promise<IpcLikeResult<DocumentContentResult>>;
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
  derivedStatus: AsyncStatus;
  derivedError: string | null;
  reloadDerived: () => void;
  /**
   * A request to open the import dialog, as a monotonic counter.
   *
   * The dialog lives in the canvas hub, but the 文献 tab in the sidebar has its own
   * 导入 button, and both surfaces share this store. A counter (rather than a
   * boolean) lets the hub react to *every* request, including two in a row, without
   * the sidebar having to know anything about the hub's internal state.
   */
  importRequestId: number;
  requestImport: () => void;
};

type DocumentContentResult = { run: ResearchDocumentRun; content: ResearchDocumentContent };

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
  const [parseInFlight, setParseInFlight] = useState<string | null>(null);
  const [importRequestId, setImportRequestId] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assistantPending, setAssistantPending] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);

  const listKey = projectId === null ? null : [
    'research',
    'library',
    projectId,
    debouncedQuery,
    includeArchived,
    LIBRARY_PAGE_LIMIT
  ] as const;
  const list = useSWR<ResearchLibraryItem[], IpcResourceError>(
    listKey,
    async () => unwrapIpcResource(await listLibrary(client, {
      projectId: projectId ?? '',
      query: debouncedQuery,
      includeArchived,
      limit: LIBRARY_PAGE_LIMIT
    })),
    { keepPreviousData: false, shouldRetryOnError: false }
  );
  let listStatus: AsyncStatus;
  if (list.isValidating) {
    listStatus = 'loading';
  } else if (list.error !== undefined) {
    listStatus = 'error';
  } else if (list.data !== undefined) {
    listStatus = 'ready';
  } else {
    listStatus = 'idle';
  }
  const listError = list.isValidating ? null : list.error?.message ?? null;
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

  /**
   * Claims + evidence for the whole project.
   *
   * Keyed on the project (not on the sub-view): switching to 知识库 / 图谱 must
   * not re-fetch what the previous sub-view already had, and the ⌘K 概念 group
   * reads the same snapshot. Both lists are small (ids, titles, locators).
   */
  const derived = useAsyncResource(
    projectId === null ? null : `literature-derived:${projectId}`,
    async (): Promise<IpcLikeResult<{ claims: ResearchClaim[]; evidence: ResearchEvidence[] }>> => {
      const [claims, evidence] = await Promise.all([
        listClaims(client, { projectId: projectId ?? '' }),
        listEvidence(client, projectId ?? '')
      ]);
      if (!claims.ok) {
        return { ok: false, error: claims.error };
      }
      if (!evidence.ok) {
        return { ok: false, error: evidence.error };
      }
      return { ok: true, data: { claims: claims.data, evidence: evidence.data } };
    },
    { label: '读取主张与证据' }
  );

  const reloadDocuments = documents.reload;
  const reloadList = useCallback(() => {
    if (projectId !== null) {
      void list.mutate().catch(() => undefined);
    }
  }, [list.mutate, projectId]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
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
  }, [client, projectId, reloadList]);

  /**
   * Polls while a parse is in flight.
   *
   * `document.parse` is a long backend job with no push channel, so the only
   * honest way to show progress is to re-read the documents. The interval exists
   * only while something is actually parsing, so an idle panel costs nothing —
   * and a hidden window stops polling because the effect is tied to the React
   * tree.
   *
   * `parseInFlight` is part of the condition on purpose: `parse` does not return
   * until the backend job finishes, so between the click and the next document
   * re-read the row still says `imported`. Keying only on the loaded rows would
   * stop the poll before it ever saw `parsing` — the 「解析中」/取消 state would be
   * unreachable exactly when it matters.
   */
  const parsingDocumentIds = useMemo(
    () => (documents.data ?? []).filter((document) => document.status === 'parsing').map((document) => document.id),
    [documents.data]
  );
  // Joined into a string so the effect below depends on *which* documents are
  // parsing, not on the array identity that every poll recreates.
  const parsingSignature = [parseInFlight ?? '', ...parsingDocumentIds].join(',');
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
      // Written **before** the await: import wrappers read this ref in the same
      // tick as the failure, before React commits the state update.
      actionErrorRef.current = null;
      try {
        const result = await runIpcAction(run);
        if (!result.ok) {
          actionErrorRef.current = result.error;
          setActionError(result.error);
          return null;
        }
        return result.data;
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
      setParseInFlight(documentId);
      setActionError(null);
      const settled = parseDocument(client, documentId, tier)
        .then((result) => {
          if (!result.ok) {
            setActionError(result.error.message);
            return false;
          }
          return true;
        })
        .catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : String(error));
          return false;
        })
        .finally(() => {
          setParseInFlight((current) => (current === documentId ? null : current));
          reloadDocuments();
        });
      // One immediate re-read so a backend that already marked the run running is
      // reflected without waiting a whole poll interval.
      reloadDocuments();
      return await settled;
    },
    [client, reloadDocuments]
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

  /**
   * 批量重解析。与 `startParse` 不同，这里**等待**整批结束：批量是一次显式操作，
   * 用户要的是一份“成功 N 篇、失败 M 篇”的交代，而不是又一个看不见进度的按钮。
   * 单篇的错误不抛出去——后端已经逐篇隔离，这里只统计。
   */
  const startParseMany = useCallback(
    async (input: { documentIds: string[] | null; tier: ResearchParseTier | null }) => {
      setActionError(null);
      try {
        const result = await parseDocuments(client, input);
        if (!result.ok) {
          setActionError(result.error.message);
          return null;
        }
        if (result.data.failed.length > 0) {
          setActionError(`${result.data.failed.length} 篇解析失败：${result.data.failed[0].error}`);
        }
        return { ok: result.data.documents.length, failed: result.data.failed.length };
      } catch (error: unknown) {
        setActionError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        reloadDocuments();
      }
    },
    [client, reloadDocuments]
  );

  const loadDocumentContent = useCallback(
    async (documentId: string) => await getDocumentContentForLatestParse(client, documentId),
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
      const exported = await runAction(() => exportBibliography(client, { ids: [item.id], format }));
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
      if (projectId === null) {
        setAssistantError('先进入一个研究项目，助手才拿得到项目工具与工作目录。');
        return;
      }
      setAssistantPending(true);
      setAssistantError(null);
      try {
        const result = await client.api.chat.startRun({
          input: prompt,
          mode: 'chat',
          enabledCapabilities: { mcpServers: [], skills: [] },
          researchProjectId: projectId
        });
        if (!result.ok) {
          setAssistantError(result.error.message);
          return;
        }
        setAssistantThreadId(result.data.threadId);
      } catch (error) {
        setAssistantError(error instanceof Error ? error.message : String(error));
      } finally {
        setAssistantPending(false);
      }
    },
    [client, projectId]
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

  return {
    client,
    projectId,
    status: listStatus,
    error: listError,
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
    claims: derived.data?.claims ?? null,
    evidence: derived.data?.evidence ?? null,
    derivedStatus: derived.status,
    derivedError: derived.error,
    reloadDerived: derived.reload,
    importRequestId,
    requestImport: () => setImportRequestId((current) => current + 1),
    addPdfToNewItem,
    addPdfToItem,
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
    adoptAssistantThread: () => setAssistantThreadId(null)
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
