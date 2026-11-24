import './assistant-workspace.css';
import type {OpenResearchArtifact, OpenReviewInspector, ReadResearchGateContext} from '../artifacts/artifact-interactions';
import {ReviewLinkActionsProvider} from './blocks/review-link-actions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Settings2 } from 'lucide-react';
import type { ChatPendingApproval, ChatRunMode, SettingsSnapshot, TaskAcceptance } from '../../shared/types';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useSettingsRevision, notifySettingsChanged } from '../shared/settings-events';
import { formSecondaryButtonClass } from '../shared/form-ui';
import type { RocClient } from '../shared/roc-client';
import { setDefaultModel } from '../settings/settings-store';
import { ErrorBar } from '../shell/ErrorBar';
import { EmptyState } from '../shell/EmptyState';
import { AssistantComposer, type ComposerModel, type ComposerSkill } from './composer';
import { ResearchTaskProgress } from './ResearchTaskProgress';
import { StatusPillHeader } from './StatusPillHeader';
import { ExecutionTimelineDrawer } from './ExecutionTimelineDrawer';
import { HitlApprovalDock } from './HitlApprovalDock';
import {
  clearAssistantComposerDraft,
  migrateAssistantComposerDraft,
  useAssistantComposerDraft
} from './composer-draft';
import { isImageInputSupported, type ImageSupportSnapshot } from './image-attachments';
import { ChatTranscriptPanel } from './transcript-panel';
import { useChatSession } from './use-chat-session';
import { RunDiagnostics } from './RunDiagnostics';
import {recordUxEvent} from '../app/ux-metrics';
import { hasOpenDialog } from '../shell/overlay-stack';

/**
 * The assistant panel (T4.2–T4.6).
 *
 * Structure is the final shape P1 reserved: `header / transcript (flex) / composer`.
 *
 * What is real here versus what is deliberately deferred:
 *
 *   - **Real**: one `settings.get` call supplies the model label, whether the current model
 *     takes images, and the enabled skills — so the composer's `/` completion and the image
 *     affordance are driven by configuration rather than hard-coded (T4.6: the legacy shell's
 *     four invented models are gone).
 *   - **Real**: the run wiring, transcript, HITL cards, history paging and reconnection all
 *     come from `useChatSession` + the ported layers.
 *   - **Deferred**: switching the model writes through the settings centre (P8 owns the
 *     canonical settings surface and its write path), so the header links there instead of
 *     duplicating a half-write. Stage label arrives with P6; until then only the project name
 *     is shown rather than a guessed stage.
 *
 * ## The model control moved into the composer
 *
 * The header used to carry a read-only model pill that only opened the settings centre.
 * P10 moved model switching into the composer's bottom row (next to the run-shape choice),
 * where 发送 and 模型 sit in the same visual block, and where a user actually chooses them.
 *
 * The reason the old pill was read-only was real: `settings.save` is a **whole document**
 * (`SettingsSaveRequest`), so a switcher built on it would have been a second writer of a
 * whole-document resource. The fix is not to relax that rule but to stop reusing that
 * channel: `settings.setDefaultModel({ defaultModelId })` writes that one field and returns
 * the fresh snapshot, so the assistant never has to replay settings it did not load, and an
 * unsaved draft in the settings centre is not clobbered.
 *
 * The header keeps the model *name* read-only in the composer picker's trigger instead — one
 * control, not two, so the two surfaces cannot disagree about what the default model is.
 *
 * `threadId` is component state and is cleared when the project changes: a thread belongs to
 * one project's conversation, and carrying it across projects would be exactly the leak gate 6
 * is about.
 */
export type AssistantPanelProps = {
  client: RocClient;
  projectId: string | null;
  /**
   * Selected conversation, owned by the shell: the sidebar lists threads and chooses one, and
   * a single owner is what keeps the two panels from disagreeing about "the current thread".
   */
  threadId: string | null;
  onThreadIdChange: (threadId: string | null) => void;
  /** The visible session list owns the new-thread action when both panels share the window. */
  showNewThread?: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenArtifact: OpenResearchArtifact;
  onOpenReviewInspector: OpenReviewInspector;
  /** Bound workspace path, so a run is scoped to the directory the user is looking at. */
  workspacePath: string | null;
  projectName: string | null;
  /** Current workflow stage label, when a project is open (P6 supplies it). */
  stageLabel?: string | null;
  onOpenSettings: () => void;
  /** Prefilled composer text handed in by another surface (P9's memory tab). */
  composerSeed?: { text: string; nonce: number } | null;
  /** Tells the owner the seed has been applied, so it can be dropped (a remount must not replay it). */
  onComposerSeedConsumed?: () => void;
  /**
   * Puts the assistant column back to its default width.
   *
   * The shell already offers the
   * same operation on the divider (double-click, and `Home` while it is focused), and
   * this calls the same `resetAssistant` — it is duplicated here because a double-click
   * on a 1px hairline is not discoverable while the header button is.
   */
  onResetWidth?: () => void;
  onRunActivity?: (running: boolean) => void;
};

export function AssistantPanel({
  client,
  projectId,
  threadId,
  onThreadIdChange,
  showNewThread = true,
  onOpenTask,
  onOpenArtifact,
  onOpenReviewInspector,
  workspacePath,
  projectName,
  stageLabel = null,
  onOpenSettings,
  composerSeed = null,
  onComposerSeedConsumed,
  onResetWidth,
  onRunActivity
}: AssistantPanelProps): React.JSX.Element {
  const reviewLinkScope = useMemo(() => ({projectId, open: onOpenReviewInspector}), [projectId, onOpenReviewInspector]);
  /**
   * The settings revision is part of the key, not just a reload trigger: a save in the
   * settings centre changes the model label, the image support and the skill list, and the
   * contract has no push channel for `settings.*` (P8/T8.4). Keying on the revision makes
   * the resource drop the old snapshot and re-read, which is the same path a project switch
   * takes.
   */
  const settingsRevision = useSettingsRevision();
  const settings = useAsyncResource(`assistant:settings:${settingsRevision}`, () => client.api.settings.get(), {
    label: '读取模型设置'
  });
  /**
   * 刚刚写成功的快照，用来跨过「写入 → 广播修订号 → 重读」之间的那几帧。
   *
   * 资源以修订号为 key（见上），广播一次修订号就等于丢掉当前快照、重新进入 loading；
   * 不补这一层的话，每次切换默认模型，输入区都会闪一下「模型设置读取中…」。
   * 写入接口本来就返回整份新快照，用它顶上，等重读回来再交回给资源。
   */
  const [writtenSnapshot, setWrittenSnapshot] = useState<SettingsSnapshot | null>(null);
  useEffect(() => {
    if (settings.data !== null) {
      setWrittenSnapshot(null);
    }
  }, [settings.data]);
  const [mode, setMode] = useState<ChatRunMode>('chat');
  const [jumpToLatestRequest, setJumpToLatestRequest] = useState(0);
  const currentThreadIdRef = useRef(threadId);
  currentThreadIdRef.current = threadId;
  const { draft: composerDraft, updateDraft: updateComposerDraft } = useAssistantComposerDraft(projectId, threadId);

  const handleSessionThreadId = useCallback(
    (nextThreadId: string): void => {
      if (currentThreadIdRef.current === null) {
        migrateAssistantComposerDraft(projectId, null, nextThreadId);
      }
      currentThreadIdRef.current = nextThreadId;
      onThreadIdChange(nextThreadId);
    },
    [onThreadIdChange, projectId]
  );

  const session = useChatSession({
    client,
    threadId,
    projectId,
    workspacePath,
    onThreadId: handleSessionThreadId
  });

  const snapshot = settings.data ?? writtenSnapshot;
  // `useAsyncAction` 的 action 是 `(...args) => client...`：第一个参数才是 client，
  // hook 会把 `run(...args)` 原样传下去，所以这里先锁住 client。
  const switchingModel = useAsyncAction(
    (key: string) => setDefaultModel(client, key),
    { label: '切换默认模型' }
  );

  /**
   * 切换默认模型。
   *
   * 不重发整份设置文档（见组件顶部注释）；写成功后广播一次设置修订号，
   * 让助手的快照、设置中心里那些只读展示以及画布上的其他读方都回到同一份配置。
   * 失败原因留在选择器里（那里是发起写入的地方）。
   */
  const selectDefaultModel = useCallback(
    (key: string): void => {
      void (async () => {
        const next = await switchingModel.run(key);
        if (next.ok) {
          setWrittenSnapshot(next.data);
          notifySettingsChanged();
        }
      })();
    },
    [switchingModel]
  );
  const imageSupport: ImageSupportSnapshot | null = useMemo(
    () =>
      snapshot === null
        ? null
        : {
            defaultModelId: snapshot.defaultModelId,
            providers: snapshot.providers.map((provider) => ({
              id: provider.id,
              models: provider.models.map((model) => ({ id: model.id, supportsImages: model.supportsImages }))
            }))
          },
    [snapshot]
  );
  const skills: ComposerSkill[] = useMemo(
    () =>
      (snapshot?.skills ?? [])
        .filter((skill) => skill.enabled && skill.status === 'ready')
        .map((skill) => ({ id: skill.id, name: skill.name })),
    [snapshot]
  );
  const modelLabel = useMemo(() => {
    if (snapshot === null) {
      return settings.status === 'loading' ? '读取模型…' : '模型未配置';
    }
    if (snapshot.defaultModelId === null) {
      return '模型未配置';
    }
    for (const provider of snapshot.providers) {
      // The settings key format is `provider:model` (`buildProviderModelKey`), not `provider/model`.
      const model = provider.models.find(
        (item) => buildProviderModelKey(provider.id, item.id) === snapshot.defaultModelId
      );
      if (model !== undefined) {
        return `${model.displayName}（${provider.name}）`;
      }
    }
    return snapshot.defaultModelId;
  }, [settings.status, snapshot]);

  /**
   * 选择器的选项：所有 provider 下的所有模型，包括停用的（显示为「已停用」而不是隐藏）。
   *
   * 停用的模型必须可见：一个模型刚刚被关掉时，隐藏它会让用户以为它被删了；
   * 后端 `setDefaultModel` 会拒绝停用的模型，而把拒绝原因就近显示在选择器里比藏在设置页好找。
   */
  const modelChoices: ComposerModel[] = useMemo(
    () =>
      (snapshot?.providers ?? []).flatMap((provider) =>
        provider.models.map((model) => ({
          key: buildProviderModelKey(provider.id, model.id),
          label: model.displayName,
          providerId: provider.id,
          providerLabel: provider.name,
          enabled: provider.enabled && model.enabled
        }))
      ),
    [snapshot]
  );

  const runStatus = session.runState.status;
  const previousRun = useRef({threadId, status: runStatus});
  useEffect(() => {
    if (previousRun.current.threadId === threadId && previousRun.current.status !== runStatus) {
      recordUxEvent('task_state_changed', 'assistant');
      if (['failed', 'recovering'].includes(previousRun.current.status) && ['running', 'completed'].includes(runStatus)) {
        recordUxEvent('error_recovered', 'assistant');
      }
    }
    previousRun.current = {threadId, status: runStatus};
  }, [runStatus, threadId]);
  const latestHistoryEvent = session.history.events.at(-1);
  const diagnosticsRunId = threadId === null ? null :
    session.runState.threadId === threadId && session.runState.runId !== null
      ? session.runState.runId
      : latestHistoryEvent?.threadId === threadId ? latestHistoryEvent.runId : null;
  const activeRun = runStatus === 'running' || runStatus === 'recovering';
  useEffect(() => { onRunActivity?.(activeRun); }, [activeRun, onRunActivity]);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (runStatus === 'failed' || session.errorMessage !== null) setTimelineOpen(true);
  }, [runStatus, session.errorMessage]);
  const checkpointReport = useMemo(() => {
    if (diagnosticsRunId === null || threadId === null) return null;
    let report: TaskAcceptance | null = session.runState.activityBlocks
      .filter(block => block.kind === 'task_acceptance').at(-1)?.report ?? null;
    if (report === null) {
      for (let index = session.history.events.length - 1; index >= 0; index--) {
        const event = session.history.events[index];
        if (event?.runId === diagnosticsRunId && event.threadId === threadId && event.type === 'task_acceptance') {
          report = event.payload;
          break;
        }
      }
    }
    return report?.runId === diagnosticsRunId && report.checkpointResumeAvailable ? report : null;
  }, [diagnosticsRunId, session.history.events, session.runState.activityBlocks, threadId]);
  const pendingQuestion = session.runState.pendingInterrupts.find((interrupt) => interrupt.kind === 'question') ?? null;
  const replyMode = pendingQuestion !== null;
  const waitingUser = session.runState.pendingInterrupts.length > 0;
  const pendingApprovals = useMemo(() => session.runState.pendingInterrupts.filter((interrupt): interrupt is ChatPendingApproval => interrupt.kind === 'approval'), [session.runState.pendingInterrupts]);
  const activeApprovalIds = useMemo(() => new Set(pendingApprovals.map(approval => approval.interruptId)), [pendingApprovals]);
  /**
   * Suspended on an approval: the run exists but is waiting, so the input must stay locked and
   * the card is the only way forward. Without this the composer looked idle and a second
   * `chat.startRun` could be fired on top of the suspended run.
   */
  const suspendedOnApproval = waitingUser && !replyMode;
  const statusLabel =
    runStatus === 'idle'
      ? null
      : runStatus === 'recovering'
        ? `运行恢复中${session.runState.recoveryAttempt === null ? '' : `（第 ${session.runState.recoveryAttempt} 次）`}`
        : runStatus === 'waiting_user'
          ? '等待你的决定'
          : runStatus === 'running'
            ? '运行中'
            : runStatus === 'completed'
              ? '已完成'
              : runStatus === 'cancelled'
                ? '已取消'
                : '运行失败';
  const conversationTitle = session.messages.find(message => message.role === 'user')?.content.trim().replace(/\s+/gu, ' ').slice(0, 72) || null;

  const onReadGateContext = useCallback<ReadResearchGateContext>(request => client.api.research.getGateReviewContext(request), [client]);

  const onApprovalDecision = useCallback(
    (interruptId: string, decisions: Parameters<typeof session.resumeApproval>[1]) => {
      if (hasOpenDialog()) return;
      recordUxEvent('action_initiated', 'assistant');
      void session.resumeApproval(interruptId, decisions);
    },
    [session]
  );

  const header = (
    <div ref={headerRef} className="relative shrink-0">
      <StatusPillHeader projectName={projectName} conversationTitle={conversationTitle} stageLabel={stageLabel} runStatus={runStatus} statusLabel={statusLabel}
        messageCount={session.messages.length} timelineOpen={timelineOpen} onToggleTimeline={() => setTimelineOpen(open => !open)}
        onNewThread={showNewThread ? () => onThreadIdChange(null) : undefined} onResetWidth={onResetWidth} />
      <ExecutionTimelineDrawer open={timelineOpen} onClose={() => setTimelineOpen(false)}>
        {projectId === null || diagnosticsRunId === null || threadId === null ? null : (
          <ResearchTaskProgress key={`${projectId}:${threadId}:${diagnosticsRunId}`} client={client} projectId={projectId} threadId={threadId} runId={diagnosticsRunId}
            runStatus={session.runState.runId === diagnosticsRunId ? runStatus : 'history'} onOpenTask={onOpenTask} onOpenArtifact={onOpenArtifact} />
        )}
        {diagnosticsRunId === null || threadId === null ? null : <RunDiagnostics key={`${threadId}:${diagnosticsRunId}`} client={client} runId={diagnosticsRunId} threadId={threadId}
          runStatus={session.runState.runId === diagnosticsRunId ? runStatus : 'history'} />}
      </ExecutionTimelineDrawer>
    </div>
  );

  const pageError = session.errorMessage
    ? {message: session.errorMessage, retry: session.retryRecovery}
    : session.history.error
      ? {message: session.history.error, retry: () => void session.history.reloadLatest()}
      : settings.status === 'error'
        ? {message: settings.error ?? '读取模型设置失败', retry: settings.reload}
        : null;

  return (
    // `bg-bg`, not `--bg-soft`: all three columns share one colour and are separated by
    // hairlines only. Tinting the transcript wrapper the same colour keeps it deliberately
    // invisible.
    <div className="flex h-full min-h-0 flex-col bg-surface-rail text-ink-primary" data-testid="assistant-panel"
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape' || !timelineOpen || hasOpenDialog()) return;
        event.preventDefault();
        event.stopPropagation();
        setTimelineOpen(false);
        headerRef.current?.querySelector<HTMLButtonElement>('[data-testid="assistant-status-pill"]')?.focus({preventScroll: true});
      }}>
      {header}

      {!session.runState.historyComplete ? (
        <div
          className="shrink-0 border-b-[0.5px] border-line bg-[var(--tool-st-progress-bg)] px-3 py-2 text-[var(--tool-st-progress-text)] text-[length:var(--font-micro-size)]"
          data-testid="assistant-history-gap"
          role="status"
        >
          部分较早的运行记录不可用。当前状态已从保存的快照恢复。
        </div>
      ) : null}

      {pageError === null ? null : (
        <div className="shrink-0 px-2 pt-2" data-testid="assistant-errors">
          <ErrorBar error={{level: 'page', ...pageError}} />
        </div>
      )}

      {checkpointReport === null || activeRun || waitingUser ? null : (
        <div className="shrink-0 px-3 py-2">
          <button type="button" className={formSecondaryButtonClass}
            data-testid="assistant-task-resume-checkpoint"
            disabled={session.sending || session.cancelling || session.runState.resumeBusy}
            aria-busy={session.sending}
            onClick={() => {recordUxEvent('action_initiated', 'assistant'); void session.resumeCheckpoint(checkpointReport.runId);}}>
            从检查点继续
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {session.messages.length === 0 ? (
          <EmptyState
            title={session.history.loadingInitial ? '正在读取会话…' : '开始一段研究对话'}
            tone={session.history.loadingInitial ? 'loading' : 'empty'}
            testId={session.history.loadingInitial ? 'assistant-history-loading' : 'assistant-empty'}
          />
        ) : (
          <ReviewLinkActionsProvider value={reviewLinkScope}>
          <ChatTranscriptPanel
            threadId={threadId}
            messages={session.messages}
            prependRevision={session.history.prependRevision}
            trimRevision={session.history.trimRevision}
            windowEpoch={session.history.windowEpoch}
            tailTrimmed={session.history.tailTrimmed}
            hasMoreBefore={session.history.hasMoreBefore}
            loadingOlder={session.history.loadingOlder}
            loadingLatest={session.history.loadingLatest}
            jumpToLatestRequest={jumpToLatestRequest}
            loadOlder={session.history.loadOlder}
            onJumpToLatest={session.history.reloadLatest}
            onApprovalDecision={session.runState.runId !== null && waitingUser ? onApprovalDecision : undefined}
            approvalPending={session.sending || session.cancelling}
            activeApprovalIds={activeApprovalIds}
            onOpenArtifact={onOpenArtifact}
            onReadGateContext={onReadGateContext}
          />
          </ReviewLinkActionsProvider>
        )}
      </div>

      {pendingApprovals.length > 0 ? <HitlApprovalDock pendingItems={pendingApprovals} pending={session.sending || session.cancelling} onDecide={onApprovalDecision}
        onOpenArtifact={onOpenArtifact} onReadGateContext={onReadGateContext} /> : waitingUser ? (
        <p className="shrink-0 border-t-[0.5px] border-line px-3 py-1 text-[var(--st-warn)] text-[length:var(--font-micro-size)]" data-testid="assistant-waiting-note">
          <AlertTriangle size={10} aria-hidden="true" className="mr-1 inline" />
          等待你的回答。
        </p>
      ) : null}

      {session.runInputs.length === 0 && session.runInputsError === null ? null : (
        <div className="shrink-0 border-t-[0.5px] border-line px-3 py-2 text-[length:var(--font-micro-size)]" data-testid="assistant-run-inputs">
          {session.runInputs.length === 0 ? null : (
            <details>
              <summary className="cursor-pointer text-muted focus-visible:outline-2 focus-visible:outline-focus-ring">
                补充指令 {session.runInputs.length} 条
                {session.runInputs.some(item => item.status === 'queued') ? '，有指令尚未送入上下文' : '，已送入上下文'}
              </summary>
              <ol className="mt-2 max-h-32 space-y-2 overflow-y-auto overscroll-contain">
                {session.runInputs.map(item => (
                  <li key={item.submissionId} data-testid="assistant-run-input" data-status={item.status}>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-subtle">
                      <span>{item.kind === 'steer' ? '纠正当前任务' : '完成后追加'}</span>
                      <span>{item.status === 'consumed' ? '已送入上下文' : activeRun || waitingUser ? '已排队' : '未送入上下文，运行已结束'}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-ink">{item.content}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {session.runInputsError === null ? null : (
            <div role="alert" className="flex items-center gap-2 text-muted">
              <span className="min-w-0 flex-1 wrap-anywhere">补充指令状态读取失败：{session.runInputsError}</span>
              <button type="button" onClick={session.refreshRunInputs} className={formSecondaryButtonClass}>重试</button>
            </div>
          )}
        </div>
      )}

      <AssistantComposer
        mode={mode}
        onModeChange={setMode}
        model={{
          label: modelLabel,
          currentKey: snapshot?.defaultModelId ?? null,
          choices: modelChoices,
          pending: switchingModel.pending,
          error: switchingModel.error,
          onSelect: selectDefaultModel,
          onOpenSettings
        }}
        skills={skills}
        draft={composerDraft}
        onDraftChange={updateComposerDraft}
        imageInputSupported={imageSupport === null ? false : isImageInputSupported(imageSupport)}
        sending={session.sending}
        stopping={session.cancelling}
        running={activeRun}
        suspended={suspendedOnApproval}
        replyMode={replyMode}
        seed={composerSeed}
        onSeedConsumed={onComposerSeedConsumed}
        onSend={async (input) => {
          recordUxEvent('action_initiated', 'assistant');
          const submittedDraft = composerDraft;
          // Preserve the submit intent even if the current run finishes before this request arrives.
          const sent =
            pendingQuestion !== null
              ? await session.resumeQuestion(pendingQuestion.interruptId, input.text)
              : input.runInputKind !== undefined
                ? await session.sendRunInput({text: input.text, mode, skillIds: input.explicitSkillIds,
                    attachments: input.attachments, kind: input.runInputKind})
                : await session.send({
                  text: input.text,
                  mode,
                  skillIds: input.explicitSkillIds,
                  attachments: input.attachments
                });
          if (sent) {
            clearAssistantComposerDraft(projectId, threadId, submittedDraft);
            clearAssistantComposerDraft(projectId, currentThreadIdRef.current, submittedDraft);
            // The session accepts only current-scope responses. Later streaming
            // still lets Virtuoso respect a user's scroll back into history.
            setJumpToLatestRequest(request => request + 1);
          }
          return sent;
        }}
        onStop={() => {recordUxEvent('action_initiated', 'assistant'); void session.cancel();}}
      />

      {settings.status === 'error' ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className="shrink-0 px-3 pb-2 text-left text-accent-ink text-[length:var(--font-micro-size)]"
          data-testid="assistant-open-settings-hint"
        >
          <Settings2 size={10} aria-hidden="true" className="mr-1 inline" />
          打开设置检查 provider 与模型
        </button>
      ) : null}
    </div>
  );
}
