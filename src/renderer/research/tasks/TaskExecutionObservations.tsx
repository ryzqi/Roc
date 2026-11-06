import {useEffect, useState} from 'react';
import type {ResearchTaskExecutionDiagnostics} from '../../../shared/schemas/research-task-diagnostics';
import {useAsyncResource} from '../../app/use-async-resource';
import {formSecondaryButtonClass} from '../../shared/form-ui';
import type {RocClient} from '../../shared/roc-client';
const cost = (value: number|null) => value === null ? '未知' : `$${(value / 1_000_000).toFixed(6)}`;
const operations = {run:'运行', agent_model:'模型执行', summary_model:'摘要模型', context_compaction:'上下文压缩',
  context_summary:'上下文摘要', tool_effect:'工具执行', tool_admission:'工具资源排队', approval_wait:'等待审批',
  subagent:'子任务', recovery:'恢复', checkpoint_resume:'检查点恢复'};
function Observations({client, execution}: {client: RocClient; execution: ResearchTaskExecutionDiagnostics}): React.JSX.Element {
  const {association} = execution;
  const [afterCallSequence, setAfterCallSequence] = useState(0);
  const [afterEventSequence, setAfterEventSequence] = useState(0);
  const request = {projectId: association.projectId, taskId: association.taskId, executionKind: association.kind,
    executionId: association.executionId, afterCallSequence, afterEventSequence, limit: 50};
  const resource = useAsyncResource(JSON.stringify(['task-observations', request]),
    () => client.api.research.getTaskExecutionDiagnostics(request), {label: '读取调用与观测'});
  const reload = resource.reload;
  useEffect(() => client.api.research.onTaskUpdated(event => {
    if (event.taskId === association.taskId && event.projectId === association.projectId) reload();
  }), [client, association.taskId, association.projectId, reload]);
  const data = resource.data;
  const telemetry = data === null ? execution.telemetry : data.telemetry;
  return <div className="grid min-w-0 gap-2 pt-2" data-testid="mgmt-task-observations">
    <button type="button" className={`${formSecondaryButtonClass} justify-self-start`} onClick={reload}>刷新观测</button>
    {resource.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>}
    {resource.status === 'loading' ? <p role="status">读取观测中…</p> : null}
    {telemetry === null ? <p className="text-subtle">运行观测未知：尚无持久化回执。</p> : <>
      <p className="text-subtle tabular-nums">首次输出 {telemetry.firstOutputMs === null ? '未知' : `${telemetry.firstOutputMs} ms`}
        {' / 工具失败 '}{telemetry.toolErrors}/{telemetry.toolCalls}
        {' / 资源等待 '}{telemetry.admission.waitMs} ms</p>
      <ol className="grid gap-1 text-subtle" aria-label="运行时间线">
        {telemetry.trace.spans.map(span => <li key={span.spanId} className="break-words tabular-nums">
          {span.spanId} / {operations[span.operation]} / {span.status} / {span.durationMs === null ? '耗时未知' : `${span.durationMs} ms`}
        </li>)}
      </ol>
      {telemetry.trace.droppedSpanCount === 0 ? null : <p className="text-[var(--st-warn)]">时间线已省略 {telemetry.trace.droppedSpanCount} 项。</p>}
    </>}
    {data === null ? null : <>
      <p className="text-subtle">模型调用耗时来自实际调用；未记录的耗时与费用显示未知。</p>
      <ol className="grid gap-2" aria-label="预算调用">
        {data.calls.calls.map(call => <li key={call.sequence} className="grid gap-1" data-testid="mgmt-task-call">
          <p className="break-all font-mono">调用 {call.callId}</p>
          <p className="text-subtle">{call.kind} / {call.state} / {call.invocation === null ? '耗时未知' : `${call.invocation.durationMs} ms / ${call.invocation.status}`}</p>
          <p className="text-subtle">已结算 {cost(call.actualCostMicrousd)} / 预留 {cost(call.reservedCostMicrousd)} / Tokens {call.actualTokens ?? '未知'}</p>
        </li>)}
      </ol>
      {data.calls.calls.length === 0 ? <p className="text-subtle">当前页没有预算调用。</p> : null}
      {data.calls.hasMore ? <button type="button" className={`${formSecondaryButtonClass} justify-self-start`} disabled={resource.status === 'loading'}
        onClick={() => setAfterCallSequence(data.calls.nextSequence)}>下一页调用</button> : null}
      {data.replay === null ? <p className="text-subtle">此执行没有主助手重放日志。</p> : <>
        {data.replay.gap === null ? null : <p className="text-[var(--st-warn)]" data-testid="mgmt-task-replay-gap">
          事件历史存在缺口，已折叠至 #{data.replay.gap.throughSequence}；{data.replay.gap.historyComplete ? '快照完整' : '快照历史不完整'}。
        </p>}
        <ol className="grid gap-1 text-subtle" aria-label="事件重放">
          {data.replay.events.map(event => <li key={event.sequence} className="break-all">
            #{event.sequence} {event.type}{event.toolCallId === null ? '' : ` / 工具调用 ${event.toolCallId}`}
            {event.status === null ? '' : ` / ${event.status}`}{event.failed ? ' / 失败' : ''}
          </li>)}
        </ol>
        {data.replay.hasMore ? <button type="button" className={`${formSecondaryButtonClass} justify-self-start`} disabled={resource.status === 'loading'}
          onClick={() => setAfterEventSequence(data.replay!.nextSequence)}>下一页事件</button> : null}
      </>}
      {data.resources === null ? <p className="text-subtle">进程资源未知：没有资源回执。</p> : <div className="grid gap-1 text-subtle" data-testid="mgmt-task-resources">
        <p>进程资源 / {data.resources.outcome}</p>
        <p>排队 {data.resources.admission === null ? '未知' : `${data.resources.admission.waitMs} ms`}
          {' / CPU '}{data.resources.usage?.observedCpuTimeMs === null || data.resources.usage === null ? '未知' : `${data.resources.usage.observedCpuTimeMs} ms`}
          {' / 峰值内存 '}{data.resources.usage?.peakResidentBytes === null || data.resources.usage === null ? '未知' : `${data.resources.usage.peakResidentBytes} B`}</p>
        {data.resources.probes.map((probe,index) => <p key={index}>{probe.phase} / {probe.kind} / {probe.outcome} / 排队 {probe.admission?.waitMs ?? '未知'} ms</p>)}
      </div>}
    </>}
  </div>;
}
export function TaskExecutionObservations(props: {client: RocClient; execution: ResearchTaskExecutionDiagnostics}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-subtle">调用与观测</summary>
    {open ? <Observations {...props} /> : null}
  </details>;
}
