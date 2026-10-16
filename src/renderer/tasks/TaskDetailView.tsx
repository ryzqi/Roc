import { ArrowLeft, Play, RotateCw, Trash2, XCircle } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ActiveTaskItem,
  BackgroundTask,
  ChatPendingQuestion,
  ChatResumeDecision,
  PersistedTaskEvent
} from '../../shared/types';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import type { RocClient } from '../shared/roc-client';
import { projectChatTranscript, readChatTranscriptMemoKey } from '../assistant/transcript';
import { ChatTranscriptPanel } from '../assistant/transcript-panel';
import { useChatRun } from '../assistant/use-chat-run';
import { usePersistedThreadHistory } from '../assistant/use-persisted-thread-history';
import { resumeApproval, resumeQuestion } from '../assistant/session-store';
import { getTaskActionAvailability, taskStatusLabels } from './task-model';
import type { TasksStore } from './use-tasks';

/**
 * 任务详情 (P6/T6.6–T6.7).
 *
 * The detail page is where a background task's run is *read and decided*: the execution
 * stream comes from the same P4 machinery the assistant uses — `usePersistedThreadHistory`
 * for the durable events, `useChatRun` for the live stream, `projectChatTranscript` +
 * `ChatTranscriptPanel` to render, and the approval card's own `onApprovalDecision` — so
 * nothing about the run is re-implemented for tasks (D3).
 *
 * Two contract details decide the wiring:
 *
 *   - **`chat.onRunEvent` is global, not per-thread.** `useChatRun` keeps the newest run's
 *     state, so the live state is adopted only when its `threadId` is *this* task's thread.
 *     Without that guard, a chat run in the assistant panel would paint itself into the task
 *     transcript.
 *   - **`chat.resumeRun` needs the run id**, and the interrupt card only carries the
 *     `interruptId`. The run id comes from the persisted event that *requested* the interrupt
 *     (`approval_requested` / `human_question_requested` both carry `runId` on their base
 *     shape) — resumed by id, never by "the latest run", because a task with several runs
 *     would otherwise resume the wrong one.
 */

export function TaskDetailView({ client, store, onBack }: { client: RocClient; store: TasksStore; onBack: () => void }): React.JSX.Element {
  const detail = store.detail;
  const threadId = detail?.threadId ?? null;
  const [answer, setAnswer] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const latestPersistedEventId =
    detail === null
      ? null
      : (store.snapshot?.recentEvents.find((event) => event.threadId === detail.threadId)?.id ?? null);
  const history = usePersistedThreadHistory({ client, threadId, latestPersistedThreadEventId: latestPersistedEventId });
  const chatRun = useChatRun(client);
  const liveRun = chatRun.state.threadId === threadId && chatRun.state.status !== 'idle' ? chatRun.state : null;

  const transcriptInput = useMemo(
    () => ({ events: history.events, liveRun, pendingUserInput: null, threadId }),
    [history.events, liveRun, threadId]
  );
  const messages = useMemo(() => projectChatTranscript(transcriptInput), readChatTranscriptMemoKey(transcriptInput));

  /**
   * Pending questions come from the **transcript**, not only from the live run.
   *
   * `useChatRun` is a live-only listener (it has no `restoreActiveRun` equivalent here), so a task
   * opened *after* its run suspended has no `liveRun` at all — yet the persisted
   * `human_question_requested` event already projects into `message.interrupts`
   * (`readPersistedInterruptProjection`). Reading only the live state rendered the answer form
   * (because `thread.status === 'waiting_user'`) while `submitAnswer` always answered
   * 「当前没有待回答的问题」, i.e. a form that could never submit.
   */
  const pendingQuestions = useMemo(() => {
    const byId = new Map<string, ChatPendingQuestion>();
    for (const message of messages) {
      for (const interrupt of message.interrupts) {
        if (interrupt.kind === 'question') {
          byId.set(interrupt.interruptId, interrupt);
        }
      }
    }
    for (const interrupt of liveRun?.pendingInterrupts ?? []) {
      if (interrupt.kind === 'question') {
        byId.set(interrupt.interruptId, interrupt);
      }
    }
    return [...byId.values()];
  }, [liveRun, messages]);
  /** The form exists because there is a question to answer — not merely because the thread waits. */
  const waitingUser = pendingQuestions.length > 0;

  const onApprovalDecision = useCallback(
    (interruptId: string, decisions: ChatResumeDecision[]): void => {
      const runId =
        liveRun?.runId ??
        findInterruptRunId(history.events, interruptId) ??
        detail?.lastRunId ??
        null;
      if (runId === null || threadId === null) {
        setInlineError('找不到这次审批对应的运行：先在任务里重新发起一次运行。');
        return;
      }
      setPending(true);
      setInlineError(null);
      void resumeApproval(client, { runId, threadId, interruptId, decisions }).then((result) => {
        setPending(false);
        if (!result.ok) {
          setInlineError(result.error.message);
          return;
        }
        store.refresh();
      });
    },
    [client, detail?.lastRunId, history.events, liveRun?.runId, store, threadId]
  );

  const submitAnswer = useCallback((): void => {
    const text = answer.trim();
    if (text.length === 0) {
      setInlineError('请输入继续任务所需的回答。');
      return;
    }
    const interrupt = pendingQuestions[0] ?? null;
    const runId =
      liveRun?.runId ??
      (interrupt === null ? null : findInterruptRunId(history.events, interrupt.interruptId)) ??
      detail?.lastRunId ??
      null;
    if (interrupt === null || runId === null || threadId === null) {
      setInlineError('当前没有待回答的问题。');
      return;
    }
    setPending(true);
    setInlineError(null);
    void resumeQuestion(client, { runId, threadId, interruptId: interrupt.interruptId, answer: text }).then((result) => {
      setPending(false);
      if (!result.ok) {
        setInlineError(result.error.message);
        return;
      }
      setAnswer('');
      store.refresh();
    });
  }, [answer, client, detail?.lastRunId, history.events, liveRun?.runId, pendingQuestions, store, threadId]);

  if (store.detailStatus === 'loading' && detail === null) {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="task-detail-loading">
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          正在读取任务详情…
        </p>
      </div>
    );
  }
  if (store.detailStatus === 'error' || detail === null) {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="task-detail-error">
        <ErrorBar
          error={{ level: 'page', message: store.detailError ?? '读取任务详情失败', retry: store.refresh }}
        />
        <button
          type="button"
          onClick={onBack}
          className="self-start rounded-control border border-line px-2 py-1 text-muted text-[var(--font-meta-size)] hover:text-ink"
        >
          返回看板
        </button>
      </div>
    );
  }

  const task = detail.backgroundTask;
  const actionItem = task === null ? null : buildActionItem(detail.threadId, detail.thread.title, task);
  const availability = actionItem === null ? null : getTaskActionAvailability(actionItem.status);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="task-detail-view">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          data-testid="task-detail-back"
          onClick={onBack}
          className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          返回任务看板
        </button>
        <h1 className="min-w-0 flex-1 truncate text-ink" data-testid="task-detail-title">
          {detail.thread.title}
        </h1>
        <span className="text-subtle text-[var(--font-meta-size)]" data-testid="task-detail-status">
          {taskStatusLabels[detail.thread.status]}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={scrollContainerRef} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
            {messages.length === 0 ? (
              <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid="task-detail-transcript-empty">
                {history.loadingInitial ? '正在读取执行记录…' : '这个任务还没有执行记录。'}
              </p>
            ) : (
              <ChatTranscriptPanel
                threadId={threadId}
                messages={messages}
                prependRevision={history.prependRevision}
                trimRevision={history.trimRevision}
                windowEpoch={history.windowEpoch}
                tailTrimmed={history.tailTrimmed}
                hasMoreBefore={history.hasMoreBefore}
                loadingOlder={history.loadingOlder}
                loadOlder={history.loadOlder}
                onJumpToLatest={history.reloadLatest}
                scrollContainerRef={scrollContainerRef}
                onApprovalDecision={onApprovalDecision}
              />
            )}
          </div>

          {history.error === null ? null : (
            <p className="px-3 text-[var(--st-bad)] text-[var(--font-micro-size)]">{history.error}</p>
          )}
          {inlineError === null ? null : (
            <p className="px-3 text-[var(--st-bad)] text-[var(--font-micro-size)]" role="alert" data-testid="task-detail-inline-error">
              {inlineError}
            </p>
          )}

          {waitingUser ? (
            <form
              className="flex shrink-0 items-end gap-2 border-t border-line px-3 py-2"
              data-testid="task-detail-answer"
              onSubmit={(event) => {
                event.preventDefault();
                submitAnswer();
              }}
            >
              <label className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-subtle text-[var(--font-micro-size)]">补充输入（chat.resumeRun kind=question）</span>
                <textarea
                  value={answer}
                  disabled={pending}
                  rows={2}
                  data-testid="task-detail-answer-input"
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="输入这次问题需要的回答后提交，运行会继续。"
                  className="w-full resize-y rounded-control border border-line bg-bg px-2 py-1 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                />
              </label>
              <button
                type="submit"
                data-testid="task-detail-answer-submit"
                disabled={pending}
                className="h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] disabled:opacity-50"
              >
                继续任务
              </button>
            </form>
          ) : null}
        </div>

        <aside className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-3" data-testid="task-detail-meta">
          <section className="flex flex-col gap-1">
            <h2 className="text-subtle text-[var(--font-micro-size)]">任务概览</h2>
            <p className="text-muted text-[var(--font-meta-size)]">{task?.goal ?? detail.thread.goal}</p>
            <dl className="flex flex-col gap-0.5 text-[var(--font-micro-size)]">
              <MetaRow label="状态" value={taskStatusLabels[detail.thread.status]} />
              <MetaRow label="运行次数" value={String(task?.runCount ?? detail.runHistory.length)} />
              <MetaRow label="最近运行" value={formatTaskTime(task?.lastRunAt ?? detail.runHistory[0]?.startedAt ?? null)} />
              <MetaRow label="下次运行" value={formatTaskTime(task?.nextRunAt ?? null)} />
              <MetaRow label="触发器" value={task === null ? '未记录' : `${task.triggerDescription}（${task.triggerType}）`} />
              <MetaRow label="工作区" value={task?.workspacePath ?? '未记录'} />
              <MetaRow label="风险" value={task?.riskLevel ?? '未记录'} />
              <MetaRow
                label="调度注册"
                value={detail.schedulerRegistered ? '已注册' : '未注册'}
              />
            </dl>
          </section>

          {task !== null ? (
            <section className="flex flex-col gap-1 rounded-card border border-line bg-surface px-2.5 py-2" data-testid="task-detail-goal-edit">
              <h2 className="text-subtle text-[var(--font-micro-size)]">更新任务目标（task.background.update，需要原因）</h2>
              <textarea
                defaultValue={task.goal}
                key={`${task.id}:${task.updatedAt}`}
                rows={2}
                data-testid="task-detail-goal-input"
                className="w-full resize-y rounded-control border border-line bg-bg px-2 py-1 text-ink disabled:opacity-50"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next.length === 0 || next === task.goal) {
                    return;
                  }
                  void store.runUpdate({
                    taskId: task.id,
                    patch: { goal: next },
                    reason: '用户在任务详情页修改了任务目标'
                  });
                }}
              />
              <p className="text-subtle text-[var(--font-micro-size)]">失去焦点即提交，原因由界面填写并随变更记录。</p>
            </section>
          ) : null}

          {actionItem === null || availability === null ? (
            <p className="text-muted text-[var(--font-micro-size)]">
              这是对话线程，没有后台任务记录：暂停 / 取消 / 立即运行只对后台任务有效。
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5" data-testid="task-detail-actions">
              {availability.resume ? (
                <ActionButton taskId={actionItem.taskId} testId="task-detail-action-resume" label="恢复" disabled={store.busy} onRun={() => store.runListAction('resume', actionItem.taskId)} icon={<Play size={12} aria-hidden="true" />} />
              ) : null}
              {availability.pause ? (
                <ActionButton taskId={actionItem.taskId} testId="task-detail-action-pause" label="暂停" disabled={store.busy} onRun={() => store.runListAction('pause', actionItem.taskId)} icon={<XCircle size={12} aria-hidden="true" />} />
              ) : null}
              {availability.runNow ? (
                <ActionButton taskId={actionItem.taskId} testId="task-detail-action-run-now" label="立即运行" disabled={store.busy} onRun={() => store.runListAction('runNow', actionItem.taskId)} icon={<RotateCw size={12} aria-hidden="true" />} />
              ) : null}
              {availability.cancel ? (
                <ActionButton taskId={actionItem.taskId} testId="task-detail-action-cancel" label="取消任务" disabled={store.busy} onRun={() => store.runListAction('cancel', actionItem.taskId)} icon={<XCircle size={12} aria-hidden="true" />} />
              ) : null}
              {availability.delete ? (
                <ActionButton taskId={actionItem.taskId} testId="task-detail-action-delete" label="删除任务" disabled={store.busy} onRun={() => store.runListAction('delete', actionItem.taskId)} icon={<Trash2 size={12} aria-hidden="true" />} danger />
              ) : null}
            </div>
          )}

          {store.actionError === null ? null : (
            <p className="text-[var(--st-bad)] text-[var(--font-micro-size)]" role="alert" data-testid="task-detail-action-error">
              {store.actionError}
            </p>
          )}

          <section className="flex flex-col gap-1">
            <h2 className="text-subtle text-[var(--font-micro-size)]">运行历史</h2>
            {detail.runHistory.length === 0 ? (
              <p className="text-muted text-[var(--font-micro-size)]">还没有运行记录。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.runHistory.map((run) => (
                  <li key={run.id} className="text-[var(--font-micro-size)]">
                    <span className="text-ink">{taskStatusLabels[run.status]}</span>
                    <span className="ml-1.5 text-subtle">#{run.runNumber}</span>
                    <span className="ml-1.5 text-subtle">{formatTaskTime(run.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ActionButton({
  testId,
  label,
  disabled,
  onRun,
  icon,
  danger = false
}: {
  taskId: string;
  testId: string;
  label: string;
  disabled: boolean;
  onRun: () => Promise<boolean>;
  icon: React.ReactNode;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => void onRun()}
      className={[
        'flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border px-2',
        'disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        danger
          ? 'border-[var(--st-bad-line)] text-[var(--st-bad)] hover:bg-[var(--overlay-hover)]'
          : 'border-line text-muted hover:text-ink hover:bg-[var(--overlay-hover)]'
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="w-[64px] shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-muted">{value}</dd>
    </div>
  );
}

/** The run id that requested an interrupt, from the durable events (never "the latest run"). */
function findInterruptRunId(events: readonly PersistedTaskEvent[], interruptId: string): string | null {
  for (const event of [...events].reverse()) {
    if (
      (event.type === 'approval_requested' || event.type === 'human_question_requested') &&
      event.payload.interruptId === interruptId
    ) {
      return event.runId;
    }
  }
  return null;
}

function formatTaskTime(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '未记录';
  }
  return formatBeijingDateTime(value);
}

function buildActionItem(
  threadId: string,
  title: string,
  task: BackgroundTask
): ActiveTaskItem {
  return {
    kind: 'background',
    taskId: task.id,
    threadId,
    title,
    goal: task.goal,
    status: task.status,
    trigger: null,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    riskLevel: task.riskLevel,
    workspacePath: task.workspacePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}
