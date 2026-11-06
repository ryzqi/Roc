import type { ResearchTaskDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import type { ResearchTask } from '../../../shared/schemas/research-tasks';
import type { RunBudgetStatus } from '../../../shared/types';
import { formatBeijingDateTime } from '../../shared/format';

export const researchTaskStatusLabels: Record<ResearchTask['status'], string> = {
  active: '进行中', paused: '已暂停', waiting_approval: '等待审批', interrupted: '运行中断',
  completed: '已完成', cancelled: '已取消', failed: '失败'
};
const number = new Intl.NumberFormat('zh-CN');
const cost = (value: number | null): string => value === null ? '未知' : `$${(value / 1_000_000).toFixed(6)}`;

export function TaskBudget({ budget }: { budget: RunBudgetStatus }): React.JSX.Element {
  return (
    <dl className="grid gap-1 text-subtle text-[var(--font-meta-size)]" data-testid="task-budget">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <dt>Tokens</dt>
        <dd>已知 {number.format(budget.tokens.settled)}</dd>
        <dd>未知 {number.format(budget.tokens.unknown)}</dd>
        <dd>预留 {number.format(budget.tokens.reserved)}</dd>
        <dd>剩余 {number.format(budget.tokens.remaining)}</dd>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <dt>调用</dt>
        <dd>模型 {budget.calls.models.total}/{budget.calls.models.limit}</dd>
        <dd>工具 {budget.calls.tools.total}/{budget.calls.tools.limit}</dd>
        <dd>子任务 {budget.calls.children.total}/{budget.calls.children.limit}</dd>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <dt>费用</dt>
        <dd>已结算 {cost(budget.cost.settledMicrousd)}</dd>
        {budget.cost.state === 'unknown' ? <dd>部分未知</dd> : null}
        <dd>预留 {cost(budget.cost.reservedMicrousd)}</dd>
        <dd>上限 {budget.cost.limitMicrousd === null ? '未设置' : cost(budget.cost.limitMicrousd)}</dd>
      </div>
      {budget.stopReason === null ? null : <div className="break-words text-[var(--st-warn)]">预算停止原因：{budget.stopReason}</div>}
    </dl>
  );
}

export function TaskSummary({ data, details = false }: {
  data: ResearchTaskDiagnostics; details?: boolean;
}): React.JSX.Element {
  const completed = data.executions.filter(execution => execution.status === 'completed' || execution.status === 'complete').length;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 truncate font-medium text-ink" title={data.task.goal}>{data.task.goal}</p>
        <span data-testid="task-status" data-status={data.task.status} className="text-muted">
          {researchTaskStatusLabels[data.task.status]}
        </span>
      </div>
      <p className="text-subtle text-[var(--font-meta-size)]" data-testid="task-progress">
        执行已完成 {completed}/{data.executions.length}
      </p>
      <TaskBudget budget={data.budget} />
      {data.task.statusReason === null ? null : (
        <p className="break-words text-[var(--st-warn)]" data-testid="task-reason">任务停止原因：{data.task.statusReason}</p>
      )}
      {details ? (
        <div className="grid gap-1 text-subtle text-[var(--font-meta-size)]">
          <p>截止时间 {formatBeijingDateTime(data.budget.deadlineAt)}（暂停期间继续计时）</p>
          <p>外部服务费用：未知，尚无费用回执。</p>
          {data.budget.cost.state === 'unknown' ? <p>部分调用缺少 usage 或可信价格回执，未知消费仍保留预算占用。</p> : null}
          <p className="break-all font-mono">{data.task.id}</p>
        </div>
      ) : null}
    </div>
  );
}
