import type { BackgroundTask, TaskSnapshot, TraySummary } from '../../../shared/types';
import { CompactStatusPill } from '../../components/CompactStatusPill';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { StatusPill } from '../../components/StatusPill';
import { buildTopMeta } from '../../app/view-routing';
import { formatBeijingDateTime } from '../../format-time';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import { TraySummaryPanel } from '../floating/TraySummaryPanel';

function describeTaskEvent(event: TaskSnapshot['recentEvents'][number]): string {
  if (event.type === 'approval_requested' && typeof event.payload === 'object' && event.payload !== null) {
    const actionRequests = Reflect.get(event.payload, 'actionRequests');
    if (Array.isArray(actionRequests) && actionRequests.length > 0) {
      const first = actionRequests[0];
      if (typeof first === 'object' && first !== null && typeof Reflect.get(first, 'name') === 'string') {
        return `等待审批 · ${Reflect.get(first, 'name') as string}`;
      }
    }
    return '等待审批';
  }
  if (event.type === 'approval_decision' && typeof event.payload === 'object' && event.payload !== null) {
    const decision = Reflect.get(event.payload, 'decision');
    if (typeof decision === 'object' && decision !== null && typeof Reflect.get(decision, 'type') === 'string') {
      return `审批决策 · ${Reflect.get(decision, 'type') as string}`;
    }
    return '审批决策';
  }
  return event.type;
}

export function TasksView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const backgroundTask = state.backgroundTask;
  const runningTasks = state.traySummary.backgroundTasks.running;
  const scheduledTasks = state.backgroundTasks.filter((task) => task.scheduled).length;
  const pendingConfirmations = state.traySummary.backgroundTasks.pendingConfirmation;
  const recentEvents = state.taskSnapshot.recentEvents.slice(0, 4);
  return (
    <>
      <PageHeading title="任务" meta={buildTopMeta('tasks', state)} />
      <section className="canvas-stage stage-grid" data-testid="tasks-view">
        <div className="stat-row" data-testid="background-task-summary">
          <Metric
            label="后台任务"
            note={`${runningTasks} 个运行中`}
            value={state.traySummary.backgroundTasks.total}
          />
          <Metric
            label="定时任务"
            note={state.traySummary.nextRunAt === null ? '暂无计划' : `下次 ${state.traySummary.nextRunAt}`}
            value={scheduledTasks}
          />
          <Metric label="待确认" note="高风险动作" tone="warn" value={pendingConfirmations} />
        </div>
        <div className="task-surface-grid">
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">任务队列</h2>
              <CompactStatusPill tone="warn" value="需处理" />
            </div>
            <div className="list-rows">
              {backgroundTask === null ? (
                <Row title="后台任务" sub="当前没有后台任务或定时执行。" tag="空" tone="warn" />
              ) : (
                <>
                  <Row title={backgroundTask.goal} sub={backgroundTask.triggerDescription} tag={backgroundTask.status} tone="info" />
                  <Row title="触发" sub={backgroundTask.triggerDescription} tag={backgroundTask.scheduled ? '定时' : '手动'} tone="ok" />
                  <Row title="下次运行" sub={backgroundTask.nextRunAt === null ? '无' : backgroundTask.nextRunAt} tag={backgroundTask.failurePolicy} tone="warn" />
                </>
              )}
            </div>
          </section>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">最近任务事件</h2>
            </div>
            <div className="list-rows">
              {recentEvents.length === 0 ? (
                <Row title="任务事件" sub="当前没有任务事件。" tag="空" tone="warn" />
              ) : (
                recentEvents.map((event) => (
                  <Row key={event.id} title={describeTaskEvent(event)} sub={formatBeijingDateTime(event.createdAt)} tag="已记录" tone="info" />
                ))
              )}
            </div>
          </section>
        </div>
        <div className="task-surface-grid">
          {backgroundTask === null ? (
            <EmptyState testId="background-task-controls" title="暂无后台任务" />
          ) : (
            <section className="section" data-testid="background-task-controls">
              <div className="section-head">
                <h2 className="section-title">后台任务</h2>
                <StatusPill label="状态" tone={backgroundTask.status === 'running' ? 'ok' : 'warn'} value={backgroundTask.status} />
              </div>
              <div className="list-rows">
                <Row title="目标" sub={backgroundTask.goal} tag={backgroundTask.riskLevel} tone={backgroundTask.riskLevel === 'low' ? 'ok' : 'warn'} />
              </div>
              <div className="action-strip">
                <button
                  data-testid="background-pause"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.pauseBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('pause background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  暂停
                </button>
                <button
                  data-testid="background-resume"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.resumeBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('resume background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  继续
                </button>
                <button
                  data-testid="background-cancel"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.cancelBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('cancel background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  取消
                </button>
              </div>
            </section>
          )}
          <TraySummaryPanel traySummary={state.traySummary} />
        </div>
      </section>
    </>
  );
}
