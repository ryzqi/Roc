import { ListChecks } from 'lucide-react';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { buildTaskBoardLanes, countTaskNavMeta, taskStatusLabels, type TaskBoardLane } from './task-model';
import { TaskDetailView } from './TaskDetailView';
import { useTasksStore } from './use-tasks';

/**
 * 任务看板 (P6/T6.6).
 *
 * Data: `task.snapshot.get` (counts, recent events), `task.active.list` (the background tasks
 * that become cards) and `task.scheduler.status` (is the scheduler actually running — a board
 * that looks idle because the scheduler is down is a different situation from one that is idle
 * with nothing scheduled, so the two are shown separately).
 *
 * Refresh: `tasks.onUpdated`, owned by `useTasksStore`. That subscription is what makes the
 * board live — the P4/P5 lesson was that a snapshot read with no push leaves a panel
 * permanently empty when data arrives later, which is exactly what happens when a chat run
 * creates a task while the board is open.
 *
 * Creating a task is **P9's** (管理面板 owns `task.background.create` + preview), so this view
 * does not offer a half-wired form; it says where creation lives. Everything the plan lists for
 * the board — 暂停 / 恢复 / 取消 / 立即运行 / 更新 / 删除 — is wired.
 */

export function TasksView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const client = scope.client;
  const store = useTasksStore(client);
  const lanes = buildTaskBoardLanes(store.activeTasks);
  const meta = countTaskNavMeta(store.activeTasks);

  if (store.selectedTaskId !== null) {
    return <TaskDetailView client={client} store={store} onBack={() => store.selectTask(null)} />;
  }

  if (store.status === 'loading' && store.snapshot === null) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="tasks-board-loading">
        <EmptyState tone="loading" title="正在读取任务" />
      </div>
    );
  }
  if (store.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="tasks-board-error">
        <ErrorBar
          error={{ level: 'page', message: store.error ?? '读取任务失败', retry: store.refresh, actionLabel: 'task.snapshot.get' }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4" data-testid="tasks-board-view">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-1.5 text-ink text-[var(--font-h2-size)]">
          <ListChecks size={15} aria-hidden="true" />
          任务看板
        </h1>
        <span className="text-subtle text-[var(--font-meta-size)]" data-testid="tasks-board-counts">
          后台任务 {store.activeTasks.length} · 活动 {meta.activeCount} · 待确认 {meta.pendingApprovalCount} · 已计划{' '}
          {meta.scheduledCount}
        </span>
        <span className="text-subtle text-[var(--font-meta-size)]" data-testid="tasks-board-scheduler">
          调度器：{store.scheduler === null ? '未读取' : store.scheduler.running ? '运行中' : '已停止'}
          {store.scheduler === null || store.scheduler.nextFireAt === null
            ? ''
            : ` · 下次触发 ${formatBeijingDateTime(store.scheduler.nextFireAt)}`}
          {store.scheduler === null || store.scheduler.registeredTaskCount === 0
            ? ''
            : ` · 已注册 ${store.scheduler.registeredTaskCount}`}
        </span>
        <button
          type="button"
          data-testid="tasks-board-refresh"
          onClick={store.refresh}
          className="ml-auto h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          刷新
        </button>
      </header>

      {store.snapshot === null ? null : (
        <p className="text-subtle text-[var(--font-micro-size)]">
          线程 {store.snapshot.counts.total} · 运行中 {store.snapshot.counts.running} · 失败 {store.snapshot.counts.failed} · 待确认{' '}
          {store.snapshot.counts.pendingConfirmation}（task.snapshot.get，生成于{' '}
          {formatBeijingDateTime(store.snapshot.generatedAt)}）
        </p>
      )}

      {store.activeTasks.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="暂无后台任务"
          description="后台任务由助手提议并调度（你可以在对话里描述任务）。本页面负责查看、暂停、恢复、取消与审批；新建入口在管理面板（P9）。"
          testId="tasks-board-empty"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {lanes.map((lane) => (
            <Lane key={lane.id} lane={lane} onOpen={(taskId) => store.selectTask(taskId)} />
          ))}
        </div>
      )}

      {store.actionError === null ? null : (
        <p className="text-[var(--st-bad)] text-[var(--font-meta-size)]" role="alert" data-testid="tasks-board-action-error">
          {store.actionError}
        </p>
      )}
    </div>
  );
}

function Lane({ lane, onOpen }: { lane: TaskBoardLane; onOpen: (taskId: string) => void }): React.JSX.Element {
  return (
    <section
      className="flex min-h-[120px] flex-col gap-1.5 rounded-card border border-line bg-bg-soft p-2"
      data-testid={`tasks-lane-${lane.id}`}
      aria-label={lane.title}
    >
      <header className="flex items-center gap-1.5">
        <h2 className="text-muted text-[var(--font-micro-size)]">{lane.title}</h2>
        <span className="text-subtle text-[var(--font-micro-size)]">{lane.items.length}</span>
      </header>
      {lane.items.length === 0 ? (
        <p className="text-subtle text-[var(--font-micro-size)]">—</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lane.items.map((item) => (
            <li key={item.taskId}>
              <button
                type="button"
                data-testid={`task-board-card-${item.taskId}`}
                onClick={() => onOpen(item.taskId)}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-card border border-line bg-surface px-2 py-1.5 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                <span className="w-full truncate text-ink" title={item.title}>
                  {item.title}
                </span>
                <span className="w-full truncate text-muted text-[var(--font-micro-size)]" title={item.goal}>
                  {item.goal}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-subtle text-[var(--font-micro-size)]">
                  <span>{taskStatusLabels[item.status]}</span>
                  <span>{item.trigger === null ? '立即运行' : item.trigger.description}</span>
                  {item.nextRunAt === null ? null : <span>下次 {formatBeijingDateTime(item.nextRunAt)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
