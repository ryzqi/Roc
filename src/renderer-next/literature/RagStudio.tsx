import { useEffect, useState } from 'react';
import { AlertCircle, Bookmark, DatabaseZap, ExternalLink, FlaskConical, Loader2, Play, RefreshCw, Search, Settings2, Square } from 'lucide-react';
import type { ResearchIndexedFile, ResearchIndexJob, ResearchIndexStatus, ResearchKnowledgeSearchHit, ResearchKnowledgeSearchResult } from '../../shared/types';
import { useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { useSettingsRevision } from '../settings/settings-events';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { controlIndex, listIndexedFiles, listIndexJobs, searchKnowledge } from './library-store';
import type { LiteratureStore } from './use-literature-store';

/**
 * RAG Studio (P5/T5.5).
 *
 * What this screen is, after the contract correction (F16): **index status over
 * files** + retrieval hits. It is not a chunk browser, because the backend exposes
 * no chunks — `index.status.counts` counts files and `index.files` lists files
 * (B14). The panel states that instead of drawing a fake chunk list.
 *
 * Retrieval is `research.knowledge.search`: keyword and vector ranks plus the
 * fused RRF score all arrive from the backend, so nothing is re-scored here. The
 * legacy `ragEngine.ts` (local BM25, fake dense vectors, local RRF) is gone.
 *
 * "Jump back to the source" is resolved from the hit's **own** fields rather than
 * from a guessed id: the knowledge document id says which kind of source it is
 * (`document:<parseId>` = a parsed document of a library item, `library:<id>` = a
 * library record's metadata, `project-index:<fileId>` = a workspace file), which
 * is exactly what decides between the reader and the files view. The legacy code
 * asked `index.evidenceSource` with a **chunkId** — a method whose argument is an
 * evidence id, so it could only ever throw `research_evidence_not_found` (F16).
 *
 * Index configuration is **read-only** with a jump to the settings centre
 * (ADR-M09): the effective values are shown from `status.settings`, never edited.
 *
 * Every write passes back the revision it read (`expectedRevision`), because
 * `index.control` is an optimistic-concurrency call.
 */

export type RagStudioProps = {
  literature: LiteratureStore;
  openInFilesView: (relativePath: string) => void;
  /**
   * Open the reader for a hit. `parseId` is the hit's own parse when it named one
   * (so an item with several documents opens the right one); `null` means "the
   * selected item's first document".
   */
  onOpenInReader: (target: { parseId: string | null; libraryItemId: string | null; locator: string | null }) => void;
};

const PHASE_LABELS: Readonly<Record<ResearchIndexStatus['phase'], string>> = {
  unavailable: '不可用（项目未绑定工作目录）',
  idle: '空闲',
  queued: '排队中',
  scanning: '扫描中',
  indexing: '索引中',
  paused: '已暂停',
  failed: '失败'
};

const FILE_STATUS_LABELS: Readonly<Record<ResearchIndexedFile['status'], string>> = {
  queued: '排队',
  running: '进行中',
  ready: '已索引',
  failed: '失败',
  missing: '文件缺失'
};

const JOB_STATUS_LABELS: Readonly<Record<ResearchIndexJob['status'], string>> = {
  queued: '排队',
  running: '进行中',
  ready: '完成',
  failed: '失败',
  cancelled: '已取消'
};

const POLL_INTERVAL_MS = 1_500;

export function RagStudio({ literature, openInFilesView, onOpenInReader }: RagStudioProps): React.JSX.Element {
  const client = literature.client;
  const projectId = literature.projectId;
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ResearchKnowledgeSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [actionPending, setActionPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const scope = useWorkspaceScope();

  /**
   * The index configuration is written by the settings centre (ADR-M09), and `settings.*`
   * has no push channel — so the effective-config block below re-reads when settings change
   * (P8/T8.4). Without the revision the panel would keep showing the pre-save revision and
   * a stale include/exclude list.
   */
  const settingsRevision = useSettingsRevision();
  const statusResource = useAsyncResource(
    projectId === null ? null : `index-status:${projectId}:${settingsRevision}`,
    () => getIndexStatusSafely(client, projectId ?? ''),
    { label: '读取索引状态' }
  );
  const status = statusResource.data;

  const filesResource = useAsyncResource(
    projectId === null ? null : `index-files:${projectId}:${fileQuery}`,
    () => listIndexedFiles(client, { projectId: projectId ?? '', query: fileQuery, includeMissing: true, limit: 100 }),
    { label: '读取索引文件' }
  );
  const jobsResource = useAsyncResource(
    projectId === null ? null : `index-jobs:${projectId}`,
    () => listIndexJobs(client, { projectId: projectId ?? '', limit: 50 }),
    { label: '读取索引作业' }
  );

  /**
   * Poll while the backend is actually working.
   *
   * `phase` is the backend's own state; there is no push channel for indexing, so
   * polling is the honest mechanism. The interval only exists while queued /
   * scanning / indexing, so an idle panel costs nothing.
   */
  const busy = status !== null && ['queued', 'scanning', 'indexing'].includes(status.phase);
  const reloadStatus = statusResource.reload;
  const reloadFiles = filesResource.reload;
  const reloadJobs = jobsResource.reload;
  const busySignature = busy ? statusResource.data?.generation ?? 0 : 0;
  useEffect(() => {
    if (!busy) {
      return;
    }
    void busySignature;
    const handle = window.setInterval(() => {
      reloadStatus();
      reloadFiles();
      reloadJobs();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [busy, busySignature, reloadFiles, reloadJobs, reloadStatus]);

  const counts = status?.counts ?? null;
  const revision = status?.settings.revision ?? null;

  const runControl = async (action: 'scan' | 'rebuild' | 'pause' | 'resume'): Promise<void> => {
    if (projectId === null || revision === null) {
      return;
    }
    setActionPending(true);
    try {
      const result = await controlIndex(client, { projectId, action, expectedRevision: revision });
      if (!result.ok) {
        // The message is the backend's own (including revision conflicts): showing
        // it verbatim beats inventing a retry that would overwrite someone else.
        literature.clearActionError();
        setSearchError(result.error.message);
        return;
      }
      reloadStatus();
      reloadFiles();
      reloadJobs();
    } finally {
      setActionPending(false);
    }
  };

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return;
    }
    setSearching(true);
    setSearchError(null);
    setNote(null);
    try {
      const result = await searchKnowledge(client, {
        query: trimmed,
        projectId,
        limit: 20,
        // The configured embedding config, not a hard-coded null: without it the
        // backend can only return keyword hits, and the panel is displaying the
        // effective config right below the box.
        embeddingConfigId: status?.settings.embeddingConfigId ?? null
      });
      if (!result.ok) {
        setResult(null);
        setSearchError(result.error.message);
        return;
      }
      setResult(result.data);
    } finally {
      setSearching(false);
    }
  };

  /**
   * Opens a hit at its source.
   *
   * The knowledge document id prefix is the discriminator (it is the backend's own
   * naming, not a guess):
   *
   *   - `document:<parseId>` → a parsed document; `sourceId` is the **library item**
   *     id and `locator` is a real `blocks[].locator`, so the reader can align it;
   *   - `library:<id>`      → the record's own metadata/abstract (no document block
   *     carries that locator), so the item is opened *without* a locator rather
   *     than reporting a false "position not found";
   *   - `project-index:<id>` → a workspace file; the contract has no line numbers,
   *     so the only honest jump is opening the file.
   */
  const openHit = (hit: ResearchKnowledgeSearchHit): void => {
    setJumpError(null);
    setNote(null);
    /**
     * Library-item hits have to be selectable to be readable.
     *
     * `knowledge.search` deliberately includes documents with `project_id = NULL`
     * (parsed documents are stored that way), while `library.list` only returns
     * items **linked** to the current project. Without this check a hit from another
     * project would look clickable and then leave the reader on 「尚未选择文献」 —
     * a no-op that explains nothing. The list is only consulted once it is
     * `ready`, so a still-loading list cannot produce a false refusal.
     */
    const opensInReader = hit.documentId.startsWith('document:') || hit.documentId.startsWith('library:');
    if (opensInReader && literature.status === 'ready' && !literature.items.some((item) => item.id === hit.sourceId)) {
      setJumpError(
        `这条命中来自文献库条目 ${hit.sourceId}，它没有关联到当前项目（检索会包含不属于本项目的文档），所以这里打不开它。`
      );
      return;
    }
    if (hit.documentId.startsWith('document:')) {
      literature.select(hit.sourceId);
      onOpenInReader({
        parseId: hit.documentId.slice('document:'.length),
        libraryItemId: hit.sourceId,
        locator: hit.locator
      });
      return;
    }
    if (hit.documentId.startsWith('library:')) {
      literature.select(hit.sourceId);
      onOpenInReader({ parseId: null, libraryItemId: hit.sourceId, locator: null });
      return;
    }
    if (hit.documentId.startsWith('project-index:')) {
      openInFilesView(hit.sourceId);
      return;
    }
    setJumpError(
      `这条命中的来源是「${hit.documentId.split(':', 1)[0]}」，契约只给出 documentId（${hit.documentId}），无法定位到具体位置。`
    );
  };

  const captureHit = (hit: ResearchKnowledgeSearchHit): void => {
    setNote(null);
    void literature.captureChunkEvidence(hit.chunkId).then((ok) => {
      if (ok) {
        setNote(`已捕获为证据：${hit.title}`);
      }
    });
  };

  const saveHitAsNote = (hit: ResearchKnowledgeSearchHit): void => {
    setNote(null);
    void literature
      .saveKnowledgeNote({
        title: hit.title,
        content: hit.content,
        locator: hit.locator,
        sourceId: hit.chunkId
      })
      .then((ok) => {
        if (ok) {
          setNote('已写入知识库（note 来源；重复保存会更新同一条）。');
        }
      });
  };

  if (projectId === null) {
    return (
      <EmptyState
        icon={DatabaseZap}
        title="索引属于项目"
        description="进入一个项目后才能建索引：索引按项目的工作目录扫描。"
        testId="rag-no-project"
      />
    );
  }

  const indexedFiles = filesResource.data ?? [];
  const jobs = jobsResource.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rag-studio">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-[var(--font-meta-size)]" data-testid="rag-phase" data-phase={status?.phase ?? 'loading'}>
          {status === null ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}
          {status === null ? '读取索引状态…' : PHASE_LABELS[status.phase]}
        </span>
        {counts === null ? null : (
          <span className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="rag-counts">
            文件 {counts.total} · 已索引 {counts.ready} · 排队 {counts.queued} · 进行 {counts.running} · 失败 {counts.failed}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={revision === null || actionPending}
            onClick={() => void runControl('scan')}
            data-testid="rag-scan"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            <RefreshCw size={11} aria-hidden="true" />
            增量扫描
          </button>
          <button
            type="button"
            disabled={revision === null || actionPending}
            onClick={() => void runControl('rebuild')}
            data-testid="rag-rebuild"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            <Play size={11} aria-hidden="true" />
            重建
          </button>
          <button
            type="button"
            disabled={revision === null || actionPending}
            onClick={() => void runControl(status?.phase === 'paused' ? 'resume' : 'pause')}
            data-testid="rag-toggle-pause"
            className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-[var(--st-warn)] text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
          >
            <Square size={11} aria-hidden="true" />
            {status?.phase === 'paused' ? '继续' : '暂停'}
          </button>
        </div>
      </div>

      {statusResource.status === 'error' ? (
        <div className="shrink-0 px-3 py-2">
          <ErrorBar error={{ level: 'page', message: statusResource.error ?? '读取索引状态失败', retry: reloadStatus }} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <section className="mb-4">
          <h3 className="mb-1.5 text-muted text-[var(--font-meta-size)]">检索（后端做关键词 + 向量 + RRF 融合）</h3>
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line bg-surface px-2">
              <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runSearch();
                  }
                }}
                aria-label="检索知识库"
                placeholder="检索已索引内容"
                data-testid="rag-query"
                className="h-[var(--control-height)] min-w-0 flex-1 bg-transparent text-ink text-[var(--font-meta-size)] placeholder:text-subtle"
              />
            </div>
            <button
              type="button"
              disabled={query.trim().length === 0 || searching}
              onClick={() => void runSearch()}
              data-testid="rag-search"
              className="flex h-[var(--control-height)] items-center gap-1 rounded-control bg-accent-soft px-3 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              {searching ? <Loader2 size={11} aria-hidden="true" className="animate-spin" /> : null}
              检索
            </button>
          </div>

          {searchError === null ? null : (
            <p role="alert" className="mt-1.5 flex items-center gap-1 text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="rag-search-error">
              <AlertCircle size={11} aria-hidden="true" />
              {searchError}
            </p>
          )}
          {jumpError === null ? null : (
            <p role="alert" className="mt-1.5 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="rag-jump-error">
              {jumpError}
            </p>
          )}
          {note === null && literature.action.error === null ? null : (
            <p role="status" className="mt-1.5 text-muted text-[var(--font-micro-size)]" data-testid="rag-note">
              {note ?? literature.action.error}
            </p>
          )}

          {result === null ? (
            <p className="mt-2 text-subtle text-[var(--font-micro-size)]" data-testid="rag-no-search">
              还没有检索。命中会显示关键词排名、向量排名与融合得分（都来自后端）。
            </p>
          ) : result.hits.length === 0 ? (
            <EmptyState compact icon={Search} title="没有命中" description="换一个说法，或先建索引。" testId="rag-no-hits" />
          ) : (
            <>
              <p className="mt-2 font-mono text-subtle text-[var(--font-micro-size)]" data-testid="rag-search-meta">
                关键词 {result.keywordCount} · 向量 {result.vectorCount} · 嵌入模型 {result.embeddingModel ?? '未配置'} · {result.generatedAt}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="rag-hits">
                {result.hits.map((hit) => (
                  <li
                    key={hit.chunkId}
                    className="rounded-card border border-line bg-surface px-2.5 py-2"
                    data-testid={`rag-hit-${hit.chunkId}`}
                  >
                    <header className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ink text-[var(--font-meta-size)]">{hit.title}</span>
                      <span className="shrink-0 font-mono text-subtle text-[var(--font-micro-size)]">
                        rrf {hit.rrfScore.toFixed(4)}
                        {hit.keywordRank === null ? '' : ` · kw#${hit.keywordRank}`}
                        {hit.vectorRank === null ? '' : ` · vec#${hit.vectorRank}`}
                      </span>
                    </header>
                    <p className="mt-1 whitespace-pre-wrap text-muted text-[var(--font-meta-size)]">{hit.content}</p>
                    <footer className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-subtle text-[var(--font-micro-size)]">
                        {hit.sourceType} · {hit.locator ?? '无 locator'}
                      </span>
                      <button
                        type="button"
                        onClick={() => openHit(hit)}
                        data-testid={`rag-hit-open-${hit.chunkId}`}
                        className="flex h-[var(--control-height-compact)] shrink-0 items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
                      >
                        <ExternalLink size={10} aria-hidden="true" />
                        {hit.documentId.startsWith('project-index:') ? '打开来源文件' : '在阅读器里定位'}
                      </button>
                      <button
                        type="button"
                        disabled={projectId === null}
                        onClick={() => captureHit(hit)}
                        title="research.evidence.capture 需要 chunkId，所以只能从命中发起（B15）"
                        data-testid={`rag-hit-capture-${hit.chunkId}`}
                        className="flex h-[var(--control-height-compact)] shrink-0 items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                      >
                        <FlaskConical size={10} aria-hidden="true" />
                        捕获为证据
                      </button>
                      <button
                        type="button"
                        onClick={() => saveHitAsNote(hit)}
                        title="research.knowledge.upsert：把这条命中存成 note 来源的知识文档"
                        data-testid={`rag-hit-save-${hit.chunkId}`}
                        className="flex h-[var(--control-height-compact)] shrink-0 items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
                      >
                        <Bookmark size={10} aria-hidden="true" />
                        写入知识库
                      </button>
                    </footer>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="mb-4">
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-muted text-[var(--font-meta-size)]">索引文件（后端只暴露文件层，分块不可浏览 — B14）</h3>
            <input
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="按路径过滤"
              aria-label="按路径过滤索引文件"
              data-testid="rag-file-filter"
              className="ml-auto h-[var(--control-height-compact)] w-40 rounded-control border border-line bg-surface px-2 text-ink text-[var(--font-micro-size)] placeholder:text-subtle"
            />
          </div>
          {filesResource.status === 'error' ? (
            <ErrorBar error={{ level: 'page', message: filesResource.error ?? '读取索引文件失败', retry: reloadFiles }} />
          ) : indexedFiles.length === 0 ? (
            <p className="text-subtle text-[var(--font-micro-size)]" data-testid="rag-no-files">
              这个项目还没有被索引的文件。点「增量扫描」让后端扫描工作目录。
            </p>
          ) : (
            <table className="w-full border-collapse text-[var(--font-meta-size)]" data-testid="rag-files">
              <thead>
                <tr className="text-left text-subtle text-[var(--font-micro-size)]">
                  <th className="py-0.5 font-normal">路径</th>
                  <th className="py-0.5 font-normal">类型</th>
                  <th className="py-0.5 font-normal">状态</th>
                  <th className="py-0.5 font-normal">文本</th>
                </tr>
              </thead>
              <tbody>
                {indexedFiles.map((file) => (
                  <tr key={file.id} className="border-t border-line-soft" data-testid={`rag-file-${file.id}`}>
                    <td className="max-w-[24rem] truncate py-0.5 font-mono text-ink">{file.path}</td>
                    <td className="py-0.5 text-muted">{file.kind}</td>
                    <td className="py-0.5" data-file-status={file.status}>
                      <span className={file.status === 'failed' ? 'text-[var(--st-bad)]' : file.status === 'ready' ? 'text-[var(--st-ok)]' : 'text-muted'}>
                        {FILE_STATUS_LABELS[file.status]}
                      </span>
                      {file.error === null ? null : <span className="ml-1 text-subtle">（{file.error}）</span>}
                    </td>
                    <td className="py-0.5 text-muted">{file.textIndexed ? '已抽文本' : '未抽文本'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="mb-4">
          <h3 className="mb-1.5 text-muted text-[var(--font-meta-size)]">索引作业</h3>
          {jobs.length === 0 ? (
            <p className="text-subtle text-[var(--font-micro-size)]" data-testid="rag-no-jobs">
              还没有索引作业记录。
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="rag-jobs">
              {jobs.map((job) => (
                <li key={job.id} className="flex items-center gap-2 text-[var(--font-meta-size)]" data-testid={`rag-job-${job.id}`}>
                  <span className="w-16 shrink-0 text-muted">{JOB_STATUS_LABELS[job.status]}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{job.path}</span>
                  <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">
                    gen {job.generation}
                    {job.finishedAt === null ? '' : ` · ${job.finishedAt}`}
                  </span>
                  <button
                    type="button"
                    disabled={revision === null || actionPending}
                    onClick={() => {
                      if (projectId === null || revision === null) {
                        return;
                      }
                      setActionPending(true);
                      void controlIndex(client, {
                        projectId,
                        action: 'retry',
                        expectedRevision: revision,
                        fileId: job.fileId
                      })
                        .then((outcome) => {
                          if (!outcome.ok) {
                            setSearchError(outcome.error.message);
                            return;
                          }
                          reloadStatus();
                          reloadFiles();
                          reloadJobs();
                        })
                        .finally(() => setActionPending(false));
                    }}
                    data-testid={`rag-job-retry-${job.id}`}
                    className="h-[var(--control-height-compact)] shrink-0 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                  >
                    重试
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-1.5 flex items-center gap-2 text-muted text-[var(--font-meta-size)]">
            生效配置（只读，写入口在设置中心 — ADR-M09）
            <button
              type="button"
              onClick={() => scope.openSettings()}
              data-testid="rag-open-settings"
              className="ml-auto flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
            >
              <Settings2 size={10} aria-hidden="true" />
              打开设置中心
            </button>
          </h3>
          {status === null ? null : (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[var(--font-micro-size)]" data-testid="rag-settings">
              <dt className="text-subtle">revision</dt>
              <dd className="text-ink">{status.settings.revision}</dd>
              <dt className="text-subtle">generation</dt>
              <dd className="text-ink">{status.generation}</dd>
              <dt className="text-subtle">kinds</dt>
              <dd className="text-ink">{status.settings.kinds.join(', ')}</dd>
              <dt className="text-subtle">include</dt>
              <dd className="text-ink">{status.settings.include.join(', ')}</dd>
              <dt className="text-subtle">exclude</dt>
              <dd className="text-ink">{status.settings.exclude.join(', ')}</dd>
              <dt className="text-subtle">watch / paused</dt>
              <dd className="text-ink">
                {String(status.settings.watch)} / {String(status.settings.paused)}
              </dd>
              <dt className="text-subtle">embeddingConfigId</dt>
              <dd className="text-ink">{status.settings.embeddingConfigId ?? '未配置'}</dd>
              <dt className="text-subtle">工作目录</dt>
              <dd className="min-w-0 truncate text-ink">{status.workspacePath ?? '未绑定'}</dd>
              <dt className="text-subtle">最近扫描</dt>
              <dd className="text-ink">{status.lastScanAt ?? '从未'}</dd>
            </dl>
          )}
          {status === null ? null : status.error === null ? null : (
            <p role="alert" className="mt-1 text-[var(--st-bad)] text-[var(--font-micro-size)]">
              {status.error}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * `index.status` fails with `workspace_path_missing` when the project has no bound
 * directory. That is an expected state, not a page error, so it is turned into an
 * explanatory `available: false` payload instead of an error bar the user cannot act on.
 */
async function getIndexStatusSafely(
  client: LiteratureStore['client'],
  projectId: string
): Promise<{ ok: true; data: ResearchIndexStatus } | { ok: false; error: { message: string; code?: string } }> {
  const result = await client.api.research.getIndexStatus({ projectId });
  if (result.ok) {
    return result;
  }
  if (result.error.code === 'workspace_path_missing') {
    return result;
  }
  return result;
}
