import {useEffect, useRef} from 'react';
import type { ResearchTaskDiagnostics, ResearchTaskExecutionDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import type { RunUsageStatus } from '../../../shared/types';
import {STAGE_LABELS} from '../../project/project-store';
import {formatBeijingDateTime} from '../../shared/format';
import {recordUxEvent} from '../../app/ux-metrics';
import type {OpenResearchArtifact} from '../../artifacts/artifact-interactions';
import {formSecondaryButtonClass} from '../../shared/form-ui';
import {ActionStatus} from '../../shared/action-status';
import {researchTaskPresentation, researchTaskReasonLabel} from './task-presentation';
const number = new Intl.NumberFormat('zh-CN');
const executionLabels = {chat: '主助手', stage: '科研阶段', experiment: '实验', figure: '图稿', export: '导出', review_search: '综述查询'};
const executionLabel = (execution: ResearchTaskExecutionDiagnostics): string =>
  execution.stage === null ? executionLabels[execution.association.kind] : STAGE_LABELS[execution.stage];

export function TaskUsage({ usage }: { usage: RunUsageStatus }): React.JSX.Element {
  return (
    <dl className="grid gap-1 tabular-nums text-subtle text-[length:var(--font-meta-size)]" data-testid="task-usage">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <dt>Tokens</dt>
        <dd>已知 {number.format(usage.tokens.settled)} tokens</dd>
        <dd>未知 {number.format(usage.tokens.unknown)} tokens</dd>
        <dd>预留 {number.format(usage.tokens.reserved)} tokens</dd>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <dt>调用</dt>
        <dd>模型 {number.format(usage.calls.models.total)} 次</dd>
        <dd>工具 {number.format(usage.calls.tools.total)} 次</dd>
        <dd>子任务 {number.format(usage.calls.children.total)} 次</dd>
      </div>
    </dl>
  );
}

export function TaskSummary({ data, onOpenArtifact, surface = 'tasks' }: {
  data: ResearchTaskDiagnostics; onOpenArtifact?: OpenResearchArtifact | undefined; surface?: 'assistant' | 'tasks';
}): React.JSX.Element {
  const completed = data.executions.filter(execution => execution.status === 'completed' || execution.status === 'complete').length;
  const current = data.executions.findLast(execution => ['running', 'recovering', 'waiting_user', 'cancelling'].includes(execution.status));
  const latest = data.executions.toReversed().filter(execution => execution.endedAt !== null && ['completed', 'complete'].includes(execution.status))
    .sort((left, right) => (right.endedAt ?? '').localeCompare(left.endedAt ?? ''))[0];
  const artifacts = [...new Map(data.executions.flatMap(execution => execution.artifacts.map(artifact =>
    [artifact.id, {...artifact, label: executionLabel(execution)}] as const))).values()];
  const presentation = researchTaskPresentation(data.task);
  const cleanupReason = presentation.cleanupReason;
  const previous = useRef({id: data.task.id, status: data.task.status, cleanupReason});
  useEffect(() => {
    if (previous.current.id === data.task.id &&
      (previous.current.status !== data.task.status || previous.current.cleanupReason !== cleanupReason)) {
      recordUxEvent('task_state_changed', surface);
      const wasFailed = ['failed', 'interrupted'].includes(previous.current.status) ||
        previous.current.cleanupReason === 'research_task_cleanup_failed';
      const recovered = cleanupReason === null && (['active', 'completed'].includes(data.task.status) ||
        previous.current.cleanupReason === 'research_task_cleanup_failed' && data.task.status === 'cancelled');
      if (wasFailed && recovered) {
        recordUxEvent('error_recovered', surface);
      }
    }
    previous.current = {id: data.task.id, status: data.task.status, cleanupReason};
  }, [data.task.id, data.task.status, cleanupReason, surface]);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 break-words font-medium text-ink" style={{textWrap: 'balance'}}>{data.task.goal}</p>
        <ActionStatus key={`${data.task.id}:${data.task.status}:${cleanupReason ?? ''}`}
          state={presentation.group === 'current' ? 'pending' : presentation.group === 'completed' ? 'success' :
            presentation.group === 'failed' ? 'error' : 'idle'}
          testId="task-status" data-status={data.task.status} className="text-muted">
          {presentation.label}
        </ActionStatus>
      </div>
      {current === undefined ? null : <p className="text-muted" data-testid="task-current-stage">当前阶段：{executionLabel(current)}</p>}
      {latest === undefined ? null : <p className="text-subtle" data-testid="task-latest-progress">
        最近完成：{executionLabel(latest)}<time className="ml-2 tabular-nums" dateTime={latest.endedAt ?? undefined}>{formatBeijingDateTime(latest.endedAt ?? '')}</time>
      </p>}
      <p className="tabular-nums text-subtle text-[length:var(--font-meta-size)]" data-testid="task-progress">
        执行已完成 {number.format(completed)} / {number.format(data.executions.length)} 次
      </p>
      {artifacts.length === 0 ? null : <details open className="task-usage-disclosure" data-testid="task-outcomes">
        <summary>成果 {artifacts.length.toLocaleString()} 项</summary>
        <ul className="grid gap-1 py-1" aria-label="任务成果">{(surface === 'assistant' ? artifacts.slice(0, 3) : artifacts).map((artifact, index) => <li key={artifact.id} className="min-w-0">
          {artifact.state === 'present' && onOpenArtifact ? <button type="button" className={`${formSecondaryButtonClass} max-w-full text-left`}
            title={artifact.id} data-testid={`task-outcome-${artifact.id}`} onClick={() => {
              recordUxEvent('action_initiated', surface);
              onOpenArtifact({projectId: data.task.projectId, artifactId: artifact.id, expectedVersion: artifact.version}, () => undefined);
            }}><span className="break-all">查看{artifact.label}成果{artifacts.length > 1 ? ` ${index + 1}` : ''}</span></button>
            : <span className="break-all text-subtle">{artifact.label}成果{artifact.state === 'missing' ? '已缺失' : '仅供查看'}</span>}
        </li>)}</ul>
      </details>}
      {data.task.statusReason === null ? null : (
        <div className="break-words text-[var(--st-warn)]" data-testid="task-reason">
          <p>{researchTaskReasonLabel(data.task.statusReason) ?? '查看任务详情中的停止回执。'}</p>
          {/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(data.task.statusReason) ? <details className="mt-1 text-muted">
            <summary className="cursor-pointer rounded-control focus-visible:outline-2 focus-visible:outline-focus-ring">错误标识</summary>
            <code className="break-all" data-testid="task-reason-code">{data.task.statusReason}</code>
          </details> : null}
        </div>
      )}
    </div>
  );
}
