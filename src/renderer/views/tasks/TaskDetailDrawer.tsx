import { useState } from 'react';
import type { ActiveTaskItem, ScheduledTaskRun, TaskDetail, TaskRun } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { Row } from '../../components/Row';
import { TaskRunOutputPanel } from './TaskRunOutputPanel';
import { buildTaskRunOutput } from './task-run-output';

export function TaskDetailDrawer({
  detail,
  item,
  liveRun,
  scheduledRuns,
  onCancel,
  onDelete,
  onOpenInChat,
  onOpenChat,
  onPause,
  onResume,
  onRunNow
}: {
  detail: TaskDetail | null;
  item: ActiveTaskItem | null;
  liveRun: ChatRunState | null;
  scheduledRuns: ScheduledTaskRun[];
  onCancel: (item: ActiveTaskItem) => void;
  onDelete: (item: ActiveTaskItem) => void;
  onOpenInChat: (item: ActiveTaskItem) => void;
  onOpenChat: (threadId: string) => void;
  onPause: (item: ActiveTaskItem) => void;
  onResume: (item: ActiveTaskItem) => void;
  onRunNow: (item: ActiveTaskItem) => void;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'overview' | 'output' | 'runs' | 'events' | 'settings'>('overview');
  const [copied, setCopied] = useState(false);
  const runOutput = buildTaskRunOutput({
    detail,
    liveRun
  });
  const recentFailure = readRecentFailure(detail);

  if (item === null) {
    return (
      <aside className="task-detail-drawer" data-testid="task-detail-drawer">
        <div className="section-empty-state">
          <strong>选择一个任务查看详情</strong>
          <p>任务详情会显示运行、触发、工作区和调度状态。</p>
        </div>
      </aside>
    );
  }
  const detailItem = item;

  async function copyTaskId(): Promise<void> {
    const id = detailItem.taskId ?? detailItem.threadId;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <aside className="task-detail-drawer" data-testid="task-detail-drawer">
      <div className="section-head">
        <h2 className="section-title">任务详情</h2>
        <span className="status-pill info">
          <span>{detailItem.status}</span>
        </span>
      </div>
      <div className="task-detail-tabs" role="tablist" aria-label="任务详情">
        <button type="button" aria-pressed={activeTab === 'overview'} onClick={() => setActiveTab('overview')}>概览</button>
        <button type="button" aria-pressed={activeTab === 'output'} onClick={() => setActiveTab('output')}>运行输出</button>
        <button type="button" aria-pressed={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>运行历史</button>
        <button type="button" aria-pressed={activeTab === 'events'} onClick={() => setActiveTab('events')}>事件流</button>
        <button type="button" aria-pressed={activeTab === 'settings'} onClick={() => setActiveTab('settings')}>设置</button>
      </div>
      {activeTab === 'overview' ? (
        <div className="list-rows">
          <Row
            title="调度器"
            sub={detailItem.nextRunAt === null ? '未注册下一次运行' : `下次 ${detailItem.nextRunAt}`}
            tag={detail?.schedulerRegistered === false ? '未注册' : '已注册'}
            tone={detail?.schedulerRegistered === false ? 'warn' : 'info'}
          />
          <Row title="目标" sub={detailItem.goal} tag={detailItem.kind} tone="info" />
          <Row title="触发" sub={formatTrigger(detailItem)} tag={detailItem.riskLevel} tone="warn" />
          <Row title="工作区" sub={detailItem.workspacePath ?? '无'} tag={detailItem.taskId ?? detailItem.threadId} tone="info" />
          <Row
            title="最近调度"
            sub={scheduledRuns[0] === undefined ? '当前没有最近调度记录。' : formatScheduledRunSub(scheduledRuns[0])}
            tag={scheduledRuns[0]?.status ?? '空'}
            tone={scheduledRuns[0] === undefined ? 'warn' : scheduledRuns[0].status === 'failed' || scheduledRuns[0].status === 'skipped' ? 'warn' : 'ok'}
          />
          {recentFailure === null ? null : <Row title="最近失败" sub={recentFailure} tag="failed" tone="warn" />}
        </div>
      ) : null}
      {activeTab === 'overview' && runOutput !== null ? <TaskRunOutputPanel output={runOutput} compact /> : null}
      {activeTab === 'output'
        ? runOutput === null
          ? (
            <div className="list-rows">
              <Row title="运行输出" sub="当前没有最近运行输出。" tag="空" tone="warn" />
            </div>
            )
          : <TaskRunOutputPanel output={runOutput} />
        : null}
      {activeTab === 'runs' ? (
        <div className="list-rows">
          {detail === null || detail.runHistory.length === 0 ? (
            <Row title="运行历史" sub="当前没有运行历史。" tag="空" tone="warn" />
          ) : (
            detail.runHistory.slice(0, 5).map((run) => (
              <Row
                key={run.id}
                title={formatRunTitle(run)}
                sub={formatRunSub(run)}
                tag={run.modelId ?? 'pending'}
                tone={run.status === 'failed' || run.status === 'cancelled' ? 'warn' : 'info'}
              />
            ))
          )}
        </div>
      ) : null}
      {activeTab === 'events' ? (
        <div className="list-rows">
          {detail === null || detail.recentEvents.length === 0 ? (
            <Row title="事件流" sub="当前没有最近事件。" tag="空" tone="warn" />
          ) : (
            detail.recentEvents.slice(0, 5).map((event) => (
              <Row
                key={event.id}
                title={event.type}
                sub={event.createdAt}
                tag={formatEventTag(event.payload)}
                tone={event.type === 'error' ? 'warn' : 'info'}
              />
            ))
          )}
        </div>
      ) : null}
      {activeTab === 'settings' ? (
        <div className="list-rows">
          <Row title="线程 ID" sub={detail?.threadId ?? detailItem.threadId} tag={detail?.thread.kind ?? detailItem.kind} tone="info" />
          <Row
            title="允许动作"
            sub={detail?.backgroundTask?.allowedActions.join(', ') || '未设置'}
            tag={String(detail?.backgroundTask?.allowedActions.length ?? 0)}
            tone="info"
          />
          <Row
            title="禁止动作"
            sub={detail?.backgroundTask?.forbiddenActions.join(', ') || '未设置'}
            tag={String(detail?.backgroundTask?.forbiddenActions.length ?? 0)}
            tone={(detail?.backgroundTask?.forbiddenActions.length ?? 0) > 0 ? 'warn' : 'info'}
          />
          <Row
            title="通知策略"
            sub={detail?.backgroundTask?.notificationPolicy ?? '仅聊天线程'}
            tag={detail?.backgroundTask?.failurePolicy ?? 'n/a'}
            tone="info"
          />
        </div>
      ) : null}
      <div className="action-strip">
        {!canDeleteTask(detailItem) ? (
          <>
            <button type="button" onClick={() => onOpenInChat(detailItem)}>让 AI 修改</button>
            <button type="button" onClick={() => onRunNow(detailItem)}>立即运行</button>
            {detailItem.status === 'paused' ? (
              <button type="button" onClick={() => onResume(detailItem)}>继续</button>
            ) : (
              <button type="button" onClick={() => onPause(detailItem)}>暂停</button>
            )}
            <button type="button" onClick={() => onCancel(detailItem)}>取消</button>
          </>
        ) : null}
        {canDeleteTask(detailItem) ? <button type="button" onClick={() => onDelete(detailItem)}>删除任务</button> : null}
        <button type="button" onClick={() => onOpenChat(detailItem.threadId)}>打开聊天</button>
        <button type="button" onClick={() => void copyTaskId()}>{copied ? '已复制' : '复制 ID'}</button>
      </div>
    </aside>
  );
}

function canDeleteTask(item: ActiveTaskItem): boolean {
  return item.status === 'completed' || item.status === 'cancelled' || item.status === 'failed';
}

function formatTrigger(item: ActiveTaskItem): string {
  if (item.trigger === null) {
    return '长会话';
  }
  if (item.trigger.type === 'cron') {
    return `${item.trigger.description} (${item.trigger.cronExpression})`;
  }
  return item.trigger.description;
}

function formatScheduledRunSub(run: ScheduledTaskRun): string {
  return run.triggeredAt ?? run.scheduledAt;
}

function formatRunTitle(run: TaskRun): string {
  return `第 ${run.runNumber} 次运行`;
}

function formatRunSub(run: TaskRun): string {
  return `${run.status} · ${run.startedAt}`;
}

function formatEventTag(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return 'event';
  }
  const role = Reflect.get(payload, 'role');
  if (typeof role === 'string' && role.length > 0) {
    return role;
  }
  const status = Reflect.get(payload, 'status');
  if (typeof status === 'string' && status.length > 0) {
    return status;
  }
  return 'event';
}

function readRecentFailure(detail: TaskDetail | null): string | null {
  if (detail === null) {
    return null;
  }
  for (const event of detail.recentEvents) {
    if (event.type !== 'agent_update' || typeof event.payload !== 'object' || event.payload === null) {
      continue;
    }
    const status = Reflect.get(event.payload, 'status');
    const error = Reflect.get(event.payload, 'error');
    if (status === 'failed' && typeof error === 'string' && error.length > 0) {
      return error;
    }
  }
  return null;
}
