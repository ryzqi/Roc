import type { ResearchTaskDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import type { ResearchTask } from '../../../shared/schemas/research-tasks';
import type { RunUsageStatus } from '../../../shared/types';

export const researchTaskStatusLabels: Record<ResearchTask['status'], string> = {
  active: '进行中', paused: '已暂停', waiting_approval: '等待审批', interrupted: '运行中断',
  completed: '已完成', cancelled: '已取消', failed: '失败'
};
const number = new Intl.NumberFormat('zh-CN');

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

export function TaskSummary({ data, details = false }: {
  data: ResearchTaskDiagnostics; details?: boolean;
}): React.JSX.Element {
  const completed = data.executions.filter(execution => execution.status === 'completed' || execution.status === 'complete').length;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 truncate font-medium text-ink" title={data.task.goal}>{data.task.goal}</p>
        <span data-testid="task-status" data-status={data.task.status} className="text-muted">
          {researchTaskStatusLabels[data.task.status]}
        </span>
      </div>
      <p className="tabular-nums text-subtle text-[length:var(--font-meta-size)]" data-testid="task-progress">
        执行已完成 {number.format(completed)} / {number.format(data.executions.length)} 次
      </p>
      <TaskUsage usage={data.usage} />
      {data.task.statusReason === null ? null : (
        <p className="break-words text-[var(--st-warn)]" data-testid="task-reason">
          任务停止原因：{data.task.statusReason === 'research_provider_reply_loop'
            ? '模型服务检测到循环回复并终止生成。请在模型设置中更换模型后继续当前任务。'
            : data.task.statusReason}
        </p>
      )}
      {details ? (
        <div className="grid gap-1 text-subtle text-[length:var(--font-meta-size)]">
          <p className="break-all font-mono">{data.task.id}</p>
        </div>
      ) : null}
    </div>
  );
}
