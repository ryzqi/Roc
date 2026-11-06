import { useEffect, useState } from 'react';
import type { ResearchTaskExecutionDiagnostics } from '../../../shared/schemas/research-task-diagnostics';
import type { ResearchTask, ResearchTaskEvent } from '../../../shared/schemas/research-tasks';
import { useAsyncResource } from '../../app/use-async-resource';
import { STAGE_LABELS } from '../../project/project-store';
import { TaskSummary, researchTaskStatusLabels } from '../../research/tasks/TaskSummary';
import { TaskControls } from '../../research/tasks/TaskControls';
import {TaskExecutionObservations} from '../../research/tasks/TaskExecutionObservations';
import {TaskDiagnosticsExportButton} from '../../research/tasks/TaskDiagnosticsExportButton';
import {TaskFactsPanel} from '../../research/tasks/TaskFactsPanel';
import { useTaskDiagnostics } from '../../research/tasks/use-task-diagnostics';
import { FormSection, formSecondaryButtonClass, formSelectClass } from '../../shared/form-ui';
import { formatBeijingDateTime } from '../../shared/format';
import type { RocClient } from '../../shared/roc-client';

const executionLabels = {
  chat: '主助手', stage: '科研阶段', experiment: '实验', figure: '图稿', export: '导出', review_search: '综述查询'
};
const executionStatusLabels: Record<ResearchTaskExecutionDiagnostics['status'], string> = {
  queued: '排队中', preparing: '准备中', ready: '就绪', running: '运行中', recovering: '恢复中',
  waiting_user: '等待用户', dispatch_pending: '等待调度', waiting_next_turn: '等待下一轮',
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '运行中断',
  pending_confirmation: '等待确认', paused: '已暂停', draft: '草稿', archived: '已归档',
  complete: '检索完成', partial: '检索覆盖不完整', cancelling: '正在取消'
};
const eventLabels: Record<ResearchTaskEvent['eventType'], string> = {
  task_created: '创建任务', task_status: '任务状态', execution_linked: '关联执行', call_linked: '关联调用',
  call_reserved: '调用预留', call_settled: '调用结算', call_unknown: '调用消费未知'
};

function ExecutionTree({ executions, client }: { executions: ResearchTaskExecutionDiagnostics[]; client: RocClient }): React.JSX.Element {
  const children = new Map<string | null, ResearchTaskExecutionDiagnostics[]>();
  for (const execution of executions) {
    const association = execution.association;
    const parent = association.parentKind === null ? null : `${association.parentKind}:${association.parentExecutionId}`;
    const siblings = children.get(parent) ?? [];
    siblings.push(execution);
    children.set(parent, siblings);
  }
  const render = (parent: string | null): React.JSX.Element => (
    <ol className={parent === null ? 'grid gap-2' : 'ml-2 grid gap-2 border-l border-line pl-3 pt-2'}>
      {(children.get(parent) ?? []).map(execution => {
        const association = execution.association;
        const key = `${association.kind}:${association.executionId}`;
        return (
          <li key={key} className="grid gap-1" data-testid="mgmt-task-execution">
            <div className="flex flex-wrap justify-between gap-2 text-ink">
              <span>{execution.stage === null ? executionLabels[association.kind] : STAGE_LABELS[execution.stage]}</span>
              <span>{executionStatusLabels[execution.status]}</span>
            </div>
            <p className="break-all font-mono text-subtle text-[var(--font-meta-size)]">{association.executionId}</p>
            {execution.modelId === null ? null : <p className="text-subtle">{execution.providerId} / {execution.modelId}</p>}
            <p className="text-subtle text-[var(--font-meta-size)]">
              开始 {execution.startedAt === null ? '未开始' : formatBeijingDateTime(execution.startedAt)}
              {' / 结束 '}{execution.endedAt === null ? '未结束' : formatBeijingDateTime(execution.endedAt)}
              {execution.startedAt === null || execution.endedAt === null ? '' :
                ` / 耗时 ${new Date(execution.endedAt).getTime() - new Date(execution.startedAt).getTime()} ms`}
            </p>
            {execution.error === null ? null : <p className="break-words text-[var(--st-bad)]">{execution.error}</p>}
            {execution.artifacts.length === 0 ? null : (
              <ul className="grid gap-1 text-subtle" aria-label="工件">
                {execution.artifacts.map(artifact => <li key={artifact.id} className="grid gap-1 break-all font-mono">
                  <span>工件 {artifact.id}</span><span className="text-subtle">{artifact.state === 'missing' ? '工件已缺失' : `当前版本 ${artifact.version}`} / 执行时版本未知</span>
                </li>)}
              </ul>
            )}
            <TaskExecutionObservations client={client} execution={execution} />
            {children.has(key) ? render(key) : null}
          </li>
        );
      })}
    </ol>
  );
  return <div data-testid="mgmt-task-tree">{render(null)}</div>;
}

function TaskDetail({ client, projectId, taskId }: {
  client: RocClient; projectId: string; taskId: string;
}): React.JSX.Element {
  const resource = useTaskDiagnostics(client, { projectId, taskId });
  const [afterSequence, setAfterSequence] = useState(0);
  const [previousEvents, setPreviousEvents] = useState<ResearchTaskEvent[]>([]);
  const events = useAsyncResource(
    JSON.stringify(['task-events', projectId, taskId, afterSequence]),
    () => client.api.research.getTaskEvents({ projectId, taskId, afterSequence, limit: 50 }),
    { label: '读取任务事件' }
  );
  const reloadEvents = events.reload;
  useEffect(() => client.api.research.onTaskUpdated(event => {
    if (event.projectId === projectId && event.taskId === taskId) reloadEvents();
  }), [client, projectId, taskId, reloadEvents]);

  const refresh = (): void => { resource.reload(); events.reload(); };
  return (
    <div className="grid gap-3" data-testid="mgmt-task-detail">
      <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
        data-testid="mgmt-task-refresh" onClick={refresh}>刷新任务详情</button>
      {resource.status === 'error' ? <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p> :
        resource.data === null ? <p role="status" className="text-subtle">读取任务详情中…</p> : (
          <>
            <TaskSummary data={resource.data} details />
            <TaskControls client={client} data={resource.data} onChanged={refresh} />
            <FormSection title="执行树与工件" testId="mgmt-task-executions">
              <ExecutionTree client={client} executions={resource.data.executions} />
            </FormSection>
          </>
        )}
      <TaskDiagnosticsExportButton client={client} projectId={projectId} taskId={taskId} />
      <TaskFactsPanel client={client} projectId={projectId} taskId={taskId} />
      <FormSection title="持久事件" testId="mgmt-task-events">
        {events.status === 'error' ? <p role="alert" className="break-words text-[var(--st-bad)]">{events.error}</p> : (
          <>
            <ol className="grid gap-2">
              {[...previousEvents, ...(events.data?.events ?? [])].map(event => (
                <li key={event.sequence} className="grid gap-1" data-testid="mgmt-task-event">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="text-ink">#{event.sequence} {eventLabels[event.eventType]}</span>
                    <span className="text-subtle">{formatBeijingDateTime(event.createdAt)}</span>
                  </div>
                  <p className="break-all font-mono text-subtle text-[var(--font-meta-size)]">
                    {event.executionId === null ? '' : `执行 ${event.executionKind} / ${event.executionId}`}
                    {event.callId === null ? '' : ` / 调用 ${event.callId}`}
                  </p>
                  {event.state === null && event.reason === null ? null :
                    <p className="break-words text-subtle">{event.state} {event.reason}</p>}
                </li>
              ))}
            </ol>
            {events.status === 'loading' ? <p role="status" className="text-subtle">读取事件中…</p> : null}
            {events.data?.hasMore ? (
              <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
                data-testid="mgmt-task-events-more" disabled={events.status === 'loading'} onClick={() => {
                  const page = events.data;
                  if (page === null) return;
                  setPreviousEvents(current => [...current, ...page.events]);
                  setAfterSequence(page.nextSequence);
                }}>加载更多事件</button>
            ) : null}
          </>
        )}
      </FormSection>
    </div>
  );
}

export function ResearchTasksSection({ client, projectId, selectedTaskId, onSelectTask }: {
  client: RocClient; projectId: string; selectedTaskId: string | null; onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [afterTaskId, setAfterTaskId] = useState<string | null>(null);
  const [previousTasks, setPreviousTasks] = useState<ResearchTask[]>([]);
  const resource = useAsyncResource(
    JSON.stringify(['task-list', projectId, afterTaskId]),
    () => client.api.research.listTasks({ projectId, afterTaskId, limit: 25 }), { label: '读取科研任务列表' }
  );
  const reload = resource.reload;
  useEffect(() => client.api.research.onTaskUpdated(event => {
    if (event.projectId === projectId) {
      setPreviousTasks([]);
      setAfterTaskId(null);
      reload();
    }
  }), [client, projectId, reload]);
  const tasks = [...previousTasks, ...(resource.data?.tasks ?? [])];
  return (
    <FormSection title="科研任务" testId="mgmt-research-tasks">
      <label className="grid gap-1">
        <span className="text-subtle">选择任务</span>
        <select className={formSelectClass} value={selectedTaskId ?? ''} data-testid="mgmt-task-select"
          onChange={event => onSelectTask(event.target.value)}>
          <option value="" disabled>选择科研任务</option>
          {selectedTaskId !== null && !tasks.some(task => task.id === selectedTaskId) ?
            <option value={selectedTaskId}>当前任务 {selectedTaskId}</option> : null}
          {tasks.map(task => <option key={task.id} value={task.id}>{task.goal} / {researchTaskStatusLabels[task.status]}</option>)}
        </select>
      </label>
      {resource.status === 'error' ? (
        <div>
          <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>
          <button type="button" className={formSecondaryButtonClass} onClick={reload}>重试任务列表</button>
        </div>
      ) : resource.status === 'loading' ? <p role="status" className="text-subtle">读取科研任务中…</p> :
        tasks.length === 0 ? <p className="text-subtle">当前项目还没有科研任务。</p> : null}
      {resource.data?.hasMore ? (
        <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
          data-testid="mgmt-task-list-more" disabled={resource.status === 'loading'} onClick={() => {
            const page = resource.data;
            if (page === null) return;
            setPreviousTasks(current => [...current, ...page.tasks]);
            setAfterTaskId(page.nextTaskId);
          }}>加载更多任务</button>
      ) : null}
      {selectedTaskId === null ? null :
        <TaskDetail key={`${projectId}:${selectedTaskId}`} client={client} projectId={projectId} taskId={selectedTaskId} />}
    </FormSection>
  );
}
