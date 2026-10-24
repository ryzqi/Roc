import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, ClipboardCopy, Download, FileSearch, Loader2, Pencil, Save, Sparkles, Square, Timer, Type, X } from 'lucide-react';
import type { ResearchDocument, ResearchDocumentContent, ResearchDocumentRun, ResearchParseTier } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import { useWorkspaceScope } from '../app/workspace-scope';
import { useAsyncResource } from '../app/use-async-resource';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { countParsedBlocks, parseDocumentBlocks, type ParsedBlockKind } from './parse-blocks';
import { deriveCitationKey, formatDoi, isCitationKeyValid } from './format';
import { downloadModels, getModelsStatus } from '../shared/research-models-store';
import type { LiteratureStore } from './use-literature-store';

const TIER_OPTIONS: ReadonlyArray<{ value: ResearchParseTier; label: string; title: string }> = [
  { value: 'basic', label: 'Basic', title: '本地小模型：版面/表格/公式，速度快，不需要 VLM 权重' },
  { value: 'standard', label: 'Standard', title: 'Basic + llama.cpp VLM 逐块理解，需要额外下载 VLM 权重' },
  { value: 'advanced', label: 'Advanced', title: '复用 Standard 权重，更高的 VLM 预算' },
  { value: 'flash', label: 'Flash', title: '只跑 HTML 快速路径；扫描件仍需要小模型' }
];

/** The paper reader (P5/T5.4).
 *
 * Scope, stated honestly: this renders what the contract can actually deliver —
 * metadata from the library record, and the parse's `blocks` (heading / paragraph /
 * table / formula / figure **as text**, each with its `locator`). It does **not**
 * draw figures or embed the original PDF, because the source bytes and assets are
 * not reachable from the renderer (no registered IPC method — B16). The footer says
 * so instead of leaving an empty box that reads as a broken image.
 *
 * Parse progress is the backend's own `document.runs` statuses; the contract has no
 * stage names, so none are invented. The legacy `MINERU_PIPELINE_STAGES` progression
 * is gone — it used to advance on a timer, which is exactly the fake progress this
 * phase is supposed to delete.
 *
 * Two entry points, both real:
 *   - the parse blocks, rendered in order;
 *   - `focusLocator`, set when the user arrives from a retrieval hit. The contract
 *     gives a hit a `locator` string and gives blocks their own `locator`, so the
 *     jump is a **text match** on that field: it either finds a block and scrolls to
 *     it, or reports that it could not (never a silent no-op).
 *
 * The header actions are the contract's own operations, each one named where it
 * lands: `library.export` returns content (there is no save-as dialog — F16), so
 * copying goes to the clipboard and writing goes through `files.writeText` into the
 * bound workspace, and the message says which relative path was used.
 *
 * ## The one control that is not a backend call: the text size
 *
 * The toolbar ends with a 字号 toggle (标准 / 大号) that swaps the article's own type
 * size. It is the reader's only *reading* control — every other button in that row is
 * an IPC call — and reading a parsed paper is the one thing a researcher does here for
 * a long time.
 *
 * The button is labelled by the action (「大号」 while the text is standard) and the
 * two sizes are tokens (`--font-read-size` / `--font-read-large-size`), so the
 * scale stays in one place rather than becoming a magic number in this file. The
 * choice is component state: leaving the reader resets it, and nothing about a paper's
 * text size belongs in the project record.
 */

export type PaperReaderProps = {
  literature: LiteratureStore;
  loadDocumentContent: (documentId: string) => Promise<IpcLikeResult<{ run: ResearchDocumentRun; content: ResearchDocumentContent }>>;
  openInFilesView: (relativePath: string) => void;
  /** Deep link from a retrieval hit: the **parse** the hit came from (`document:<parseId>`). */
  focusParseId?: string | null;
  /** Deep link from a retrieval hit: the locator to scroll to. */
  focusLocator?: string | null;
};

const STATUS_LABELS: Readonly<Record<ResearchDocument['status'], string>> = {
  imported: '已导入，尚未解析',
  parsing: '解析中',
  ready: '解析完成',
  failed: '解析失败',
  cancelled: '解析已取消'
};

const BLOCK_STYLES: Readonly<Record<ParsedBlockKind, string>> = {
  heading: 'text-ink font-medium',
  paragraph: 'text-ink',
  table: 'font-mono text-muted',
  formula: 'font-mono text-ink',
  figure: 'text-muted'
};

export function PaperReader({
  literature,
  loadDocumentContent,
  openInFilesView,
  focusParseId = null,
  focusLocator = null
}: PaperReaderProps): React.JSX.Element {
  const selected = literature.selected;
  const documents = literature.documents;
  const scope = useWorkspaceScope();
  const copy = useCopyFeedback();
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [content, setContent] = useState<ResearchDocumentContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  /** Reader text size (the 字号 toggle). State, not persisted: see the header. */
  const [largeText, setLargeText] = useState(false);
  /**
   * 解析档位（`document.parse` 的 `tier`）。
   *
   * 默认 `basic`：它不需要 VLM 权重，是唯一“只下了小模型也能成功”的档位。
   * 选 `standard`/`advanced` 但没有 GGUF 权重时，worker 会明确失败而不是自动降档——
   * 这正是验收要求的「不自动切换档位」，所以这里也不做任何静默回退。
   */
  const [parseTier, setParseTier] = useState<ResearchParseTier>('basic');
  /** 批量重解析的进行中状态：null = 没在跑；否则是这一批结束后的成/败计数。 */
  const [reparsePending, setReparsePending] = useState<{ ok: number; failed: number } | null>(null);
  const jumpHandledFor = useRef<string | null>(null);

  /**
   * 还没有解析结果的文档数，决定「重解析待处理文档」是否出现。
   *
   * 只看本文献下的文档：批量入口放在阅读器里，作用域就必须和用户眼前看到的一致，
   * 否则一个「重解析（3）」会去动用户没在看的文献。`imported`/`failed` 才算待处理，
   * `parsing` 的正在跑，不该被再排一次队。
   */
  const pendingReparseCount = documents.filter(
    (document) => document.status === 'imported' || document.status === 'failed'
  ).length;
  const startReparseAll = useCallback(async () => {
    const documentIds = documents
      .filter((document) => document.status === 'imported' || document.status === 'failed')
      .map((document) => document.id);
    if (documentIds.length === 0) return;
    setReparsePending({ ok: 0, failed: 0 });
    const outcome = await literature.startParseMany({ documentIds, tier: parseTier });
    setReparsePending(outcome);
    // 结果留在按钮上而不是弹窗：批量是这次点击的直接交代，用户不需要再关一个框。
    if (outcome !== null) window.setTimeout(() => setReparsePending(null), 6_000);
    else setReparsePending(null);
  }, [documents, literature, parseTier]);

  /**
   * Parse-model state (`research.models.status`).
   *
   * Read here rather than in the store because only this panel gates an action on
   * it, and it is two `stat` calls in main (no hashing), so a reader mount is a
   * cheap place to ask.
   */
  const models = useAsyncResource('research-models', () => getModelsStatus(literature.client), {
    label: '读取解析模型状态'
  });
  const modelsDownloading = downloadPending || models.data?.downloading === true;
  const reloadModels = models.reload;

  /**
   * Polls while a download is running.
   *
   * `models.download` resolves only when every model is installed (hundreds of MB),
   * so awaiting it in the click handler would freeze the button with no progress;
   * the backend's `downloading` flag is the progress channel and this is what reads
   * it. The interval exists only while something is downloading.
   */
  useEffect(() => {
    if (!modelsDownloading) {
      return;
    }
    const handle = window.setInterval(reloadModels, 2_500);
    return () => window.clearInterval(handle);
  }, [modelsDownloading, reloadModels]);

  // Follow the selection, but never render one document's content under another
  // document's header: a selection change clears the content immediately.
  // A retrieval hit names the **parse** it came from (`document:<parseId>`), not a
  // document id, so the target document is the one whose `currentParseId` /
  // `activeParseId` equals it. An item can hold several documents, and falling back
  // to `documents[0]` would open the wrong one — where the hit's locator either
  // misses or, worse, matches an unrelated block that happens to share its text.
  useEffect(() => {
    setContent(null);
    setContentError(null);
    setActiveDocumentId((current) => {
      if (focusParseId !== null) {
        const targeted = documents.find(
          (document) => document.currentParseId === focusParseId || document.activeParseId === focusParseId
        );
        if (targeted !== undefined) {
          return targeted.id;
        }
      }
      if (current !== null && documents.some((document) => document.id === current)) {
        return current;
      }
      return documents[0]?.id ?? null;
    });
  }, [documents, focusParseId, selected?.id]);

  const readyDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId && document.status === 'ready') ?? null,
    [documents, activeDocumentId]
  );

  useEffect(() => {
    if (readyDocument === null) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoadingContent(true);
    setContentError(null);
    void loadDocumentContent(readyDocument.id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setContentError(result.error.message);
          setContent(null);
          return;
        }
        setContent(result.data.content);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingContent(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readyDocument, loadDocumentContent]);

  const counts = useMemo(() => (content === null ? null : countParsedBlocks(content)), [content]);

  /**
   * Jump to the locator from a retrieval hit.
   *
   * Runs once per (document, locator) pair: re-scrolling on every render would
   * fight the user's own scrolling, and a repeated deep link is handled by the ref
   * key rather than by a timer.
   */
  const matchedBlockId = useMemo(() => {
    if (content === null || focusLocator === null) {
      return null;
    }
    const blocks = parseDocumentBlocks(content);
    const exact = blocks.find((block) => block.locator === focusLocator);
    if (exact !== undefined) {
      return exact.id;
    }
    // The hit's locator may be a prefix/heading of the block's own locator (e.g.
    // "section 3" vs "section 3.2"). A substring match is the widest defensible
    // fallback; anything looser would jump to a wrong place silently.
    const loose = blocks.find((block) => block.locator.includes(focusLocator) || focusLocator.includes(block.locator));
    return loose?.id ?? null;
  }, [content, focusLocator]);

  useEffect(() => {
    if (matchedBlockId === null || activeDocumentId === null) {
      return;
    }
    const key = `${activeDocumentId}:${focusLocator ?? ''}`;
    if (jumpHandledFor.current === key) {
      return;
    }
    jumpHandledFor.current = key;
    document
      .querySelector(`[data-block-id="${CSS.escape(matchedBlockId)}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [activeDocumentId, focusLocator, matchedBlockId]);

  if (selected === null) {
    return (
      <EmptyState
        icon={FileSearch}
        title="尚未选择文献"
        testId="reader-no-selection"
      />
    );
  }

  const blocks = content === null ? [] : parseDocumentBlocks(content);
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  // `null` when the record carries no DOI — never a placeholder, and never the
  // bibliography copy when the metadata one is missing (they are equal by contract:
  // `library-repository.import` rejects a mismatch).
  const readerDoi = formatDoi(selected.metadata.doi);

  /**
   * The model row's single source of truth.
   *
   * `canDownload` is false when the backend reported no model directory at all
   * (`models: []`): `models.download` would then throw `research_models_unavailable`,
   * so the button is not offered — a disabled control with a stated reason beats a
   * button that can only fail.
   */
  const modelsState = (() => {
    const status = models.data;
    const modelCount = status?.models.length ?? 0;
    const downloading = downloadPending || status?.downloading === true;
    if (models.status === 'error') {
      return { label: models.error ?? '状态读取失败', ready: false, downloading, modelCount, canDownload: false, tone: 'bad' as const };
    }
    if (status === null) {
      return { label: '读取中…', ready: false, downloading, modelCount, canDownload: false, tone: 'muted' as const };
    }
    if (downloadError !== null) {
      // A failed download must not remove the only retry affordance: the row stays
      // actionable as long as the backend reported a model directory at all.
      return {
        label: `未就绪（${downloadError}）`,
        ready: false,
        downloading,
        modelCount,
        canDownload: modelCount > 0,
        tone: 'bad' as const
      };
    }
    if (downloading) {
      return { label: '下载中', ready: false, downloading, modelCount, canDownload: true, tone: 'muted' as const };
    }
    if (status.ready) {
      return { label: '已就绪', ready: true, downloading, modelCount, canDownload: true, tone: 'muted' as const };
    }
    return {
      label: status.error === null ? '未安装' : `未就绪（${status.error}）`,
      ready: false,
      downloading,
      modelCount,
      canDownload: modelCount > 0,
      tone: modelCount > 0 ? ('muted' as const) : ('bad' as const)
    };
  })();

  /**
   * Starts the model download **without blocking** on it.
   *
   * The poll above turns the backend's `downloading` flag into progress, and the
   * final status arrives through a re-read when the call settles.
   */
  const startModelDownload = (): void => {
    setDownloadError(null);
    setDownloadPending(true);
    void downloadModels(literature.client, { pack: models.data?.selectedPack ?? 'basic', source: models.data?.source ?? 'auto' })
      .then((result) => {
        if (!result.ok) {
          setDownloadError(result.error.message);
        }
      })
      .catch((error: unknown) => {
        setDownloadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setDownloadPending(false);
        reloadModels();
      });
  };

  /**
   * Runs a header action and turns its outcome into the row's single status line.
   *
   * `null` means "the backend already reported why" — `literature.action.error`
   * carries the backend's own message and is rendered by the hub, so repeating it
   * here would be a second copy to keep in sync.
   */
  const runHeaderAction = async (run: () => Promise<string | null>): Promise<void> => {
    setActionBusy(true);
    setActionNote(null);
    try {
      setActionNote(await run());
    } finally {
      setActionBusy(false);
    }
  };

  const copyBibtex = (): void => {
    void runHeaderAction(async () => {
      const exported = await literature.exportItem(selected, 'bibtex');
      if (exported === null) {
        return null;
      }
      copy.copy(exported.content);
      return `已复制 BibTeX（${exported.filename}，${exported.content.length} 字符）`;
    });
  };

  /**
   * There is no save-as dialog on the export path (F16), so the only place an
   * export can land is the bound workspace — and the message says exactly which
   * relative path, with the absolute one the scope knows, rather than "导出成功".
   */
  const exportBibtexToWorkspace = (): void => {
    void runHeaderAction(async () => {
      const exported = await literature.exportItem(selected, 'bibtex');
      if (exported === null) {
        return null;
      }
      const written = await literature.writeToWorkspace({
        relativePath: `literature/${exported.filename}`,
        content: exported.content
      });
      if (written === null) {
        return null;
      }
      return `已写入工作区：${scope.workspacePath ?? '(未绑定工作目录)'}/${written}`;
    });
  };

  const saveCitationKey = (): void => {
    const next = (keyDraft ?? '').trim();
    if (!isCitationKeyValid(next)) {
      setActionNote('引用键含有不支持的字符，请移除空格、逗号、花括号、反斜杠、%、# 或引号。');
      return;
    }
    void runHeaderAction(async () => {
      const ok = await literature.setCitationKey(selected, next);
      if (!ok) {
        return null;
      }
      setKeyDraft(null);
      return `引用 key 已改为 ${next}`;
    });
  };

  const askAssistant = (): void => {
    void runHeaderAction(async () => {
      await literature.askAssistantAboutSelected();
      return null;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="paper-reader" data-library-item={selected.id}>
      <header className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-2">
        <h2 className="text-ink" data-testid="reader-title">
          {selected.metadata.title.trim().length > 0 ? selected.metadata.title : selected.bibliography.title}
        </h2>
        <p className="text-muted text-[var(--font-meta-size)]" data-testid="reader-authors">
          {selected.metadata.authors.length === 0 ? '作者未知' : selected.metadata.authors.join(' · ')}
          {selected.metadata.publishedYear === null ? '' : ` · ${selected.metadata.publishedYear}`}
          {selected.metadata.citationCount === null ? '' : ` · 被引 ${selected.metadata.citationCount}`}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)]">
          <span className="rounded-control border border-line px-1 font-mono text-muted" data-testid="reader-citation-key">
            {selected.bibliography.citationKey}
          </span>
          {readerDoi === null ? null : (
            <span className="text-subtle" data-testid="reader-doi">
              {readerDoi}
            </span>
          )}
          <span className="text-subtle" data-testid="reader-revision">
            revision {selected.revision}
          </span>
          {counts === null ? null : (
            <span className="text-subtle" data-testid="reader-block-counts">
              {counts.total} 块 · 标题 {counts.headings} · 公式 {counts.formulas} · 表格 {counts.tables} · 图 {counts.figures} · 覆盖 {counts.pagesCovered} 页
            </span>
          )}
          {selected.archived ? <span className="text-[var(--st-warn)]">已归档</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="reader-actions">
          <button
            type="button"
            disabled={actionBusy}
            onClick={copyBibtex}
            data-testid="reader-copy-bibtex"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            {copy.copied ? <Check size={11} aria-hidden="true" /> : <ClipboardCopy size={11} aria-hidden="true" />}
            {copy.copied ? '已复制' : '复制 BibTeX'}
          </button>
          <button
            type="button"
            disabled={actionBusy}
            onClick={exportBibtexToWorkspace}
            data-testid="reader-export-bibtex"
            title="library.export 没有另存为对话框，只能写进绑定工作目录"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            <Save size={11} aria-hidden="true" />
            导出 .bib 到工作区
          </button>
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => setKeyDraft(selected.bibliography.citationKey)}
            data-testid="reader-edit-key"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            <Pencil size={11} aria-hidden="true" />
            改引用 key
          </button>
          <button
            type="button"
            disabled={actionBusy || literature.assistant.pending}
            onClick={askAssistant}
            data-testid="reader-ask-assistant"
            title="就这条文献向助手提问"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            {literature.assistant.pending ? (
              <Loader2 size={11} aria-hidden="true" className="animate-spin" />
            ) : (
              <Sparkles size={11} aria-hidden="true" />
            )}
            问助手
          </button>
          <button
            type="button"
            onClick={() => setLargeText((current) => !current)}
            aria-pressed={largeText}
            title={largeText ? '切回标准字号' : '切换到大号字号'}
            data-testid="reader-text-size"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
          >
            <Type size={11} aria-hidden="true" />
            {largeText ? '标准' : '大号'}
          </button>
        </div>
        {keyDraft === null ? null : (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="reader-key-editor">
            <input
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              aria-label="引用 key"
              data-testid="reader-key-input"
              className="h-[var(--control-height-compact)] w-56 rounded-control border border-line bg-surface px-2 font-mono text-ink text-[var(--font-micro-size)]"
            />
            <button
              type="button"
              disabled={actionBusy}
              onClick={saveCitationKey}
              data-testid="reader-key-save"
              className="h-[var(--control-height-compact)] rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setKeyDraft(deriveCitationKey({
                title: selected.metadata.title,
                authors: selected.metadata.authors,
                year: selected.metadata.publishedYear
              }) ?? '')}
              data-testid="reader-key-derive"
              className="h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
            >
              推导
            </button>
            <button
              type="button"
              onClick={() => setKeyDraft(null)}
              data-testid="reader-key-cancel"
              className="flex h-[var(--control-height-compact)] items-center gap-0.5 rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
            >
              <X size={10} aria-hidden="true" />
              取消
            </button>
          </div>
        )}
        {actionNote === null && copy.error === null && literature.assistant.error === null ? null : (
          <p role="status" className="text-muted text-[var(--font-micro-size)]" data-testid="reader-action-note">
            {actionNote ?? copy.error ?? literature.assistant.error}
          </p>
        )}
      </header>

      {documents.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={FileSearch}
            title="这条文献还没有文档"
            testId="reader-no-document"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label="文档" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
            {documents.map((document) => (
              <button
                key={document.id}
                type="button"
                role="tab"
                aria-selected={document.id === activeDocumentId}
                tabIndex={document.id === activeDocumentId ? 0 : -1}
                onClick={() => setActiveDocumentId(document.id)}
                data-testid={`reader-document-tab-${document.id}`}
                className={
                  document.id === activeDocumentId
                    ? 'h-[var(--control-height-compact)] max-w-[16rem] truncate rounded-control border border-line bg-accent-soft px-2 text-ink text-[var(--font-meta-size)]'
                    : 'h-[var(--control-height-compact)] max-w-[16rem] truncate rounded-control border border-transparent px-2 text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] hover:text-ink'
                }
              >
                {document.filename}
              </button>
            ))}
          </div>

          {activeDocument === null ? null : (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[var(--font-meta-size)]">
              <span className="text-muted" data-testid="reader-document-status" data-status={activeDocument.status}>
                {STATUS_LABELS[activeDocument.status]}
              </span>
              {activeDocument.status === 'parsing' ? (
                <>
                  <span className="flex items-center gap-1 text-muted text-[var(--font-micro-size)]">
                    <Loader2 size={11} aria-hidden="true" className="animate-spin" />
                    正在解析文档…
                  </span>
                  <button
                    type="button"
                    disabled={literature.action.pending || activeDocument.activeParseId === null}
                    onClick={() => {
                      const parseId = activeDocument.activeParseId;
                      if (parseId === null) {
                        return;
                      }
                      void literature.cancelParse({ documentId: activeDocument.id, parseId });
                    }}
                    data-testid="reader-cancel-parse"
                    className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-[var(--st-warn)] text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                  >
                    <Square size={11} aria-hidden="true" />
                    取消解析
                  </button>
                </>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-muted" title="解析档位">
                    <span className="sr-only">解析档位</span>
                    <select
                      value={parseTier}
                      disabled={literature.parseInFlight !== null || literature.projectId === null}
                      onChange={(event) => setParseTier(event.target.value as ResearchParseTier)}
                      data-testid="reader-parse-tier"
                      className="h-[var(--control-height-compact)] rounded-control border border-line bg-surface px-1 text-ink text-[var(--font-micro-size)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-40"
                    >
                      {TIER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value} title={option.title}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={literature.parseInFlight !== null || literature.projectId === null}
                    onClick={() => void literature.startParse(activeDocument.id, parseTier)}
                    data-testid="reader-start-parse"
                    className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                  >
                  {literature.parseInFlight === activeDocument.id ? (
                    <Loader2 size={11} aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Download size={11} aria-hidden="true" />
                  )}
                  {literature.parseInFlight === activeDocument.id
                    ? '启动解析…'
                    : activeDocument.status === 'ready'
                      ? '重新解析'
                      : '解析'}
                  </button>
                </>
              )}
              {activeDocument.error === null ? null : (
                <span className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="reader-document-error">
                  {activeDocument.error}
                </span>
              )}
              <button
                type="button"
                onClick={() => openInFilesView(activeDocument.filename)}
                data-testid="reader-open-workspace-file"
                title="在工作区找同名文件"
                className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
              >
                <FileSearch size={11} aria-hidden="true" />
                在工作区找同名文件
              </button>
            </div>
          )}

          {/*
            Parse-model state (T5.3 / R11). Shown next to the document it gates,
            because `document.parse` can only fail here when the models are missing —
            and a disabled button with no reason would read as a broken reader.
            `downloading` is the backend's own flag, so a download started elsewhere
            is reflected here too.
          */}
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-[var(--font-micro-size)]"
            data-testid="reader-models"
          >
            <span
              className={modelsState.tone === 'bad' ? 'text-[var(--st-bad)]' : 'text-muted'}
              data-testid="reader-models-state"
              data-ready={modelsState.ready ? 'true' : 'false'}
              data-downloading={modelsState.downloading ? 'true' : 'false'}
            >
              解析模型：{modelsState.label}
            </span>
            {modelsState.canDownload && !modelsState.ready ? (
              <button
                type="button"
                disabled={modelsState.downloading || downloadPending}
                onClick={startModelDownload}
                data-testid="reader-models-download"
                title="首次使用需下载解析模型，文件较大。"
                className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
              >
                {modelsState.downloading || downloadPending ? (
                  <Loader2 size={10} aria-hidden="true" className="animate-spin" />
                ) : (
                  <Download size={10} aria-hidden="true" />
                )}
                {modelsState.downloading || downloadPending ? '下载中…' : '下载解析模型'}
              </button>
            ) : null}
            {modelsState.modelCount === 0 ? null : (
              <span className="font-mono text-subtle" data-testid="reader-models-count">
                {modelsState.modelCount} 个模型
              </span>
            )}
            {/*
              批量重解析（提案 §8.5）：换了解析模型或档位后，旧的解析结果不再代表「用当前
              模型解析出来的内容」。这是显式操作、不是自动触发——解析要跑分钟级，不能替用户
              决定什么时候占机器。只处理本文献下还没有当前结果的文档，已解析的仍需在单篇上
              显式「重新解析」，避免一次点击把整个库的块全部换代、连带证据引用失效。
            */}
            {pendingReparseCount === 0 && reparsePending === null ? null : (
              <button
                type="button"
                disabled={!modelsState.ready || reparsePending !== null}
                onClick={() => void startReparseAll()}
                data-testid="reader-reparse-pending"
                title="按当前档位重新解析所有还没有解析结果的文档。"
                className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
              >
                {reparsePending === null ? null : <Loader2 size={10} aria-hidden="true" className="animate-spin" />}
                {reparsePending === null
                  ? `重解析待处理文档（${pendingReparseCount}）`
                  : `正在重解析 ${reparsePending.ok + reparsePending.failed}…`}
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="reader-content-area">
            {focusLocator !== null && matchedBlockId === null && content !== null ? (
              <p role="note" className="mb-2 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="reader-jump-missed">
                这次命中带的 locator「{focusLocator}」在解析块里找不到对应位置；下面是解析内容的开头。
              </p>
            ) : null}
            {loadingContent ? (
              <EmptyState tone="loading" icon={Loader2} title="正在读取解析内容…" testId="reader-content-loading" />
            ) : contentError !== null ? (
              <ErrorBar
                error={{ level: 'blocked', message: contentError, actionLabel: '检查文档后重新尝试解析。' }}
              />
            ) : content === null ? (
              activeDocument !== null && activeDocument.status !== 'ready' ? (
                <EmptyState
                  icon={Timer}
                  title="这条文档还没有解析结果"
                  testId="reader-content-missing"
                />
              ) : null
            ) : blocks.length === 0 ? (
              <EmptyState icon={CircleAlert} title="解析结果里没有内容块" testId="reader-content-empty-blocks" />
            ) : (
              <article
                className={
                  largeText
                    ? 'flex flex-col gap-2 text-[var(--font-read-large-size)] leading-[1.7]'
                    : 'flex flex-col gap-2 text-[var(--font-read-size)] leading-[1.65]'
                }
                data-testid="reader-blocks"
                data-text-size={largeText ? 'large' : 'standard'}
              >
                {blocks.map((block) => (
                  <section
                    key={block.id}
                    id={`reader-block-${block.id}`}
                    data-testid={`reader-block-${block.kind}`}
                    data-block-id={block.id}
                    data-locator={block.locator}
                    data-focused={block.id === matchedBlockId ? 'true' : undefined}
                    className={`${BLOCK_STYLES[block.kind]} ${
                      block.id === matchedBlockId ? 'rounded-control bg-[var(--accent-soft)] px-2 py-1' : ''
                    }`}
                  >
                    {block.kind === 'heading' ? (
                      <h3 className="text-ink">{block.text}</h3>
                    ) : block.kind === 'formula' ? (
                      <p className="overflow-x-auto whitespace-pre-wrap rounded-control border border-line bg-bg-soft px-2 py-1">
                        {block.text}
                      </p>
                    ) : (
                      <p className="whitespace-pre-wrap">
                        {block.kind === 'figure' ? <span className="text-subtle">[图] </span> : null}
                        {block.isBlank ? <span className="text-subtle">（空块）</span> : block.text}
                      </p>
                    )}
                    <p className="mt-0.5 font-mono text-subtle text-[var(--font-micro-size)]">
                      {block.label} · {block.locator} · 第 {block.page ?? '?'} 页
                    </p>
                  </section>
                ))}
              </article>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
