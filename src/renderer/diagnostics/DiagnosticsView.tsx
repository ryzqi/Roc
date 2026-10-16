import { AlertTriangle, CheckCircle2, Copy, HelpCircle, Play, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  BackgroundTask,
  DiagnosticCheck,
  DiagnosticPackage,
  HealthCheckResult,
  MetricsSnapshot,
  PerformanceSample
} from '../../shared/types';
import { errorMessage, type IpcLikeResult } from '../app/loaded-state';
import { useWorkspaceScope } from '../app/workspace-scope';
import { ErrorBar } from '../shell/ErrorBar';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import { formatBeijingDateTime, formatDurationMs, formatCount } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import { explainRunError } from '../canvas/workflow/format';
import { taskStatusLabels } from '../tasks/task-model';
import { listBackgroundTasks } from '../tasks/task-store';
import {
  DIAGNOSTIC_MEMORY_BUDGET_MB,
  createDiagnosticPackage,
  getAppStatusMode,
  getMetricsSnapshot,
  runChecks,
  runHealthCheck,
  samplePerformance
} from './diagnostics-store';

/**
 * 运行诊断 (P6/T6.8).
 *
 * Everything here is **on demand**: the plan says performance sampling must not auto-poll
 * (it measures the app, so a timer would measure its own overhead), and the same holds for
 * checks and the health probe. Loading state is therefore per-section and explicit rather
 * than a page-level spinner that implies an automatic refresh is happening.
 *
 * Two grounded constraints, both visible in the UI instead of hidden:
 *
 *   - **A diagnostic package needs a task.** `diagnostics.createPackage` takes
 *     `{ taskId, errorSummary }`; the package collects that task's snapshot, logs and
 *     recovery points. A failed *stage run* has no task id, so this page explains that a
 *     stage failure is diagnosed from its own error marker and the workflow events, and the
 *     package button stays disabled until a task is chosen. (Registered in F18; a
 *     stage-run-scoped package would need a backend change.)
 *   - **Only backend fields are shown.** `diagnostics.getMetricsSnapshot` returns real
 *     metric rows; nothing is invented for a nicer table, and the summary counters are the
 *     backend's own.
 *
 * The stage's `lastError` is pre-filled as the package's `errorSummary`, which is what makes
 * 「从总览的失败原因一键跳诊断」 useful without copying the text by hand.
 */

type Loadable<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null; error: string | null };

const idle = <T,>(): Loadable<T> => ({ status: 'idle', data: null, error: null });

export function DiagnosticsView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const workflow = useWorkflow();
  const [checks, setChecks] = useState<Loadable<DiagnosticCheck[]>>(idle);
  const [health, setHealth] = useState<Loadable<HealthCheckResult>>(idle);
  const [metrics, setMetrics] = useState<Loadable<MetricsSnapshot>>(idle);
  const [performance, setPerformance] = useState<Loadable<PerformanceSample>>(idle);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [errorSummary, setErrorSummary] = useState('');
  const [diagnosticPackage, setDiagnosticPackage] = useState<Loadable<DiagnosticPackage>>(idle);
  const copy = useCopyFeedback();

  const stageError =
    workflow.workflow === null
      ? null
      : (workflow.workflow.stages.find((stage) => stage.stage === workflow.workflow?.currentStage)?.lastError ?? null);

  // Pre-fill from the stage's reason once it is known, without overwriting anything typed.
  useEffect(() => {
    if (stageError === null) {
      return;
    }
    setErrorSummary((current) => (current.trim().length === 0 ? explainRunError(stageError) : current));
  }, [stageError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listBackgroundTasks(scope.client);
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setTasksError(result.error.message);
        return;
      }
      setTasks(result.data);
      const failed = result.data.find((task) => task.lastRunStatus === 'failed' || task.status === 'failed');
      if (failed !== undefined) {
        setSelectedTaskId((current) => (current.length === 0 ? failed.id : current));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope.client]);

  /**
   * One loader for all five actions.
   *
   * The `catch` is the point: an IPC *rejection* (no preload bridge, a serialisation failure)
   * would otherwise leave the section spinning forever, which reads as "the backend is slow"
   * rather than "this failed" — the same class of bug as P5's 「Roc 内部错误」.
   */
  const load = useCallback(
    async <T,>(setter: (value: Loadable<T>) => void, action: () => Promise<IpcLikeResult<T>>): Promise<void> => {
      setter({ status: 'loading', data: null, error: null });
      try {
        const result = await action();
        setter(
          result.ok
            ? { status: 'ready', data: result.data, error: null }
            : { status: 'error', data: null, error: result.error.message }
        );
      } catch (caught) {
        setter({ status: 'error', data: null, error: errorMessage(caught) });
      }
    },
    []
  );

  const loadChecks = useCallback((): void => {
    void load<DiagnosticCheck[]>(setChecks, () => runChecks(scope.client));
  }, [load, scope.client]);

  const loadHealth = useCallback((): void => {
    void load<HealthCheckResult>(setHealth, () => runHealthCheck(scope.client));
  }, [load, scope.client]);

  const loadMetrics = useCallback((): void => {
    void load<MetricsSnapshot>(setMetrics, () => getMetricsSnapshot(scope.client));
  }, [load, scope.client]);

  const loadPerformance = useCallback((): void => {
    void load<PerformanceSample>(setPerformance, async () => {
      const status = await getAppStatusMode(scope.client);
      // The budget has to be the one the backend compares against, so it is passed explicitly
      // rather than invented per call site.
      const mode = status.ok ? status.data.mode : 'development';
      return await samplePerformance(scope.client, { mode, memoryBudgetMb: DIAGNOSTIC_MEMORY_BUDGET_MB });
    });
  }, [load, scope.client]);

  const createPackage = useCallback((): void => {
    if (selectedTaskId.length === 0) {
      setDiagnosticPackage({ status: 'error', data: null, error: '先选择一个任务：诊断包按任务收集快照、日志与恢复点。' });
      return;
    }
    void load<DiagnosticPackage>(setDiagnosticPackage, () =>
      createDiagnosticPackage(scope.client, {
        taskId: selectedTaskId,
        errorSummary: errorSummary.trim().length === 0 ? '未填写失败摘要' : errorSummary.trim()
      })
    );
  }, [errorSummary, load, scope.client, selectedTaskId]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4" data-testid="diagnostics-view">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-ink text-[var(--font-h2-size)]">运行诊断</h1>
        <span className="text-subtle text-[var(--font-meta-size)]">
          全部按需触发，不自动轮询；性能采样的内存预算为 {DIAGNOSTIC_MEMORY_BUDGET_MB} MB（与后端诊断包回退值一致）
        </span>
      </header>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title="调度与运行检查"
          testId="diagnostics-checks"
          action={{ label: '运行检查', onClick: loadChecks, busy: checks.status === 'loading' }}
        >
          {checks.status === 'idle' ? <Hint text="尚未运行检查：diagnostics.runChecks 会检查调度器是否运行、任务是否注册、是否漏跑、cron 是否合法。" /> : null}
          {checks.status === 'error' ? <SectionError message={checks.error ?? '运行检查失败'} /> : null}
          {checks.data === null ? null : checks.data.length === 0 ? (
            <Hint text="后端没有返回任何检查项。" />
          ) : (
            <ul className="flex flex-col gap-1" data-testid="diagnostics-check-list">
              {checks.data.map((check) => (
                <li key={check.id} className="flex items-start gap-2 text-[var(--font-meta-size)]">
                  <StatusMark status={check.status} />
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{check.label}</span>
                    <span className="ml-1.5 text-subtle">{check.message}</span>
                  </span>
                  <span className="shrink-0 font-mono text-subtle text-[var(--font-micro-size)]">{check.id}</span>
                  <time className="shrink-0 text-subtle text-[var(--font-micro-size)]" dateTime={check.checkedAt}>
                    {formatBeijingDateTime(check.checkedAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="主机与运行时健康"
          testId="diagnostics-health"
          action={{ label: '运行健康检查', onClick: loadHealth, busy: health.status === 'loading' }}
        >
          {health.status === 'idle' ? <Hint text="尚未运行：diagnostics.runHealthCheck 检查数据库、调度器、磁盘、内存与 provider 连通性。" /> : null}
          {health.status === 'error' ? <SectionError message={health.error ?? '健康检查失败'} /> : null}
          {health.data === null ? null : (
            <>
              <p className="text-[var(--font-meta-size)]" data-testid="diagnostics-health-status">
                总体：<span className="text-ink">{health.data.status}</span>
              </p>
              <ul className="flex flex-col gap-1">
                {health.data.checks.map((check) => (
                  <li key={check.name} className="flex items-start gap-2 text-[var(--font-meta-size)]">
                    <StatusMark status={check.status} />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{check.name}</span>
                      {check.message === undefined ? null : <span className="ml-1.5 text-subtle">{check.message}</span>}
                    </span>
                    <time className="shrink-0 text-subtle text-[var(--font-micro-size)]" dateTime={check.lastChecked}>
                      {formatBeijingDateTime(check.lastChecked)}
                    </time>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section
          title="指标快照"
          testId="diagnostics-metrics"
          action={{ label: '读取指标', onClick: loadMetrics, busy: metrics.status === 'loading' }}
        >
          {metrics.status === 'idle' ? <Hint text="尚未读取：diagnostics.getMetricsSnapshot 返回后端登记的真实指标。" /> : null}
          {metrics.status === 'error' ? <SectionError message={metrics.error ?? '读取指标失败'} /> : null}
          {metrics.data === null ? null : metrics.data.metrics.length === 0 ? (
            <Hint text="后端当前没有登记任何指标（计数全为 0）。" />
          ) : (
            <>
              <p className="text-subtle text-[var(--font-micro-size)]" data-testid="diagnostics-metrics-summary">
                共 {formatCount(metrics.data.summary.totalMetrics)} · counter {metrics.data.summary.counterCount} · gauge{' '}
                {metrics.data.summary.gaugeCount} · histogram {metrics.data.summary.histogramCount}（
                {formatBeijingDateTime(metrics.data.generatedAt)}）
              </p>
              <table className="w-full border-collapse text-left" data-testid="diagnostics-metrics-table">
                <thead>
                  <tr className="text-subtle text-[var(--font-micro-size)]">
                    <th scope="col" className="pb-1 font-normal">名称</th>
                    <th scope="col" className="pb-1 font-normal">类型</th>
                    <th scope="col" className="pb-1 font-normal">值</th>
                    <th scope="col" className="pb-1 font-normal">标签</th>
                    <th scope="col" className="pb-1 font-normal">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.data.metrics.map((metric, index) => (
                    <tr key={`${metric.name}-${index}`} className="border-t border-line">
                      <td className="py-1 font-mono text-[var(--font-micro-size)] text-ink">{metric.name}</td>
                      <td className="py-1 text-subtle text-[var(--font-micro-size)]">{metric.type}</td>
                      <td className="py-1 font-mono text-[var(--font-micro-size)] text-ink">{metric.value}</td>
                      <td className="py-1 font-mono text-subtle text-[var(--font-micro-size)]">
                        {Object.entries(metric.labels).map(([key, value]) => `${key}=${value}`).join(' ')}
                      </td>
                      <td className="py-1 text-subtle text-[var(--font-micro-size)]">{formatBeijingDateTime(metric.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Section>

        <Section
          title="性能采样"
          testId="diagnostics-performance"
          action={{ label: '采样一次', onClick: loadPerformance, busy: performance.status === 'loading' }}
        >
          {performance.status === 'idle' ? (
            <Hint text="按需触发：diagnostics.samplePerformance 测量 RSS / 堆 / 计时与 IPC 汇总，不自动轮询。" />
          ) : null}
          {performance.status === 'error' ? <SectionError message={performance.error ?? '采样失败'} /> : null}
          {performance.data === null ? null : (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[var(--font-meta-size)]" data-testid="diagnostics-performance-facts">
              <Fact label="采样时间" value={formatBeijingDateTime(performance.data.sampledAt)} />
              <Fact label="运行模式" value={performance.data.mode} />
              <Fact label="RSS" value={`${performance.data.rssMb} MB`} />
              <Fact label="堆" value={`${performance.data.heapUsedMb} / ${performance.data.heapTotalMb} MB`} />
              <Fact label="私有字节" value={performance.data.totalPrivateBytesMb === null ? '不可用' : `${performance.data.totalPrivateBytesMb} MB`} />
              <Fact label="工作集" value={`${performance.data.totalWorkingSetMb} MB`} />
              <Fact label="内存测量" value={performance.data.memoryMeasurement} />
              <Fact label="超预算" value={performance.data.exceedsBudget ? '是' : '否'} />
              <Fact label="运行时长" value={formatDurationMs(performance.data.uptimeSeconds * 1000)} />
              <Fact label="IPC 调用" value={formatCount(performance.data.ipc.totalCalls)} />
              <Fact
                label="IPC 最慢通道"
                value={
                  performance.data.ipc.topSlowCalls.length === 0
                    ? '无样本'
                    : `${performance.data.ipc.topSlowCalls[0]?.channel ?? ''} ${formatDurationMs(performance.data.ipc.topSlowCalls[0]?.totalDurationMs ?? 0)}`
                }
              />
              <Fact label="Electron 进程" value={formatCount(performance.data.electron.processCount)} />
            </dl>
          )}
        </Section>
      </div>

      <Section
        title="诊断包"
        testId="diagnostics-package"
        action={{ label: '生成诊断包', onClick: createPackage, busy: diagnosticPackage.status === 'loading' }}
      >
        {stageError === null ? null : (
          <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" data-testid="diagnostics-stage-error">
            当前阶段最近一次失败：{explainRunError(stageError)}
          </p>
        )}
        <label className="flex flex-col gap-0.5 text-[var(--font-meta-size)]">
          <span className="text-subtle text-[var(--font-micro-size)]">任务（诊断包按任务收集，必填）</span>
          <select
            value={selectedTaskId}
            data-testid="diagnostics-package-task"
            onChange={(event) => setSelectedTaskId(event.target.value)}
            className="h-[var(--control-height)] max-w-[420px] rounded-control border border-line bg-bg px-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <option value="">— 选择后台任务 —</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {taskStatusLabels[task.status]} · {task.goal.slice(0, 40)}
              </option>
            ))}
          </select>
        </label>
        {tasksError === null ? null : <SectionError message={`读取后台任务失败：${tasksError}`} />}
        {tasks.length === 0 && tasksError === null ? (
          <Hint text="本项目还没有后台任务：诊断包无法生成（它需要一个任务 ID）。阶段运行的失败请直接看上面的失败原因与活动流。" />
        ) : null}
        <label className="flex flex-col gap-0.5 text-[var(--font-meta-size)]">
          <span className="text-subtle text-[var(--font-micro-size)]">失败摘要（diagnostics.createPackage 的 errorSummary）</span>
          <textarea
            value={errorSummary}
            rows={2}
            data-testid="diagnostics-package-error-summary"
            onChange={(event) => setErrorSummary(event.target.value)}
            placeholder="描述这次失败，例如复制阶段失败原因。"
            className="w-full resize-y rounded-control border border-line bg-bg px-2 py-1 text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
        </label>
        {diagnosticPackage.status === 'error' ? <SectionError message={diagnosticPackage.error ?? '生成诊断包失败'} /> : null}
        {diagnosticPackage.data === null ? null : (
          <div className="flex flex-col gap-1" data-testid="diagnostics-package-result">
            <p className="text-[var(--font-meta-size)]">
              路径：<code className="font-mono text-ink" data-testid="diagnostics-package-path">{diagnosticPackage.data.path}</code>
            </p>
            <p className="text-subtle text-[var(--font-micro-size)]">
              {formatBeijingDateTime(diagnosticPackage.data.createdAt)} · 脱敏 {diagnosticPackage.data.redacted ? '已脱敏' : '未脱敏'} · 包含{' '}
              {diagnosticPackage.data.includes.join('、')}
            </p>
            <button
              type="button"
              data-testid="diagnostics-package-copy"
              onClick={() => copy.copy(diagnosticPackage.data?.path ?? '')}
              className="flex h-[var(--control-height-compact)] items-center gap-1 self-start rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              <Copy size={12} aria-hidden="true" />
              {copy.copied ? '已复制' : '复制路径'}
            </button>
            {copy.error === null ? null : <p className="text-[var(--st-bad)] text-[var(--font-micro-size)]">{copy.error}</p>}
          </div>
        )}
      </Section>

      <p className="text-subtle text-[var(--font-micro-size)]">
        日志浏览按计划不做（没有 IPC，只有 scripts/query-logs.mjs）；诊断包是唯一入口。后端任务单 B10 登记了 diagnostics.queryLogs。
      </p>
    </div>
  );
}

function Section({
  title,
  testId,
  action,
  children
}: {
  title: string;
  testId: string;
  action?: { label: string; onClick: () => void; busy: boolean };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5" data-testid={testId}>
      <header className="flex items-center gap-2">
        <h2 className="text-ink text-[var(--font-h3-size)]">{title}</h2>
        {action === undefined ? null : (
          <button
            type="button"
            data-testid={`${testId}-run`}
            disabled={action.busy}
            onClick={action.onClick}
            className="ml-auto flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50"
          >
            <Play size={11} aria-hidden="true" />
            {action.busy ? '执行中…' : action.label}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function Hint({ text }: { text: string }): React.JSX.Element {
  return (
    <p className="text-muted text-[var(--font-meta-size)]" role="status">
      {text}
    </p>
  );
}

function SectionError({ message }: { message: string }): React.JSX.Element {
  return <ErrorBar error={{ level: 'blocked', message }} />;
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-subtle text-[var(--font-micro-size)]">{label}</dt>
      <dd className="font-mono text-ink text-[var(--font-micro-size)]">{value}</dd>
    </>
  );
}

function StatusMark({ status }: { status: 'pass' | 'warn' | 'fail' }): React.JSX.Element {
  if (status === 'pass') {
    return <CheckCircle2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-ok)]" />;
  }
  if (status === 'warn') {
    return <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-warn)]" />;
  }
  if (status === 'fail') {
    return <XCircle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-bad)]" />;
  }
  return <HelpCircle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-subtle" />;
}
