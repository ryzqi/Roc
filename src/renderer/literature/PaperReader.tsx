import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, ClipboardCopy, Columns2, Download, FileSearch, Loader2, Pencil, Save, ScanLine, Sparkles, Square, Timer, Type, X } from 'lucide-react';
import type { ResearchDocument, ResearchParseTier } from '../../shared/types';
import { useWorkspaceScope } from '../app/workspace-scope';
import { useAsyncResource } from '../app/use-async-resource';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { countParsedBlocks, parseDocumentBlocks, type ParsedBlockKind } from './parse-blocks';
import { deriveCitationKey, formatDoi, isCitationKeyValid } from './format';
import { downloadModels, getModelsStatus } from '../shared/research-models-store';
import type { LiteratureStore } from './use-literature-store';
import {useReaderDocument} from './use-reader-document';

const PaperPdfView = lazy(() => import('./PaperPdfView'));
const PaperBlockAsset = lazy(() => import('./PaperBlockAsset'));
const ScholarlyRelationsPanel = lazy(() => import('./ScholarlyRelationsPanel'));
const ResearchResourcesPanel = lazy(() => import('./ResearchResourcesPanel'));
const HuggingFacePanel = lazy(() => import('./HuggingFacePanel'));

const TIER_OPTIONS: ReadonlyArray<{ value: ResearchParseTier; label: string; title: string }> = [
  { value: 'compact', label: '轻量', title: 'PP-OCRv6 Tiny + 文档布局和表格识别，约 19 MB' },
  { value: 'complete', label: '完整', title: '轻量解析加公式识别，约 330 MB' }
];

/** The paper reader (P5/T5.4).
 *
 * Scope, stated honestly: this renders what the contract can actually deliver —
 * metadata from the library record, and the parse's `blocks` (heading / paragraph /
 * table / formula / figure **as text**, each with its `locator`). It does **not**
 * render figures as interpreted markup. Original PDFs load only when the user
 * opens the comparison; measured source/parse geometry stays version-bound.
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
 *     jump requires one exact match in the requested parse. Missing or ambiguous
 *     locations are reported without selecting another parse or nearby block.
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
  openInFilesView: (relativePath: string) => void;
  onClearFocus: () => void;
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
  openInFilesView,
  onClearFocus,
  focusParseId = null,
  focusLocator = null
}: PaperReaderProps): React.JSX.Element {
  const selected = literature.selected;
  const documents = literature.documents;
  const scope = useWorkspaceScope();
  const copy = useCopyFeedback();
  const reader = useReaderDocument(literature, focusParseId);
  const activeDocument = reader.document;
  const activeDocumentId = activeDocument?.id ?? null;
  const content = reader.parsed?.content ?? null;
  const contentError = reader.error;
  const loadingContent = reader.loading;
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  /** Reader text size (the 字号 toggle). State, not persisted: see the header. */
  const [largeText, setLargeText] = useState(false);
  const [comparePdf, setComparePdf] = useState(false);
  const [pdfSelection, setPdfSelection] = useState<{parseId: string; blockId: string; locationIndex: number} | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourcesLocked, setResourcesLocked] = useState(false);
  const [huggingFaceOpen, setHuggingFaceOpen] = useState(false);
  const [huggingFaceLocked, setHuggingFaceLocked] = useState(false);
  /**
   * 解析档位（`document.parse` 的 `tier`）。
   *
   * compact 为默认轻量档，complete 加入公式识别。模型缺失时由 worker 明确
   * 返回失败；用户选择的档位不会自动替换。
   */
  const [parseTier, setParseTier] = useState<ResearchParseTier>('compact');
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

  const counts = useMemo(() => (content === null ? null : countParsedBlocks(content)), [content]);
  const selectReaderDocument = (documentId: string): void => {
    onClearFocus();
    reader.selectDocument(documentId);
  };

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
    const matches = blocks.filter(block => block.locator === focusLocator);
    return matches.length === 1 ? matches[0].id : null;
  }, [content, focusLocator]);
  const selectedPdfBlock = pdfSelection !== null && pdfSelection.parseId === reader.parsed?.run.id ? pdfSelection.blockId : matchedBlockId;
  const selectedPdfLocation = pdfSelection !== null && pdfSelection.parseId === reader.parsed?.run.id ? pdfSelection.locationIndex : 0;

  useEffect(() => {
    if (matchedBlockId === null || activeDocumentId === null) {
      return;
    }
    const key = `${activeDocumentId}:${reader.parsed?.run.id}:${focusLocator ?? ''}`;
    if (jumpHandledFor.current === key) {
      return;
    }
    jumpHandledFor.current = key;
    document
      .querySelector(`[data-block-id="${CSS.escape(matchedBlockId)}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [activeDocumentId, focusLocator, matchedBlockId, reader.parsed?.run.id]);

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
    void downloadModels(literature.client, { pack: models.data?.selectedPack ?? 'compact' })
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
        <p className="flex flex-wrap gap-x-2 text-muted text-[var(--font-meta-size)]" data-testid="reader-authors">
          <span>{selected.metadata.authors.length === 0 ? '作者未知' : selected.metadata.authors.join('，')}</span>
          {selected.metadata.publishedYear === null ? null : <span>{selected.metadata.publishedYear}</span>}
          {selected.metadata.citationCount === null ? null : <span>被引 {selected.metadata.citationCount}</span>}
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
            <span className="flex flex-wrap gap-x-2 text-subtle" data-testid="reader-block-counts">
              <span>{counts.total} 块</span><span>标题 {counts.headings}</span><span>公式 {counts.formulas}</span>
              <span>表格 {counts.tables}</span><span>图 {counts.figures}</span><span>覆盖 {counts.pagesCovered} 页</span>
            </span>
          )}
          {selected.archived ? <span className="text-[var(--st-warn)]">已归档</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="reader-actions">
          <button type="button" disabled={literature.projectId === null} aria-expanded={relationsOpen}
            onClick={() => setRelationsOpen(current => !current)} data-testid="reader-scholarly-toggle"
            className="min-h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40">
            学术关系
          </button>
          <button type="button" disabled={literature.projectId === null || resourcesLocked} aria-expanded={resourcesOpen}
            onClick={() => setResourcesOpen(current => !current)} data-testid="reader-resources-toggle"
            className="min-h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40">
            科研资源
          </button>
          <button type="button" disabled={literature.projectId === null || huggingFaceLocked} aria-expanded={huggingFaceOpen}
            onClick={() => setHuggingFaceOpen(current => !current)} data-testid="reader-hf-toggle"
            className="min-h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40">
            Hugging Face
          </button>
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

      {(relationsOpen || resourcesOpen || huggingFaceOpen) && literature.projectId !== null ? <div className="max-h-[55%] shrink-0 overflow-y-auto border-b-[0.5px] border-line">
        {relationsOpen ? <Suspense fallback={<p role="status" className="px-3 py-2 text-muted">载入学术关系</p>}>
          <ScholarlyRelationsPanel key={`${literature.projectId}:${selected.id}`} client={literature.client}
            projectId={literature.projectId} item={selected} writable={scope.writable}/>
        </Suspense> : null}
        {resourcesOpen ? <Suspense fallback={<p role="status" className="px-3 py-2 text-muted">载入科研资源</p>}>
          <ResearchResourcesPanel key={`${literature.projectId}:${selected.id}`} client={literature.client}
            projectId={literature.projectId} writable={scope.writable} onLockChange={setResourcesLocked}/>
        </Suspense> : null}
        {huggingFaceOpen ? <Suspense fallback={<p role="status" className="px-3 py-2 text-muted">载入 Hugging Face</p>}>
          <HuggingFacePanel key={`${literature.projectId}:${selected.id}`} client={literature.client}
            projectId={literature.projectId} writable={scope.writable} onLockChange={setHuggingFaceLocked}/>
        </Suspense> : null}
      </div> : null}

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
                tabIndex={document.id === activeDocumentId || (activeDocumentId === null && document.id === documents[0].id) ? 0 : -1}
                onClick={() => selectReaderDocument(document.id)}
                onKeyDown={event => {
                  const index = documents.findIndex(entry => entry.id === document.id);
                  const next = event.key === 'ArrowRight' ? (index + 1) % documents.length :
                    event.key === 'ArrowLeft' ? (index + documents.length - 1) % documents.length :
                    event.key === 'Home' ? 0 : event.key === 'End' ? documents.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  selectReaderDocument(documents[next].id);
                  const tabs = event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  tabs[next].focus();
                }}
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

          {activeDocument?.mediaType === 'application/pdf' && reader.parsed !== null ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
              <button type="button" onClick={() => setComparePdf(compare => !compare)} aria-pressed={comparePdf}
                data-testid="reader-compare-pdf" className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)]">
                <Columns2 size={14}/>{comparePdf ? '仅解析文本' : '原文与解析'}
              </button>
              {comparePdf && selectedPdfBlock !== null && content !== null && content.blocks.find(block => block.id === selectedPdfBlock)!.locations.length > 1 ? (
                <label className="flex items-center gap-1 text-[var(--font-meta-size)]">块位置
                  <select aria-label="解析块位置" value={selectedPdfLocation} onChange={event => setPdfSelection({
                    parseId: reader.parsed!.run.id, blockId: selectedPdfBlock, locationIndex: Number(event.target.value)
                  })} className="rounded-control border border-line bg-surface px-1">
                    {content.blocks.find(block => block.id === selectedPdfBlock)!.locations.map((location, index) => (
                      <option key={index} value={index}>第 {location.page} 页，位置 {index + 1}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
          {comparePdf && activeDocument?.mediaType === 'application/pdf' && reader.parsed !== null && literature.projectId !== null ? (
            <div className="min-h-0 w-1/2 min-w-0 border-r border-line">
              <Suspense fallback={<p role="status" className="p-2 text-muted">加载原文阅读器…</p>}>
                <PaperPdfView client={literature.client} projectId={literature.projectId} document={activeDocument} parsed={reader.parsed}
                  canAnnotate={scope.writable && scope.projectId === literature.projectId}
                  selection={selectedPdfBlock === null ? null : {blockId: selectedPdfBlock, locationIndex: selectedPdfLocation}}
                  onSelectBlock={selection => {
                    setPdfSelection({parseId: reader.parsed!.run.id, ...selection});
                    const target = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(selection.blockId)}"]`);
                    target?.focus({preventScroll: true});
                    target?.scrollIntoView({block: 'center'});
                  }}/>
              </Suspense>
            </div>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3" data-testid="reader-content-area">
            {content?.parseMode === 'ocr' || content?.parseMode === 'mixed' ?
              <p role="note" className="mb-2 text-[var(--font-meta-size)] text-muted" data-testid="reader-quality-ocr">
                此版本含 OCR 识别内容，请核对数字、单位和公式。
              </p> : null}
            {content?.warnings.map((warning,index) => <p key={`${index}:${warning}`} role="note"
              className="mb-2 break-words text-[var(--font-meta-size)] text-muted" data-testid="reader-quality-warning">
              {warning === 'research_models_missing_native_text_only' ? '此版本仅提取原生文本，未进行 OCR 核查。' : `解析提示：${warning}`}
            </p>)}
            {focusLocator !== null && matchedBlockId === null && content !== null ? (
              <p role="note" className="mb-2 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="reader-jump-missed">
                locator「{focusLocator}」没有唯一的精确位置，未跳转。
              </p>
            ) : null}
            {loadingContent ? (
              <EmptyState tone="loading" icon={Loader2} title="正在读取解析内容…" testId="reader-content-loading" />
            ) : contentError !== null ? (
              <ErrorBar
                error={{ level: 'blocked', message: contentError, retry: reader.retry, actionLabel: '核对文档版本与项目关联后重试。' }}
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
                {blocks.map((block, index) => {
                  const assetKey = JSON.stringify([literature.projectId, activeDocumentId, reader.parsed?.run.id, block.id]);
                  const comparingAsset = openAsset === assetKey;
                  const hasAssetSurface = content.blocks[index].imageAssetId !== null ||
                    block.kind === 'table' || block.kind === 'formula';
                  return (
                  <section
                    key={block.id}
                    id={`reader-block-${block.id}`}
                    data-testid={`reader-block-${block.kind}`}
                    data-block-id={block.id}
                    data-locator={block.locator}
                    data-focused={block.id === selectedPdfBlock ? 'true' : undefined}
                    tabIndex={-1}
                    className={`${BLOCK_STYLES[block.kind]} ${
                      block.id === selectedPdfBlock ? 'rounded-control bg-[var(--accent-soft)] px-2 py-1' : ''
                    } focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]`}
                  >
                    <div className={comparingAsset ? 'grid grid-cols-2 items-start gap-2' : undefined}>
                    {block.kind === 'heading' ? (
                      <h3 className="text-ink">{block.text}</h3>
                    ) : block.kind === 'formula' ? (
                      <p className="overflow-x-auto whitespace-pre-wrap rounded-control border border-line bg-bg-soft px-2 py-1">
                        {block.text}
                      </p>
                    ) : (
                      <p className="min-w-0 whitespace-pre-wrap break-words">
                        {block.kind === 'figure' ? <span className="text-subtle">[图] </span> : null}
                        {block.isBlank ? <span className="text-subtle">（空块）</span> : block.text}
                      </p>
                    )}
                    {!comparingAsset || activeDocument === null || reader.parsed === null || literature.projectId === null ? null :
                      <Suspense fallback={<p role="status" className="text-muted">加载解析图像…</p>}>
                        <PaperBlockAsset client={literature.client} projectId={literature.projectId} document={activeDocument}
                          parsed={reader.parsed} block={content.blocks[index]}/>
                      </Suspense>}
                    </div>
                    {block.isBlank ? <p role="note" className="mt-1 text-[var(--font-meta-size)] text-muted"
                      data-testid="reader-quality-empty">此块没有解析文本，请核对原文。</p> : null}
                    <p className="mt-0.5 font-mono text-subtle text-[var(--font-micro-size)]">
                      <span>{block.label}</span>{' '}<span>{block.locator}</span>{' '}<span>第 {block.page ?? '?'} 页</span>
                    </p>
                    {!hasAssetSurface ? null : content.blocks[index].imageAssetId === null ?
                      <p role="note" className="mt-1 text-[var(--font-meta-size)] text-muted" data-testid="reader-block-asset-absent">
                        此块未保存解析图像。
                      </p> :
                      <button type="button" data-testid="reader-block-asset-toggle" aria-expanded={comparingAsset}
                        onClick={() => setOpenAsset(comparingAsset ? null : assetKey)}
                        className="mt-1 rounded-control px-1 py-0.5 text-[var(--font-meta-size)] text-muted hover:bg-[var(--overlay-hover)]">
                        {comparingAsset ? '收起解析图像' : '核对解析图像'}
                      </button>}
                    {activeDocument?.mediaType === 'application/pdf' ? (
                      <button type="button" disabled={content.blocks[index].locations.length === 0}
                        aria-label={`查看${block.label}原文位置`} aria-pressed={selectedPdfBlock === block.id}
                        data-testid="reader-block-source" className="mt-1 flex items-center gap-1 rounded-control px-1 py-0.5 text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                        onClick={() => {setComparePdf(true); setPdfSelection({parseId: reader.parsed!.run.id, blockId: block.id, locationIndex: 0});}}>
                        <ScanLine size={13}/>{selectedPdfBlock === block.id ? '所选位置' : '原文位置'}
                      </button>
                    ) : null}
                  </section>
                );})}
              </article>
            )}
          </div>
          </div>

        </div>
      )}
    </div>
  );
}
