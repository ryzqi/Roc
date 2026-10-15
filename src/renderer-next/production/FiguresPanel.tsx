import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Play, RefreshCw, XCircle } from 'lucide-react';
import type {
  FileEntry,
  ResearchExperimentEnvironment,
  ResearchFigurePublication,
  ResearchFigureRun
} from '../../shared/types';
import type { ResearchExperimentRuntime } from '../../shared/schemas/research-experiments';
import type { ResearchFigureOptions } from '../../shared/schemas/research-plotting';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ProgressTask } from '../shell/ProgressTask';
import { formatBeijingDateTime } from '../shared/format';
import { listTree } from '../workspace/workspace-store';
import { checkRelativePath, pathRejectionMessage } from '../workspace/paths';
import { environmentReadiness, expectedEnvironmentHash, figureFormatForPath, figurePublicationLabel, figureRenderMode } from './production-rules';
import {
  cancelFigure,
  inspectFigureEnvironment,
  listFigureRuns,
  listFigures,
  publishFigure,
  readFigureFile,
  startFigure
} from './production-store';
import {
  FieldLabel,
  InlineHint,
  IssueList,
  KeyValue,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textInputClass
} from './panel-shell';

/**
 * 图稿 (P7/T7.3).
 *
 * Same contract shape as the experiment panel (a run executes a workspace `.py`, the environment
 * probe drives the main action, progress is polling) plus the figure-specific parts:
 *
 *  - **The figure's geometry is part of the request** (`figure: {widthInches, heightInches, dpi,
 *    seed}` with a pixel-area ceiling), so the panel edits those four numbers and sends them
 *    unchanged.
 *  - **Publication is its own record** (`researchFigurePublicationSchema`) with a
 *    `replacesFigureId`, which is how a figure is revised without losing the earlier version.
 *  - **Preview is honest about the contract (B21).** The three outputs are fixed
 *    (`figure.png` / `figure.svg` / `figure.pdf`) and `readFigureFile` returns text or base64.
 *    PNG and SVG therefore render through a `data:` URL inside an `<img>` — never by injecting
 *    markup (`dangerouslySetInnerHTML` would execute whatever an SVG carries) and never through a
 *    Blob URL (the project forbids it). **PDF has no renderable path at all**: it is listed with
 *    its size and the reason, instead of a broken frame.
 */

type FigureDraft = {
  label: string;
  sourcePath: string;
  runtimeKind: 'bundled-python' | 'uv';
  widthInches: number;
  heightInches: number;
  dpi: number;
  seed: number;
  timeoutMs: number;
};

const defaultDraft: FigureDraft = {
  label: '',
  sourcePath: '',
  runtimeKind: 'bundled-python',
  widthInches: 6,
  heightInches: 4,
  dpi: 200,
  seed: 1,
  timeoutMs: 600_000
};

const PIXEL_LIMIT = 32_000_000;

/**
 * A preview image as a `data:` URL.
 *
 * Not a Blob URL (the project forbids `URL.createObjectURL`) and not injected markup
 * (`dangerouslySetInnerHTML` would execute whatever an SVG carries) — an `<img src="data:…">`
 * is the only path the renderer has for research-storage binaries (B21).
 */
type PreviewImage = { dataUrl: string; mediaType: 'image/png' | 'image/svg+xml' };
const FIGURE_FILES = ['figure.png', 'figure.svg', 'figure.pdf'] as const;

export function FiguresPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
  /**
   * Whether this panel may write.
   *
   * The stage workspace decides it (`scope.writable && stageGroupWriteAllowed(...)`) and passes it
   * down, because the *stage-group* half of the rule exists only in the renderer: the backend
   * refuses artifact writes for a non-current stage (`requireEditableStage`) but happily starts an
   * experiment run or a template compile, so a panel that gated on the archived flag alone would
   * offer live buttons behind a 「只读：非当前阶段组」 badge. `undefined` keeps the route-rendered
   * case (the `latex` view) working with the project-level predicate.
   */
  const scope = useWorkspaceScope();
  const canWrite = writeAllowed ?? scope.writable;
  const projectId = scope.projectId ?? '';
  const workspacePath = scope.workspacePath;

  const [draft, setDraft] = useState<FigureDraft>(defaultDraft);
  const [probed, setProbed] = useState<ResearchExperimentEnvironment | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [image, setImage] = useState<PreviewImage | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  const runs = useAsyncResource<ResearchFigureRun[]>(
    scope.projectId === null ? null : `figures-runs:${scope.projectId}`,
    () => listFigureRuns(scope.client, { projectId, limit: 50 }),
    { label: '读取图稿运行' }
  );
  const library = useAsyncResource<ResearchFigurePublication[]>(
    scope.projectId === null ? null : `figures:${scope.projectId}`,
    () => listFigures(scope.client, { projectId, limit: 50 }),
    { label: '读取图稿库' }
  );
  const files = useAsyncResource<{ path: string; entry: FileEntry }[]>(
    workspacePath === null ? null : `figure-files:${workspacePath}`,
    async () => {
      const root = await listTree(scope.client, '');
      if (!root.ok) {
        return root;
      }
      const collected = root.data.entries.map((entry) => ({ path: entry.relativePath, entry }));
      const scripts = root.data.entries.find((entry) => entry.type === 'directory' && entry.name === 'scripts');
      if (scripts === undefined) {
        return { ok: true, data: collected };
      }
      // One extra level: real projects keep their scripts in `scripts/`, and the panel is a
      // picker, not the file tree (that lives in the sidebar and loads lazily on demand).
      const nested = await listTree(scope.client, 'scripts');
      if (nested.ok) {
        for (const entry of nested.data.entries) {
          collected.push({ path: entry.relativePath, entry });
        }
      }
      return { ok: true, data: collected };
    },
    { label: '列出工作区文件' }
  );

  const probe = useAsyncAction(
    (runtime: ResearchExperimentRuntime) => inspectFigureEnvironment(scope.client, { projectId, runtime }),
    { label: '检查绘图环境' }
  );
  const run = useAsyncAction(
    (input: { runtime: ResearchExperimentRuntime; options: ResearchFigureOptions }) =>
      startFigure(scope.client, {
        projectId,
        requestId: `renderer_${crypto.randomUUID()}`,
        label: draft.label.trim(),
        runtime: input.runtime,
        sourcePath: draft.sourcePath,
        inputPaths: [],
        arguments: [],
        parameters: {},
        ...(probed === null ? {} : { expectedEnvironmentHash: expectedEnvironmentHash(probed) }),
        timeoutMs: draft.timeoutMs,
        figure: input.options
      }),
    { label: '启动绘图运行' }
  );
  const cancel = useAsyncAction((runId: string) => cancelFigure(scope.client, { projectId, runId }), {
    label: '取消绘图运行'
  });
  const publish = useAsyncAction(
    (input: { runId: string; replacesFigureId: string | null }) => publishFigure(scope.client, { projectId, ...input }),
    { label: '发布图稿' }
  );

  const runtime: ResearchExperimentRuntime = { kind: draft.runtimeKind };
  const scripts = (files.data ?? []).filter((file) => file.entry.type === 'file' && file.path.toLowerCase().endsWith('.py'));
  const activeRun = (runs.data ?? []).find((entry) => entry.status === 'preparing' || entry.status === 'running') ?? null;
  const selected = (runs.data ?? []).find((entry) => entry.id === selectedRunId) ?? activeRun ?? (runs.data ?? [])[0] ?? null;

  const pixelArea = draft.widthInches * draft.heightInches * draft.dpi ** 2;
  const blockers = [
    // `researchFigureOptionsSchema` 的字段边界（宽高 1–24、dpi 72–1200 整数、seed 0..2^32-1）也要在
    // 前端镜像：清空数字输入会让 `Number('') === 0`，那时后端只会回一个 zod 错误（评审 P2）。
    ...(Number.isFinite(draft.widthInches) && draft.widthInches >= 1 && draft.widthInches <= 24
      ? []
      : [{ message: '宽度必须在 1–24 英寸之间', reference: 'width' }]),
    ...(Number.isFinite(draft.heightInches) && draft.heightInches >= 1 && draft.heightInches <= 24
      ? []
      : [{ message: '高度必须在 1–24 英寸之间', reference: 'height' }]),
    ...(Number.isInteger(draft.dpi) && draft.dpi >= 72 && draft.dpi <= 1200
      ? []
      : [{ message: 'DPI 必须是 72–1200 的整数', reference: 'dpi' }]),
    ...(Number.isInteger(draft.seed) && draft.seed >= 0 && draft.seed <= 4294967295
      ? []
      : [{ message: '随机种子必须是 0–4294967295 的整数', reference: 'seed' }]),
    ...(draft.label.trim().length === 0 ? [{ message: '给这次运行一个标签', reference: 'label' }] : []),
    ...(draft.sourcePath.length === 0 ? [{ message: '选择工作区里的 .py 脚本', reference: 'sourcePath' }] : []),
    ...sourcePathIssues(draft.sourcePath),
    ...(probed === null ? [{ message: '先检查绘图环境（主操作由探测结果驱动）', reference: 'environment' }] : []),
    ...(pixelArea > PIXEL_LIMIT ? [{ message: `像素总数超过上限（${Math.round(pixelArea)} > ${PIXEL_LIMIT}）`, reference: 'figure' }] : [])
  ];

  const polling = activeRun !== null;
  const reload = runs.reload;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!polling) {
      return;
    }
    const timer = window.setInterval(() => reloadRef.current(), 2000);
    return () => window.clearInterval(timer);
  }, [polling]);

  /** Reads one of the three fixed outputs and turns it into something an `<img>` may load. */
  const showFigure = useMemo(
    () => async (runId: string, path: (typeof FIGURE_FILES)[number]) => {
      const format = figureFormatForPath(path);
      if (format === null) {
        return;
      }
      const result = await readFigureFile(scope.client, { projectId, runId, area: 'output', path });
      if (!result.ok) {
        setPreviewNote(`读取失败：${result.error.message}`);
        return;
      }
      const mode = figureRenderMode(format, result.data.encoding);
      if (mode === 'unsupported') {
        setImage(null);
        setPreviewNote('PDF 图稿在渲染层无法预览（research storage 没有文件协议，B21）：文件已在运行输出里列出。');
        return;
      }
      const dataUrl =
        result.data.encoding === 'base64'
          ? `data:image/${format === 'svg' ? 'svg+xml' : 'png'};base64,${result.data.content}`
          : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.content)}`;
      setImage({ dataUrl, mediaType: format === 'svg' ? 'image/svg+xml' : 'image/png' });
      setPreviewNote(null);
    },
    [projectId, scope.client]
  );

  if (scope.projectId === null) {
    return <InlineHint text="未进入项目。" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-figures">
      <PanelSection title="绘图环境" hint="research.figure.environment" testId="production-figure-environment">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex w-[190px] flex-col gap-0.5">
            <FieldLabel text="运行时" />
            <select
              data-testid="production-figure-runtime"
              value={draft.runtimeKind}
              onChange={(event) => {
                setDraft({ ...draft, runtimeKind: event.target.value as FigureDraft['runtimeKind'] });
                setProbed(null);
              }}
              className={selectClass}
            >
              <option value="bundled-python">内置 Python</option>
              <option value="uv">uv 虚拟环境</option>
            </select>
          </label>
          <button
            type="button"
            data-testid="production-figure-probe"
            disabled={probe.pending}
            onClick={() => {
              void probe.run(runtime).then((result) => {
                if (result !== null) {
                  setProbed(result);
                }
              });
            }}
            className={primaryButtonClass}
          >
            <RefreshCw size={12} aria-hidden="true" className="mr-1 inline" />
            {probe.pending ? '探测中…' : '检查绘图环境'}
          </button>
        </div>
        <p className="text-[var(--font-meta-size)]" data-testid="production-figure-environment-status">
          {environmentReadiness(probed).summary}
          {probed === null ? '' : ` · ${environmentReadiness(probed).detail}`}
        </p>
        {probe.error === null ? null : <InlineHint text={probe.error} testId="production-figure-probe-error" />}
      </PanelSection>

      <PanelSection title="启动绘图运行" hint="research.figure.start（寻址 + 图稿选项）" testId="production-figure-start">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <FieldLabel text="标签" />
            <input
              data-testid="production-figure-label"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              className={textInputClass}
            />
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <FieldLabel text="脚本（工作区 .py）" />
            <select
              data-testid="production-figure-source"
              value={draft.sourcePath}
              onChange={(event) => setDraft({ ...draft, sourcePath: event.target.value })}
              className={selectClass}
            >
              <option value="">— 选择工作区脚本 —</option>
              {scripts.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.path}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex w-[130px] flex-col gap-0.5">
            <FieldLabel text="宽（英寸 1–24）" />
            <input
              type="number"
              min={1}
              max={24}
              step={0.1}
              data-testid="production-figure-width"
              value={draft.widthInches}
              onChange={(event) => setDraft({ ...draft, widthInches: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
          <label className="flex w-[130px] flex-col gap-0.5">
            <FieldLabel text="高（英寸 1–24）" />
            <input
              type="number"
              min={1}
              max={24}
              step={0.1}
              data-testid="production-figure-height"
              value={draft.heightInches}
              onChange={(event) => setDraft({ ...draft, heightInches: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
          <label className="flex w-[120px] flex-col gap-0.5">
            <FieldLabel text="DPI（72–1200）" />
            <input
              type="number"
              min={72}
              max={1200}
              data-testid="production-figure-dpi"
              value={draft.dpi}
              onChange={(event) => setDraft({ ...draft, dpi: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
          <label className="flex w-[130px] flex-col gap-0.5">
            <FieldLabel text="随机种子" />
            <input
              type="number"
              min={0}
              data-testid="production-figure-seed"
              value={draft.seed}
              onChange={(event) => setDraft({ ...draft, seed: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
          <label className="flex w-[170px] flex-col gap-0.5">
            <FieldLabel text="超时毫秒" />
            <input
              type="number"
              min={1000}
              max={3600000}
              step={1000}
              data-testid="production-figure-timeout"
              value={draft.timeoutMs}
              onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
        </div>
        <IssueList issues={blockers} testId="production-figure-issues" />
        <button
          type="button"
          data-testid="production-figure-run"
          disabled={!canWrite || run.pending || blockers.length > 0}
          onClick={() => {
            void run
              .run({
                runtime,
                options: { widthInches: draft.widthInches, heightInches: draft.heightInches, dpi: draft.dpi, seed: draft.seed }
              })
              .then((started) => {
                if (started !== null) {
                  setSelectedRunId(started.id);
                  runs.reload();
                }
              });
          }}
          className={primaryButtonClass}
        >
          <Play size={12} aria-hidden="true" className="mr-1 inline" />
          启动绘图
        </button>
        {run.error === null ? null : <InlineHint text={run.error} testId="production-figure-run-error" />}
      </PanelSection>

      <PanelSection
        title="绘图运行"
        hint={polling ? 'research.figure.listRuns（轮询中）' : 'research.figure.listRuns'}
        testId="production-figure-runs"
        action={{ label: '刷新', onClick: runs.reload, busy: runs.status === 'loading', testId: 'production-figure-refresh' }}
      >
        {runs.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: runs.error ?? '读取图稿运行失败', retry: runs.reload }} />
        ) : null}
        {activeRun === null ? null : (
          <ProgressTask
            label={`绘图运行 ${activeRun.request.label}`}
            detail={`状态 ${activeRun.status}`}
            polling
            onCancel={() => void cancel.run(activeRun.id).then(() => runs.reload())}
            testId="production-figure-progress"
          />
        )}
        {(runs.data ?? []).length === 0 ? (
          <InlineHint text="还没有绘图运行记录。" testId="production-figure-runs-empty" />
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="production-figure-run-list">
            {(runs.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                  <span className="min-w-0 flex-1 truncate text-ink">{entry.request.label}</span>
                  <span className="text-subtle">{entry.status}</span>
                  <button
                    type="button"
                    data-testid={`production-figure-select-${entry.id}`}
                    onClick={() => setSelectedRunId(entry.id)}
                    className={secondaryButtonClass}
                  >
                    详情
                  </button>
                  {entry.status === 'completed' ? (
                    <button
                      type="button"
                      data-testid={`production-figure-publish-${entry.id}`}
                      disabled={!canWrite || publish.pending}
                      onClick={() => void publish.run({ runId: entry.id, replacesFigureId: null }).then(() => library.reload())}
                      className={secondaryButtonClass}
                    >
                      发布
                    </button>
                  ) : null}
                </div>
                {entry.files.length === 0 ? null : (
                  <span className="flex flex-wrap items-center gap-1.5 text-[var(--font-micro-size)]">
                    {FIGURE_FILES.map((file) => (
                      <button
                        key={file}
                        type="button"
                        data-testid={`production-figure-preview-${entry.id}-${file}`}
                        onClick={() => void showFigure(entry.id, file)}
                        className={secondaryButtonClass}
                      >
                        <ImageIcon size={11} aria-hidden="true" className="mr-1 inline" />
                        {file}
                      </button>
                    ))}
                  </span>
                )}
                {entry.error === null ? null : <span className="text-[var(--st-bad)] text-[var(--font-micro-size)]">{entry.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {selected === null ? null : (
          <dl className="flex flex-col gap-0.5" data-testid="production-figure-selected">
            <KeyValue label="选中运行" value={`${selected.request.label} · ${selected.status}`} />
            <KeyValue label="环境哈希" value={selected.environment?.hash.slice(0, 16) ?? '—'} />
            <KeyValue label="产物工件" value={selected.artifactId ?? '—'} />
            {selected.status === 'preparing' || selected.status === 'running' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="production-figure-cancel"
                  disabled={cancel.pending}
                  onClick={() => void cancel.run(selected.id).then(() => runs.reload())}
                  className={secondaryButtonClass}
                >
                  <XCircle size={11} aria-hidden="true" className="mr-1 inline" />
                  取消运行
                </button>
              </div>
            ) : null}
          </dl>
        )}
        {publish.error === null ? null : <InlineHint text={publish.error} testId="production-figure-publish-error" />}
        {previewNote === null ? null : (
          <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" data-testid="production-figure-preview-note">
            {previewNote}
          </p>
        )}
        {image === null ? null : (
          <figure className="flex flex-col gap-1" data-testid="production-figure-preview">
            <img src={image.dataUrl} alt="图稿预览" className="max-h-[360px] max-w-full rounded-card border border-line bg-surface object-contain" />
            <figcaption className="text-subtle text-[var(--font-micro-size)]">
              {image.mediaType} · data: URL（研究存储没有文件协议，B21；不使用 Blob URL，也不注入 SVG 标记）
            </figcaption>
          </figure>
        )}
      </PanelSection>

      <PanelSection
        title="图稿库"
        hint="research.figure.list（发布后的可引用图稿）"
        testId="production-figure-library"
        action={{ label: '刷新', onClick: library.reload, busy: library.status === 'loading', testId: 'production-figure-library-refresh' }}
      >
        {library.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: library.error ?? '读取图稿库失败', retry: library.reload }} />
        ) : null}
        {(library.data ?? []).length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="还没有发布的图稿"
            description="绘图运行完成后点「发布」：发布产生可引用图稿，并进入人工闸门（绘图阶段）。"
            compact
            testId="production-figure-library-empty"
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="production-figure-library-list">
            {(library.data ?? []).map((figure) => (
              <li key={figure.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                <span className="min-w-0 flex-1 truncate text-ink" title={figure.title}>
                  {figurePublicationLabel(figure)}
                </span>
                <span className="text-subtle">{figure.sourcePath}</span>
                <span className="text-subtle">{formatBeijingDateTime(figure.createdAt)}</span>
                {figure.replacesFigureId === null ? null : <span className="text-subtle">替换 {figure.replacesFigureId}</span>}
                <button
                  type="button"
                  data-testid={`production-figure-library-preview-svg-${figure.id}`}
                  onClick={() => void showFigure(figure.runId, 'figure.svg')}
                  className={secondaryButtonClass}
                >
                  SVG
                </button>
                <button
                  type="button"
                  data-testid={`production-figure-library-preview-pdf-${figure.id}`}
                  onClick={() => void showFigure(figure.runId, 'figure.pdf')}
                  className={secondaryButtonClass}
                >
                  PDF
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

/** A relative path that escapes the workspace is refused before any IPC (R10). */
function sourcePathIssues(path: string): Array<{ message: string; reference: string | null }> {
  if (path.length === 0) {
    return [];
  }
  const check = checkRelativePath(path);
  if (check.ok) {
    return [];
  }
  return [{ message: `路径被拒绝：${pathRejectionMessage(check.reason)}`, reference: 'sourcePath' }];
}
