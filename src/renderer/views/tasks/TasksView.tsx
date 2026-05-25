import { useEffect, useMemo, useState } from 'react';
import type { ActiveTaskItem } from '../../../shared/types';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { buildTopMeta } from '../../app/view-routing';
import type { LoadedState } from '../../loaded-state';
import { TaskCreateDialog } from './TaskCreateDialog';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { TaskListSection } from './TaskListSection';
import { buildTaskViewModel } from './task-view-model';
import { useTaskActions } from './use-task-actions';

export function TasksView({
  state,
  updateLoadedState,
  onNavigateToThread,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  onNavigateToThread: (threadId: string) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (input: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(state.activeTasks[0]?.taskId ?? state.activeTasks[0]?.threadId ?? null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const model = useMemo(() => buildTaskViewModel(state), [state]);
  const actions = useTaskActions(updateLoadedState, {
    navigateToChat: onNavigateToThread,
    selectedTaskId: selectedTaskId === null || selectedTaskId.startsWith('thread_') ? null : selectedTaskId
  });
  const selectedItem = model.allItems.find((item) => (item.taskId ?? item.threadId) === selectedTaskId) ?? model.allItems[0] ?? null;
  const selectedBackgroundTaskId = selectedItem?.taskId ?? null;
  const selectedScheduledRuns =
    selectedBackgroundTaskId === null
      ? []
      : state.scheduledRuns.filter((run) => run.backgroundTaskId === selectedBackgroundTaskId);

  useEffect(() => {
    if (selectedItem !== null && (selectedItem.taskId ?? selectedItem.threadId) === selectedTaskId) {
      return;
    }
    const fallbackId = model.allItems[0]?.taskId ?? model.allItems[0]?.threadId ?? null;
    setSelectedTaskId(fallbackId);
  }, [model.allItems, selectedItem, selectedTaskId]);

  useEffect(() => {
    onSelectedTaskIdChange(selectedBackgroundTaskId);
  }, [onSelectedTaskIdChange, selectedBackgroundTaskId]);

  function selectTask(item: ActiveTaskItem): void {
    setSelectedTaskId(item.taskId ?? item.threadId);
  }

  async function submitTaskDescription(description: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const workspacePath = getCurrentWorkspacePath(state);
    if (workspacePath === null || workspacePath.trim().length === 0) {
      return { ok: false, error: '当前没有可用于任务的工作区路径。' };
    }

    return await onSubmitTaskPrompt(
      buildTaskProposalPrompt({
        description,
        workspacePath
      })
    );
  }

  return (
    <>
      <PageHeading
        title="任务"
        meta={buildTopMeta('tasks', state)}
        flags={
          <button className="action-button" type="button" onClick={() => setCreateDialogOpen(true)}>
            新建任务
          </button>
        }
      />
      <section className="canvas-stage stage-grid task-command-center" data-testid="tasks-view">
        <div className="task-summary-band" data-testid="background-task-summary">
          <Metric label="活跃任务" note={`${model.counts.pendingApprovalCount} 个待确认`} value={model.counts.activeCount} />
          <Metric label="定时任务" note={state.traySummary.nextRunAt === null ? '暂无计划' : `下次 ${state.traySummary.nextRunAt}`} value={model.counts.scheduledCount} />
          <Metric label="失败任务" note="最近失败" tone="warn" value={state.taskSnapshot.counts.failed} />
        </div>
        {model.allItems.length === 0 ? (
          <div className="task-empty-shell">
            <EmptyState
              testId="tasks-empty-state"
              title="暂无任务"
              action={
                <button className="action-button" type="button" onClick={() => setCreateDialogOpen(true)}>
                  新建任务
                </button>
              }
            />
            <p className="muted">在聊天里告诉我“帮我创建一个定时任务”，或点击右上角“新建任务”。</p>
          </div>
        ) : (
          <div className="task-surface-grid">
            <div className="task-workbench-layout">
              <div className="task-list-stack">
                {model.groups.map((group) => (
                  <TaskListSection
                    key={group.id}
                    group={group}
                    selectedId={selectedItem?.taskId ?? selectedItem?.threadId ?? null}
                    onSelect={selectTask}
                  />
                ))}
              </div>
              <TaskDetailDrawer
                item={selectedItem}
                detail={selectedBackgroundTaskId === state.taskDetail?.taskId ? state.taskDetail : null}
                scheduledRuns={selectedScheduledRuns}
                onCancel={actions.cancelTask}
                onOpenInChat={actions.openInChat}
                onPause={actions.pauseTask}
                onResume={actions.resumeTask}
                onRunNow={actions.runNow}
                onOpenChat={onNavigateToThread}
              />
            </div>
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">最近调度</h2>
              </div>
              <div className="list-rows">
                {selectedScheduledRuns.length === 0 ? (
                  <Row title="调度记录" sub="当前没有最近调度记录。" tag="空" tone="warn" />
                ) : (
                  selectedScheduledRuns.slice(0, 3).map((run) => (
                    <Row
                      key={run.id}
                      title={run.status}
                      sub={run.triggeredAt ?? run.scheduledAt}
                      tag={run.skipReason ?? 'ok'}
                      tone={run.status === 'failed' || run.status === 'skipped' ? 'warn' : 'info'}
                    />
                    ))
                )}
              </div>
            </section>
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">调度器</h2>
              </div>
              <div className="list-rows">
                <Row
                  title="状态"
                  sub={state.schedulerStatus.running ? '运行中' : '未运行'}
                  tag={state.schedulerStatus.running ? 'running' : 'stopped'}
                  tone={state.schedulerStatus.running ? 'ok' : 'warn'}
                />
                <Row
                  title="注册任务"
                  sub={state.schedulerStatus.nextFireAt ?? '无下次触发'}
                  tag={String(state.schedulerStatus.registeredTaskCount)}
                  tone="info"
                />
              </div>
            </section>
          </div>
        )}
      </section>
      <TaskCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmitDescription={submitTaskDescription}
      />
    </>
  );
}

function buildTaskProposalPrompt(input: { description: string; workspacePath: string }): string {
  return [
    '请根据下面的自然语言描述直接创建任务。',
    '',
    '你必须调用 propose_background_task 直接创建后台或定时任务。',
    '从描述中提取 goal、trigger、workspacePath、allowedActions、forbiddenActions。',
    'trigger.type 只能是 "manual"、"once" 或 "cron"。',
    '不要使用 trigger.schedule、trigger.cron、trigger.expr、trigger.expression 或 notificationPolicy: on_error。',
    '重复定时任务必须使用 trigger.type = "cron"，cronExpression = "50 21 * * *" 表示每天 21:50。',
    '一次性未来任务使用 trigger.type = "once"，并填写 ISO nextRunAt。',
    'canonical JSON shape 示例：',
    '{',
    '  "goal": "每天 21:50 抓取 AI 最新新闻并写入当前工作区的 docx 文件",',
    '  "trigger": {',
    '    "type": "cron",',
    '    "description": "每天 21:50 触发",',
    '    "cronExpression": "50 21 * * *",',
    '    "nextRunAt": "2026-05-25T13:50:00.000Z"',
    '  },',
    `  "workspacePath": "${input.workspacePath}",`,
    '  "allowedActions": [],',
    '  "forbiddenActions": [],',
    '  "notificationPolicy": "failures_and_confirmations"',
    '}',
    `默认 workspacePath 使用当前工作区：${input.workspacePath}`,
    '缺失低风险字段时使用当前工作区和保守的空动作边界。',
    '如果无法确定触发方式，使用 trigger.type = "manual"，description = "手动触发"。',
    '',
    '用户描述：',
    input.description
  ].join('\n');
}

function getCurrentWorkspacePath(state: LoadedState): string | null {
  if (state.workspace !== null) {
    return state.workspace.path;
  }
  if (state.appStatus.workspace.selectedPath !== null) {
    return state.appStatus.workspace.selectedPath;
  }
  return null;
}
