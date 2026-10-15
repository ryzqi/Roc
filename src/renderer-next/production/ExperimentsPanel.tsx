import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Play, RefreshCw, XCircle } from 'lucide-react';
import type { FileEntry, ResearchExperimentEnvironment, ResearchExperimentExecution, ResearchExperimentFile, ResearchToolchainStatus } from '../../shared/types';
import type { ResearchExperimentRuntime } from '../../shared/schemas/research-experiments';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ProgressTask } from '../shell/ProgressTask';
import { formatBeijingDateTime, formatBytes } from '../shared/format';
import { listTree } from '../workspace/workspace-store';
import { checkRelativePath, pathRejectionMessage } from '../workspace/paths';
import {
  engineForSourcePath,
  environmentReadiness,
  experimentStartBlockers,
  expectedEnvironmentHash,
  runtimesForEngine,
  type ExperimentEngine
} from './production-rules';
import {
  cancelExperiment,
  getExperiment,
  getEvidenceExperimentSource,
  getToolchainStatus,
  inspectExperimentEnvironment,
  listExperiments,
  publishExperiment,
  readExperimentFile,
  startExperiment
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
  textAreaClass,
  textInputClass
} from './panel-shell';

/**
 * 实验运行 (P7/T7.2).
 *
 * The panel follows the contract rather than the résumé of "run a script":
 *
 *  - **It executes a workspace file.** `research.experiment.start` takes `sourcePath`
 *    (workspace-relative), an `engine` and a `runtime` the schema cross-checks; there is no
 *    "paste a script" input. So the script picker lists the real workspace (`files.listTree`,
 *    root + `scripts/`), and only `.py` files are offered because this panel's engine is Python
 *    (R and Julia need `renv`/`julia` runtimes whose *paths* only the settings centre can bind —
 *    the panel says that instead of offering a runtime that cannot work).
 *  - **The main action is driven by a real probe.** `environment` returns the executable,
 *    version, packages and hashes; 「启动运行」 stays disabled until the probe succeeded *and*
 *    the probed hash is the one the run will be pinned to (`expectedEnvironmentHash`).
 *  - **There is no log push** (B11 has no analogue here). Running progress is **polling**, and
 *    the panel says 「轮询中」 instead of pretending to stream.
 *  - **Publishing is a separate step from running**: `publish` promotes a completed run into the
 *    citable artifact that `research.workflow.transition` then gates (T7.2's 「发布后进入证据链」).
 */

type Draft = {
  runtimeKind: 'bundled-python' | 'uv';
  label: string;
  sourcePath: string;
  inputPaths: string[];
  argumentsText: string;
  parametersText: string;
  timeoutMs: number;
  network: 'disabled' | 'enabled';
};

const defaultDraft: Draft = {
  runtimeKind: 'bundled-python',
  label: '',
  sourcePath: '',
  inputPaths: [],
  argumentsText: '',
  parametersText: '{}',
  timeoutMs: 600_000,
  network: 'disabled'
};

export function ExperimentsPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
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

  const [draft, setDraft] = useState<Draft>(defaultDraft);
  const [probed, setProbed] = useState<{ runtime: ResearchExperimentRuntime; environment: ResearchExperimentEnvironment } | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{ path: string; content: string; encoding: 'utf8' | 'base64' } | null>(null);
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState('');

  const toolchain = useAsyncResource<ResearchToolchainStatus>(
    'experiment-toolchain',
    () => getToolchainStatus(scope.client),
    { label: '读取工具链状态' }
  );
  const runs = useAsyncResource<ResearchExperimentExecution[]>(
    scope.projectId === null ? null : `experiments:${scope.projectId}`,
    () => listExperiments(scope.client, { projectId, limit: 50 }),
    { label: '读取实验运行' }
  );

  /** Script + input candidates: the workspace root and one level of `scripts/`. */
  const files = useAsyncResource<{ path: string; entry: FileEntry }[]>(
    workspacePath === null ? null : `experiment-files:${workspacePath}`,
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
    (runtime: ResearchExperimentRuntime) => inspectExperimentEnvironment(scope.client, { projectId, runtime }),
    { label: '检查实验环境' }
  );
  const run = useAsyncAction(
    (input: { runtime: ResearchExperimentRuntime; environment: ResearchExperimentEnvironment | null }) =>
      startExperiment(scope.client, {
        projectId,
        requestId: `renderer_${crypto.randomUUID()}`,
        label: draft.label.trim(),
        engine: 'python',
        runtime: input.runtime,
        sourcePath: draft.sourcePath,
        inputPaths: draft.inputPaths,
        arguments: splitArguments(draft.argumentsText),
        parameters: parseParameters(draft.parametersText),
        ...(expectedEnvironmentHash(input.environment) === undefined
          ? {}
          : { expectedEnvironmentHash: expectedEnvironmentHash(input.environment) }),
        timeoutMs: draft.timeoutMs,
        network: draft.network
      }),
    { label: '启动实验运行' }
  );
  const cancel = useAsyncAction(
    (runId: string) => cancelExperiment(scope.client, { projectId, runId }),
    { label: '取消实验运行' }
  );
  const publish = useAsyncAction(
    (runId: string) => publishExperiment(scope.client, { projectId, runId }),
    { label: '发布实验运行' }
  );

  const engine: ExperimentEngine | null = draft.sourcePath.length === 0 ? null : engineForSourcePath(draft.sourcePath);
  const runtime: ResearchExperimentRuntime = { kind: draft.runtimeKind };
  const runtimeOptions = runtimesForEngine('python');
  const environment = probed !== null && probed.runtime.kind === draft.runtimeKind ? probed.environment : null;
  const scripts = (files.data ?? []).filter((file) => file.entry.type === 'file' && file.path.toLowerCase().endsWith('.py'));
  const inputCandidates = (files.data ?? []).filter((file) => file.entry.type === 'file' && file.path !== draft.sourcePath);
  const blockers = [
    ...experimentStartBlockers({
      sourcePath: draft.sourcePath.length === 0 ? null : draft.sourcePath,
      environment,
      engine,
      runtime,
      label: draft.label
    }),
    ...sourcePathIssues(draft.sourcePath),
    ...draft.inputPaths.flatMap((path) => sourcePathIssues(path, 'inputPaths')),
    ...(parseParametersFailed(draft.parametersText) ? [{ message: '参数必须是 JSON 对象（值都是字符串）', reference: 'parameters' }] : [])
  ];

  const activeRun = (runs.data ?? []).find((entry) => entry.status === 'preparing' || entry.status === 'running') ?? null;
  const selected = (runs.data ?? []).find((entry) => entry.id === selectedRunId) ?? activeRun ?? (runs.data ?? [])[0] ?? null;

  /** Polling, not streaming: only while something is in flight. */
  const polling = activeRun !== null;
  const refresh = runs.reload;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!polling) {
      return;
    }
    const timer = window.setInterval(() => {
      refreshRef.current();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [polling]);

  const onReadFile = useCallback(
    (file: ResearchExperimentFile) => {
      if (selected === null) {
        return;
      }
      void readExperimentFile(scope.client, {
        projectId,
        runId: selected.id,
        area: file.area,
        path: file.path
      }).then((result) => {
        if (!result.ok) {
          setFileContent({ path: file.path, content: `读取失败：${result.error.message}`, encoding: 'utf8' });
          return;
        }
        setFileContent({ path: result.data.file.path, content: result.data.content, encoding: result.data.encoding });
      });
    },
    [projectId, scope.client, selected]
  );

  if (scope.projectId === null) {
    return <InlineHint text="未进入项目。" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-experiments">
      <PanelSection title="实验环境" hint="research.experiment.environment（探测结果驱动主操作）" testId="production-experiment-environment">
        {toolchain.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: toolchain.error ?? '读取工具链失败', retry: toolchain.reload }} />
        ) : null}
        <dl className="flex flex-col gap-0.5">
          <KeyValue
            label="工具链"
            value={
              toolchain.data === null
                ? '读取中'
                : toolchain.data.available
                  ? `可用 · python ${toolchain.data.versions?.python ?? '?'} · uv ${toolchain.data.versions?.uv ?? '?'} · tectonic ${toolchain.data.versions?.tectonic ?? '?'}`
                  : `不可用：${toolchain.data.error ?? '未知原因'}`
            }
          />
        </dl>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex w-[190px] flex-col gap-0.5">
            <FieldLabel text="运行时（引擎 python）" />
            <select
              data-testid="production-experiment-runtime"
              value={draft.runtimeKind}
              onChange={(event) => {
                const kind = event.target.value as Draft['runtimeKind'];
                setDraft({ ...draft, runtimeKind: kind });
                setProbed(null);
              }}
              className={selectClass}
            >
              {runtimeOptions.map((option) => (
                <option key={option.kind} value={option.kind}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="production-experiment-probe"
            disabled={probe.pending}
            onClick={() => {
              void probe.run(runtime).then((result) => {
                if (result !== null) {
                  setProbed({ runtime, environment: result });
                }
              });
            }}
            className={primaryButtonClass}
          >
            <RefreshCw size={12} aria-hidden="true" className="mr-1 inline" />
            {probe.pending ? '探测中…' : '检查环境'}
          </button>
        </div>
        <p className="text-[var(--font-meta-size)]" data-testid="production-experiment-environment-status">
          {environmentReadiness(environment).summary}
          {environment === null ? '' : ` · ${environmentReadiness(environment).detail}`}
        </p>
        <p className="text-subtle text-[var(--font-micro-size)]">
          R / Julia 需要 `renv` / `julia` 运行时的本地路径，渲染层没有不重绑工作目录的目录选择器，所以这里只支持
          Python（内置 / uv）；renv / julia 的路径绑定属 P8 设置。
        </p>
        {probe.error === null ? null : <InlineHint text={probe.error} testId="production-experiment-probe-error" />}
      </PanelSection>

      <PanelSection title="启动实验运行" hint="research.experiment.start（执行工作区脚本文件）" testId="production-experiment-start">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="标签（必填）" />
            <input
              data-testid="production-experiment-label"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              className={textInputClass}
            />
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="脚本（工作区 .py）" />
            <select
              data-testid="production-experiment-source"
              value={draft.sourcePath}
              onChange={(event) => setDraft({ ...draft, sourcePath: event.target.value })}
              className={selectClass}
            >
              <option value="">— 选择工作区脚本 —</option>
              {scripts.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.path}（{formatBytes(file.entry.size ?? 0)}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-[170px] flex-col gap-0.5">
            <FieldLabel text="超时毫秒（1s–3600s）" />
            <input
              type="number"
              min={1000}
              max={3600000}
              step={1000}
              data-testid="production-experiment-timeout"
              value={draft.timeoutMs}
              onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
              className={textInputClass}
            />
          </label>
          <label className="flex w-[150px] flex-col gap-0.5">
            <FieldLabel text="网络" />
            <select
              data-testid="production-experiment-network"
              value={draft.network}
              onChange={(event) => setDraft({ ...draft, network: event.target.value as Draft['network'] })}
              className={selectClass}
            >
              <option value="disabled">禁用</option>
              <option value="enabled">允许</option>
            </select>
          </label>
        </div>
        {scripts.length === 0 ? (
          <InlineHint text="工作区根目录或 scripts/ 里没有 .py 文件：先用文件视图写一个脚本（或让助手写）。" testId="production-experiment-no-scripts" />
        ) : null}
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="参数（JSON 对象，值都是字符串）" />
            <textarea
              data-testid="production-experiment-parameters"
              value={draft.parametersText}
              rows={2}
              onChange={(event) => setDraft({ ...draft, parametersText: event.target.value })}
              className={textAreaClass}
            />
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="命令行参数（逗号分隔）" />
            <input
              data-testid="production-experiment-arguments"
              value={draft.argumentsText}
              onChange={(event) => setDraft({ ...draft, argumentsText: event.target.value })}
              className={textInputClass}
            />
          </label>
        </div>
        {inputCandidates.length === 0 ? null : (
          <div className="flex flex-col gap-0.5" data-testid="production-experiment-inputs">
            <FieldLabel text="输入文件（可选）" />
            <div className="flex flex-wrap gap-1">
              {inputCandidates.slice(0, 40).map((file) => {
                const checked = draft.inputPaths.includes(file.path);
                return (
                  <label key={file.path} className="flex items-center gap-1.5 rounded-control border border-line px-1.5 py-0.5 text-[var(--font-micro-size)] text-muted">
                    <input
                      type="checkbox"
                      checked={checked}
                      data-testid={`production-experiment-input-${file.path}`}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputPaths: event.target.checked
                            ? [...draft.inputPaths, file.path]
                            : draft.inputPaths.filter((path) => path !== file.path)
                        })
                      }
                    />
                    <span className="truncate">{file.path}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
        <IssueList issues={blockers} testId="production-experiment-issues" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="production-experiment-run"
            disabled={!canWrite || run.pending || blockers.length > 0}
            onClick={() => {
              void run.run({ runtime, environment }).then((started) => {
                if (started !== null) {
                  setSelectedRunId(started.id);
                  runs.reload();
                }
              });
            }}
            className={primaryButtonClass}
          >
            <Play size={12} aria-hidden="true" className="mr-1 inline" />
            启动运行
          </button>
          {environment === null ? (
            <span className="text-[var(--font-micro-size)] text-subtle" data-testid="production-experiment-need-probe">
              先检查环境：主操作由真实探测结果驱动（T7.2）
            </span>
          ) : null}
        </div>
        {run.error === null ? null : <InlineHint text={run.error} testId="production-experiment-run-error" />}
      </PanelSection>

      <PanelSection
        title="运行记录"
        hint={polling ? 'research.experiment.list（轮询中：没有推送接口）' : 'research.experiment.list'}
        testId="production-experiment-runs"
        action={{ label: '刷新', onClick: runs.reload, busy: runs.status === 'loading', testId: 'production-experiment-refresh' }}
      >
        {runs.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: runs.error ?? '读取实验运行失败', retry: runs.reload }} />
        ) : null}
        {activeRun === null ? null : (
          <ProgressTask
            label={`实验运行 ${activeRun.request.label}`}
            detail={`状态 ${activeRun.status}${activeRun.ownerRunId === null ? '' : ' · 由阶段运行发起'}`}
            polling
            onCancel={() => void cancel.run(activeRun.id).then(() => runs.reload())}
            testId="production-experiment-progress"
          />
        )}
        {(runs.data ?? []).length === 0 ? (
          <InlineHint text="还没有实验运行记录。" testId="production-experiment-runs-empty" />
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="production-experiment-run-list">
            {(runs.data ?? []).map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid={`production-experiment-run-${entry.id}`}
                  data-status={entry.status}
                  onClick={() => {
                    setSelectedRunId(entry.id);
                    setFileContent(null);
                  }}
                  className={[
                    'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-card border px-2 py-1.5 text-left',
                    entry.id === selected?.id ? 'border-line-strong bg-surface' : 'border-line bg-bg-soft hover:bg-[var(--overlay-hover)]'
                  ].join(' ')}
                >
                  <span className="flex w-full items-center gap-2 text-[var(--font-meta-size)]">
                    <span className="min-w-0 flex-1 truncate text-ink" title={entry.request.label}>
                      {entry.request.label}
                    </span>
                    <span className="shrink-0 text-subtle">{entry.status}</span>
                    {entry.exitCode === null ? null : <span className="shrink-0 font-mono text-subtle">exit {entry.exitCode}</span>}
                  </span>
                  <span className="text-subtle text-[var(--font-micro-size)]">
                    {entry.request.sourcePath} · {formatBeijingDateTime(entry.createdAt)} · 文件 {entry.files.length}
                  </span>
                  {entry.error === null ? null : (
                    <span className="text-[var(--st-bad)] text-[var(--font-micro-size)]">{entry.error}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {selected === null ? null : (
        <PanelSection
          title="运行详情"
          hint="research.experiment.read / cancel / publish"
          testId="production-experiment-detail"
        >
          <dl className="flex flex-col gap-0.5">
            <KeyValue label="状态" value={selected.status} />
            <KeyValue label="退出码" value={selected.exitCode === null ? '—' : String(selected.exitCode)} />
            <KeyValue label="环境哈希" value={selected.environment?.hash.slice(0, 16) ?? '—'} />
            <KeyValue label="产物工件" value={selected.artifactId ?? '—'} />
            <KeyValue label="开始" value={selected.startedAt === null ? '—' : formatBeijingDateTime(selected.startedAt)} />
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {selected.status === 'preparing' || selected.status === 'running' ? (
              <button
                type="button"
                data-testid="production-experiment-cancel"
                disabled={cancel.pending}
                onClick={() => void cancel.run(selected.id).then(() => runs.reload())}
                className={secondaryButtonClass}
              >
                <XCircle size={11} aria-hidden="true" className="mr-1 inline" />
                取消运行
              </button>
            ) : null}
            {selected.status === 'completed' && selected.artifactId === null ? (
              <button
                type="button"
                data-testid="production-experiment-publish"
                disabled={!canWrite || publish.pending}
                onClick={() => void publish.run(selected.id).then(() => runs.reload())}
                className={primaryButtonClass}
              >
                发布为可引用运行
              </button>
            ) : null}
            {selected.artifactId === null ? null : (
              <span className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="production-experiment-published">
                已发布：{selected.artifactId}
              </span>
            )}
          </div>
          {publish.error === null ? null : <InlineHint text={publish.error} testId="production-experiment-publish-error" />}
          {selected.files.length === 0 ? (
            <InlineHint text="这次运行还没有文件（日志与输出会在运行时出现）。" />
          ) : (
            <ul className="flex flex-col gap-1" data-testid="production-experiment-files">
              {selected.files.map((file) => (
                <li key={`${file.area}:${file.path}`} className="flex items-center gap-2 text-[var(--font-meta-size)]">
                  <span className="w-14 shrink-0 text-subtle">{file.area}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-subtle">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    data-testid={`production-experiment-read-${file.area}-${file.path}`}
                    onClick={() => onReadFile(file)}
                    className={secondaryButtonClass}
                  >
                    <FileText size={11} aria-hidden="true" className="mr-1 inline" />
                    读取
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileContent === null ? null : (
            <div className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2 py-1.5" data-testid="production-experiment-file-content">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]">{fileContent.path}</span>
                <span className="text-subtle text-[var(--font-micro-size)]">{fileContent.encoding}</span>
                <button type="button" onClick={() => setFileContent(null)} className="rounded-control px-1.5 text-subtle hover:text-ink">
                  关闭
                </button>
              </div>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
                {fileContent.content}
              </pre>
            </div>
          )}
        </PanelSection>
      )}

      <PanelSection
        title="证据来源反查"
        hint="research.experiment.evidenceSource（返回运行文件定位）"
        testId="production-experiment-evidence"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[260px] flex-1 flex-col gap-0.5">
            <FieldLabel text="证据 id" />
            <input
              data-testid="production-experiment-evidence-id"
              value={evidenceId}
              onChange={(event) => setEvidenceId(event.target.value)}
              className={textInputClass}
            />
          </label>
          <button
            type="button"
            data-testid="production-experiment-evidence-lookup"
            disabled={evidenceId.trim().length === 0}
            onClick={() => {
              void getEvidenceExperimentSource(scope.client, { projectId, evidenceId: evidenceId.trim() }).then((result) => {
                setSourceNote(
                  result.ok
                    ? result.data === null
                      ? '这条证据不是实验来源（后端返回 null）。'
                      : `来源文件：${result.data.area}/${result.data.path}（运行 ${result.data.runId}）`
                    : result.error.message
                );
              });
            }}
            className={secondaryButtonClass}
          >
            反查
          </button>
        </div>
        {sourceNote === null ? (
          <InlineHint text="输入证据 id（来自「证据与主张」面板），反查它出自哪个运行文件。" />
        ) : (
          <p className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="production-experiment-evidence-note">
            {sourceNote}
          </p>
        )}
      </PanelSection>
    </div>
  );
}

/** A relative path that escapes the workspace is refused before any IPC (R10). */
function sourcePathIssues(path: string, reference = 'sourcePath'): Array<{ message: string; reference: string | null }> {
  if (path.length === 0) {
    return [];
  }
  const check = checkRelativePath(path);
  if (check.ok) {
    return [];
  }
  return [{ message: `路径被拒绝：${pathRejectionMessage(check.reason)}`, reference }];
}

export function splitArguments(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseParameters(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === 'string') {
        result[key] = item;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function parseParametersFailed(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return true;
    }
    return Object.values(parsed).some((item) => typeof item !== 'string');
  } catch {
    return true;
  }
}
