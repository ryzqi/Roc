import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type {
  RunDiagnostics as RunDiagnosticsData,
  RunTraceSpan
} from '../../shared/schemas/run-diagnostics';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';

const countFormatter = new Intl.NumberFormat('zh-CN');
const formatCount = (value: number | null): string => value === null ? '未知' : countFormatter.format(value);
const formatDuration = (value: number | null): string => value === null ? '未知' : `${formatCount(value)} ms`;

const operationLabels: Record<RunTraceSpan['operation'], string> = {
  run: '运行',
  agent_model: '模型调用',
  summary_model: '摘要模型调用',
  context_compaction: '上下文压缩',
  context_summary: '上下文摘要',
  tool_effect: '工具执行',
  tool_admission: '工具准入',
  approval_wait: '等待审批',
  subagent: '子任务',
  recovery: '恢复',
  checkpoint_resume: '检查点续跑'
};

const statusLabels: Record<RunTraceSpan['status'], string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已挂起',
  skipped: '已跳过',
  blocked: '已阻止'
};

function DiagnosticRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-2">
      <dt className="text-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-right font-mono text-ink">{value}</dd>
    </div>
  );
}

function DiagnosticsContent({ data }: { data: RunDiagnosticsData }): React.JSX.Element {
  const audit = data.context.contractAudit;
  const missingRequirements = audit.missingConstraintCount + audit.missingAcceptanceConditionCount +
    audit.missingPendingEffectCount + audit.missingPendingApprovalCount + audit.missingPendingCorrectionCount +
    audit.missingEvidenceLocatorCount;
  const checkedRequirements = audit.constraintCount + audit.acceptanceConditionCount +
    audit.pendingEffectCount + audit.pendingApprovalCount + audit.pendingCorrectionCount +
    audit.evidenceLocatorCount + audit.missingEvidenceLocatorCount;
  const invalidRequirements = audit.invalidEvidenceLocatorCount + audit.invalidContractCount;
  const summarySpans = data.trace.spans.filter((span) => span.operation === 'context_summary');
  const measuredSummarySpans = summarySpans.filter((span) => span.durationMs !== null);
  const summaryDuration = measuredSummarySpans.length === 0 ? null :
    measuredSummarySpans.reduce((total, span) => total + (span.durationMs ?? 0), 0);
  const contextQuality = data.context.compactionCount === 0 ? '尚未压缩' :
    `检查 ${formatCount(checkedRequirements)} 项 / 缺失 ${formatCount(missingRequirements)} 项 / 无效 ${formatCount(invalidRequirements)} 项`;

  return (
    <div className="grid gap-3" data-testid="assistant-diagnostics-data">
      <dl className="grid gap-1">
        <DiagnosticRow label="Provider / 模型" value={`${data.providerId} / ${data.modelId}`} />
        <DiagnosticRow label="运行状态" value={data.terminalStatus === null ? '未终结' : statusLabels[data.terminalStatus]} />
        <DiagnosticRow label="运行耗时" value={formatDuration(data.totalDurationMs)} />
        <DiagnosticRow label="模型调用" value={formatCount(data.model.callCount)} />
        <DiagnosticRow label="usage 未知调用" value={formatCount(data.model.unknownUsageCallCount)} />
        <DiagnosticRow label="已知输入 / 输出 tokens" value={`${formatCount(data.model.inputTokens)} / ${formatCount(data.model.outputTokens)}`} />
        <DiagnosticRow label="工具调用 / 错误" value={`${formatCount(data.tool.callCount)} / ${formatCount(data.tool.errorCount)}`} />
        <DiagnosticRow label="子任务 / 失败" value={`${formatCount(data.subagent.count)} / ${formatCount(data.subagent.failedCount)}`} />
        <DiagnosticRow label="压缩 / 摘要" value={`${formatCount(data.context.compactionCount)} / ${formatCount(data.context.summaryCount)}`} />
        <DiagnosticRow label="摘要耗时（已保留 spans）" value={formatDuration(summaryDuration)} />
        <DiagnosticRow
          label="上下文输入 / 预算 tokens"
          value={`${formatCount(data.context.inputTokens)} / ${formatCount(data.context.budgetTokens)}${data.context.lastInputEstimated === null ? '' : data.context.lastInputEstimated ? '（估算）' : '（计数）'}`}
        />
        <DiagnosticRow label="压缩移除 / 外存字符" value={`${formatCount(data.context.removedChars)} / ${formatCount(data.context.persistedChars)}`} />
        <DiagnosticRow label="准入等待 / 持锁总耗时" value={`${formatDuration(data.toolAdmission.wait.totalMs)} / ${formatDuration(data.toolAdmission.hold.totalMs)}`} />
        <DiagnosticRow label="准入冲突 / 取消" value={`${formatCount(data.toolAdmission.contendedCount)} / ${formatCount(data.toolAdmission.cancellationCount)}`} />
      </dl>
      <section className="grid gap-1 border-t border-line pt-2" aria-label="上下文保留检查">
        <div className="flex flex-wrap justify-between gap-1">
          <h3 className="font-medium text-ink">上下文保留检查</h3>
          <span className={missingRequirements + invalidRequirements > 0 ? 'text-[var(--st-warn)]' : 'text-subtle'}>{contextQuality}</span>
        </div>
        <dl className="grid gap-1">
          <DiagnosticRow label="约束 / 验收条件" value={`${formatCount(audit.constraintCount)} / ${formatCount(audit.acceptanceConditionCount)}`} />
          <DiagnosticRow label="待处理 effect / 审批 / 纠正" value={`${formatCount(audit.pendingEffectCount)} / ${formatCount(audit.pendingApprovalCount)} / ${formatCount(audit.pendingCorrectionCount)}`} />
          <DiagnosticRow label="证据定位 / 缺失 / 无效" value={`${formatCount(audit.evidenceLocatorCount)} / ${formatCount(audit.missingEvidenceLocatorCount)} / ${formatCount(audit.invalidEvidenceLocatorCount)}`} />
          <DiagnosticRow label="损坏 contract" value={formatCount(audit.invalidContractCount)} />
          <DiagnosticRow label="工作区版本" value={data.context.compactionCount === 0 ? '尚未检查' : audit.workspaceVersionPresent ? '已保留' : '未提供'} />
        </dl>
      </section>
      <details className="border-t border-line pt-2" data-testid="assistant-diagnostics-spans">
        <summary className="cursor-pointer rounded-control text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
          本地 trace：{formatCount(data.trace.spans.length)} spans
          {data.trace.droppedSpanCount > 0 ? ` / 超限未保留 ${formatCount(data.trace.droppedSpanCount)}` : ''}
        </summary>
        {data.trace.spans.length === 0 ? <p className="pt-2 text-subtle">该运行没有 trace 记录。</p> : (
          <ol className="grid gap-2 pt-2">
            {data.trace.spans.map((span) => (
              <li key={span.spanId} className="grid gap-0.5">
                <div className="flex flex-wrap justify-between gap-1 text-ink">
                  <span>{operationLabels[span.operation]}</span>
                  <span>{statusLabels[span.status]} / {formatDuration(span.durationMs)}</span>
                </div>
                <p className="break-words font-mono text-subtle">
                  {span.spanId} / {span.parentSpanId === null ? '根节点' : `父级 ${span.parentSpanId}`}
                  {span.checkpointId === null ? '' : ` / ${span.checkpointId}`}
                </p>
                {span.operation === 'agent_model' || span.operation === 'summary_model' ? (
                  <p className="text-subtle">
                    输入估算 {formatCount(span.estimatedInputTokens)} / 实际 {formatCount(span.actualInputTokens)}
                    {span.estimatedInputTokens === null || span.actualInputTokens === null ? ' / 误差未知' :
                      ` / 误差 ${formatCount(span.estimatedInputTokens - span.actualInputTokens)}`}
                    {' / 输出 '}{formatCount(span.actualOutputTokens)}
                    {span.estimateApproximate === true ? ' / 近似估算' : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

export function RunDiagnostics({
  client,
  runId,
  threadId,
  runStatus
}: {
  client: RocClient;
  runId: string;
  threadId: string;
  runStatus: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  // Status changes refresh an open disclosure; streaming deltas do not trigger extra IPC reads.
  const resource = useAsyncResource<RunDiagnosticsData | null>(
    open ? `diagnostics:${threadId}:${runId}:${runStatus}` : null,
    async () => {
      const result = await client.api.agent.getRunDiagnostics({ runId, threadId });
      if (result.ok && result.data !== null &&
        (result.data.runId !== runId || result.data.threadId !== threadId)) {
        throw new Error('运行诊断身份不匹配');
      }
      return result;
    },
    { label: '读取运行诊断' }
  );

  return (
    <div className="min-w-0 text-[var(--font-meta-size)]" data-testid="assistant-diagnostics">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
          data-testid="assistant-diagnostics-toggle"
          className="flex min-w-0 items-center gap-1 rounded-control px-1 py-1 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          运行诊断
        </button>
        {open ? (
          <button
            type="button"
            onClick={resource.reload}
            disabled={resource.status === 'loading'}
            aria-label="刷新运行诊断"
            data-testid="assistant-diagnostics-refresh"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {open ? (
        <section
          id={regionId}
          aria-label="运行诊断"
          aria-busy={resource.status === 'loading'}
          tabIndex={0}
          data-testid="assistant-diagnostics-region"
          className="mt-1 max-h-[min(45vh,24rem)] overflow-y-auto rounded-control border-[0.5px] border-line p-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <p className="mb-2 text-subtle">仅本地脱敏数据，终态保留 30 天。未知 usage 不按零计算。</p>
          {resource.status === 'loading' ? <p role="status" className="text-subtle">读取诊断中…</p> :
            resource.status === 'error' ? <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p> :
              resource.data === null ? <p role="status" className="text-subtle">该运行没有诊断记录。</p> :
                <DiagnosticsContent data={resource.data} />}
        </section>
      ) : null}
    </div>
  );
}
