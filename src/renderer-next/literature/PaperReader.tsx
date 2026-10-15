import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Download, FileSearch, Loader2, RotateCcw, Square, Timer } from 'lucide-react';
import type { ResearchDocument, ResearchDocumentContent, ResearchDocumentRun } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { parseDocumentBlocks, type ParsedBlockKind } from './parse-blocks';
import type { LiteratureStore } from './use-literature-store';

/**
 * The paper reader (P5/T5.4).
 *
 * Scope, honestly stated: this renders what the contract can actually deliver —
 * metadata from the library record, and the parse's `blocks` (heading /
 * paragraph / table / formula / figure **as text**, plus `locator`). It does
 * **not** draw figures or embed the original PDF: the source bytes and assets are
 * not reachable from the renderer (no registered IPC method — B16). The panel
 * says so instead of rendering an empty box that looks like a missing image.
 *
 * Parse progress is the backend's own `document.runs` statuses; there are no
 * stage names in the contract, so no stage list is fabricated. The legacy
 * `MINERU_PIPELINE_STAGES` progression is gone.
 */

export type PaperReaderProps = {
  literature: LiteratureStore;
  loadDocumentContent: (documentId: string) => Promise<IpcLikeResult<{ run: ResearchDocumentRun; content: ResearchDocumentContent }>>;
  /** Preview the original when it is a workspace file (P3 protocol). */
  openInFilesView: (relativePath: string) => void;
};

const STATUS_LABELS: Readonly<Record<ResearchDocument['status'], string>> = {
  imported: '已导入，尚未解析',
  parsing: '解析中',
  ready: '解析完成',
  failed: '解析失败',
  cancelled: '解析已取消'
};

const RUN_STATUS_LABELS: Readonly<Record<ResearchDocumentRun['status'], string>> = {
  running: '进行中',
  ready: '完成',
  failed: '失败',
  cancelled: '已取消'
};

const BLOCK_STYLES: Readonly<Record<ParsedBlockKind, string>> = {
  heading: 'text-ink font-medium',
  paragraph: 'text-ink',
  table: 'font-mono text-muted',
  formula: 'font-mono text-ink',
  figure: 'text-muted'
};

export function PaperReader({ literature, loadDocumentContent, openInFilesView }: PaperReaderProps): React.JSX.Element {
  const selected = literature.selected;
  const documents = literature.documents;
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [content, setContent] = useState<ResearchDocumentContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Follow the selection, but never render one document's content under another
  // document's header: switching clears the content immediately.
  useEffect(() => {
    setContent(null);
    setContentError(null);
    setActiveDocumentId(documents.length === 0 ? null : (documents[0]?.id ?? null));
  }, [documents, selected?.id]);

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

  if (selected === null) {
    return (
      <EmptyState
        icon={FileSearch}
        title="尚未选择文献"
        description="在左侧列表里选一条文献，这里会显示元数据、解析状态与正文。"
        testId="reader-no-selection"
      />
    );
  }

  const blocks = content === null ? [] : parseDocumentBlocks(content);
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;

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
          <span className="text-subtle" data-testid="reader-revision">
            revision {selected.revision}
          </span>
          {selected.archived ? <span className="text-[var(--st-warn)]">已归档</span> : null}
        </p>
      </header>

      {documents.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={FileSearch}
            title="这条文献还没有文档"
            description="在「导入」里选择 PDF / 图片 / HTML 并附加到这条文献，之后就能解析与检索。"
            testId="reader-no-document"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5" role="tablist" aria-label="文档">
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
                    轮询后端 run 状态
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
                    className="flex items-center gap-1 rounded-control border border-line px-2 text-[var(--st-warn)] text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                  >
                    <Square size={11} aria-hidden="true" />
                    取消解析
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={literature.action.pending || literature.projectId === null}
                  onClick={() => void literature.startParse(activeDocument.id)}
                  data-testid="reader-start-parse"
                  className="flex items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                >
                  <Download size={11} aria-hidden="true" />
                  {activeDocument.status === 'ready' ? '重新解析' : '解析'}
                </button>
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
                title="导入的文档不在工作区里，这里只能尝试同名工作区文件；原始 PDF 目前没有 IPC 通道（B16）"
                className="flex items-center gap-1 rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
              >
                <FileSearch size={11} aria-hidden="true" />
                在工作区找同名文件
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="reader-content-area">
            {loadingContent ? (
              <EmptyState tone="loading" icon={Loader2} title="正在读取解析内容…" testId="reader-content-loading" />
            ) : contentError === null ? null : (
              <ErrorBar
                error={{
                  level: 'blocked',
                  message: contentError,
                  actionLabel: '解析状态来自 research.document.runs'
                }}
              />
            )}
            {contentError !== null ? null : content === null ? (
              activeDocument !== null && activeDocument.status !== 'ready' ? (
                <EmptyState
                  icon={Timer}
                  title="这条文档还没有解析结果"
                  description="点「解析」后，进度来自后端的 run 记录（running / ready / failed / cancelled）。"
                  testId="reader-content-missing"
                />
              ) : null
            ) : blocks.length === 0 ? (
              <EmptyState icon={CircleAlert} title="解析结果里没有内容块" testId="reader-content-empty-blocks" />
            ) : (
              <article className="flex flex-col gap-2" data-testid="reader-blocks">
                {blocks.map((block) => (
                  <section
                    key={block.id}
                    data-testid={`reader-block-${block.kind}`}
                    data-locator={block.locator}
                    className={BLOCK_STYLES[block.kind]}
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
                        {block.text}
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

          <p className="flex shrink-0 items-center gap-1 border-t border-line px-3 py-1.5 text-subtle text-[var(--font-micro-size)]">
            <RotateCcw size={10} aria-hidden="true" />
            原文与图片资源没有通过 IPC 暴露（B16）；这里渲染的是解析出的文字块与 locator。
          </p>
        </div>
      )}
    </div>
  );
}
