import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Loader2, Minimize2, Settings2 } from 'lucide-react';
import type { ChatRunMode } from '../../shared/types';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import { useAsyncResource } from '../app/use-async-resource';
import { useSettingsRevision } from '../shared/settings-events';
import type { RocClient } from '../shared/roc-client';
import { ErrorBar } from '../shell/ErrorBar';
import { EmptyState } from '../shell/EmptyState';
import { AssistantComposer, type ComposerSkill } from './composer';
import { isImageInputSupported, type ImageSupportSnapshot, type RendererImageAttachment } from './image-attachments';
import { ChatTranscriptPanel } from './transcript-panel';
import { useChatSession } from './use-chat-session';

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
 * ## The model pill
 *
 * The pill (Bot glyph in `--icon-agent`, label, trailing affordance, raised surface) is the
 * header's visual signature, but it is a read-only display rather than a model switcher: the
 * only control it opens is the settings centre. That is a contract reason, not a scope one —
 * `settings.save` is a **whole document**, not a patch (`SettingsSaveRequest`). The settings
 * centre owns a dirty draft of that document and is the only surface that knows which fields
 * the user has already changed; a switcher in the assistant would have to re-send every field
 * it did not load, making it a second writer of a whole-document resource.
 *
 * So the trailing affordance is `Settings2`, not `ChevronDown`: the control really does open
 * the settings centre, and a chevron would promise a menu that does not exist.
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
};

export function AssistantPanel({
  client,
  projectId,
  threadId,
  onThreadIdChange,
  workspacePath,
  projectName,
  stageLabel = null,
  onOpenSettings,
  composerSeed = null,
  onComposerSeedConsumed,
  onResetWidth
}: AssistantPanelProps): React.JSX.Element {
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
  const [mode, setMode] = useState<ChatRunMode>('chat');
  const [attachments, setAttachments] = useState<RendererImageAttachment[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // A thread belongs to the project it was created in (gate 6); the shell clears the
  // selection, this only drops the drafts that belonged to it.
  useEffect(() => {
    setAttachments([]);
  }, [projectId, threadId]);

  const session = useChatSession({
    client,
    threadId,
    projectId,
    workspacePath,
    onThreadId: (next) => onThreadIdChange(next)
  });

  /**
   * Restores a suspended run once per thread, not once per render.
   *
   * `session.restoreActiveRun` is a fresh closure on every render (it depends on the run
   * controller, which is itself a new object each time), so putting it in the dependency list
   * would fire `chat.getActiveRun` every frame — and, worse, re-apply a replay on top of live
   * events that were buffered while the window was hidden. The ref keys the attempt to the
   * thread it belongs to.
   */
  const restoredThreadRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (restoredThreadRef.current === threadId) {
      return;
    }
    restoredThreadRef.current = threadId;
    // A different thread means a different run: without this, a suspended run's
    // `waiting_user` status would keep the next thread's input disabled.
    session.resetRun();
    void session.restoreActiveRun();
  }, [session, threadId]);

  const snapshot = settings.data;
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
        return `${model.displayName} · ${provider.name}`;
      }
    }
    return snapshot.defaultModelId;
  }, [settings.status, snapshot]);

  const runStatus = session.runState.status;
  const activeRun = runStatus === 'running' || runStatus === 'recovering';
  const pendingQuestion = session.runState.pendingInterrupts.find((interrupt) => interrupt.kind === 'question') ?? null;
  const replyMode = pendingQuestion !== null;
  const waitingUser = session.runState.pendingInterrupts.length > 0;
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

  const onApprovalDecision = useCallback(
    (interruptId: string, decisions: Parameters<typeof session.resumeApproval>[1]) => {
      void session.resumeApproval(interruptId, decisions);
    },
    [session]
  );

  const header = (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-meta-size)]" data-testid="assistant-context">
          {projectName === null ? '未进入项目' : projectName}
          {stageLabel === null ? '' : ` · ${stageLabel}`}
        </span>
        {/* The message count is the one number that says a long run is still producing
            output. */}
        <span
          className="shrink-0 font-mono text-subtle text-[var(--font-micro-size)]"
          data-testid="assistant-message-count"
        >
          {session.messages.length} 条消息
        </span>
        {statusLabel === null ? null : (
          <span
            className={
              runStatus === 'failed' || runStatus === 'recovering'
                ? 'shrink-0 rounded-control bg-[var(--tool-st-error-bg)] px-1.5 py-0.5 text-[var(--tool-st-error-text)] text-[var(--font-micro-size)]'
                : 'shrink-0 rounded-control bg-[var(--tool-st-progress-bg)] px-1.5 py-0.5 text-[var(--tool-st-progress-text)] text-[var(--font-micro-size)]'
            }
            data-testid="assistant-run-status"
            data-status={runStatus}
          >
            {runStatus === 'running' || runStatus === 'recovering' ? (
              <Loader2 size={10} aria-hidden="true" className="mr-1 inline animate-spin" />
            ) : null}
            {statusLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          title="模型与思考开关在设置中心（唯一可写位置）"
          data-testid="assistant-model-settings"
          className="flex h-[var(--control-height-compact)] min-w-0 max-w-[55%] shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-text text-[var(--font-micro-size)] shadow-[var(--shadow-card)] transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <Bot size={13} aria-hidden="true" className="shrink-0 text-[var(--icon-agent)]" />
          <span className="min-w-0 truncate font-medium tracking-tight">{modelLabel}</span>
          <Settings2 size={11} aria-hidden="true" className="shrink-0 text-muted" />
        </button>
        {onResetWidth === undefined ? null : (
          <button
            type="button"
            onClick={onResetWidth}
            title="重置助手宽度"
            aria-label="重置助手宽度"
            data-testid="assistant-reset-width"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-[var(--duration-fast)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <Minimize2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );

  const errorMessages = [
    session.errorMessage,
    session.history.error,
    settings.status === 'error' ? (settings.error ?? '读取模型设置失败') : null
  ].filter((message): message is string => message !== null && message.length > 0);

  return (
    // `bg-bg`, not `--bg-soft`: all three columns share one colour and are separated by
    // hairlines only. Tinting the transcript wrapper the same colour keeps it deliberately
    // invisible.
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="assistant-panel">
      {header}

      {errorMessages.length === 0 ? null : (
        <div className="shrink-0 px-2 pt-2" data-testid="assistant-errors">
          <ErrorBar error={{ level: 'page', message: errorMessages[0] ?? '', retry: () => void session.restoreActiveRun() }} />
        </div>
      )}

      {/*
        `overflow-y-auto` is load-bearing, not decoration: `ChatTranscriptPanel` passes this node
        to Virtuoso as `customScrollParent`, so *this* element is the scroller. The legacy shell
        got it from the `chat-empty-plane` class; without it nothing clips the list and the
        transcript is painted over the composer (found by the P4 gate harness: clicking 停止 hit
        a tool block's status pill instead of the button).
      */}
      <div ref={scrollContainerRef} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {session.messages.length === 0 ? (
          <EmptyState
            title={session.history.loadingInitial ? '正在读取会话…' : '开始一段研究对话'}
            description={
              session.history.loadingInitial
                ? undefined
                : '提问、让助手跑工具、或在任务/计划模式下发起一次结构化的运行。'
            }
            tone={session.history.loadingInitial ? 'loading' : 'empty'}
            testId={session.history.loadingInitial ? 'assistant-history-loading' : 'assistant-empty'}
          />
        ) : (
          <ChatTranscriptPanel
            threadId={threadId}
            messages={session.messages}
            prependRevision={session.history.prependRevision}
            trimRevision={session.history.trimRevision}
            windowEpoch={session.history.windowEpoch}
            tailTrimmed={session.history.tailTrimmed}
            hasMoreBefore={session.history.hasMoreBefore}
            loadingOlder={session.history.loadingOlder}
            loadOlder={session.history.loadOlder}
            onJumpToLatest={session.history.reloadLatest}
            scrollContainerRef={scrollContainerRef}
            onApprovalDecision={onApprovalDecision}
          />
        )}
      </div>

      {waitingUser ? (
        <p className="shrink-0 border-t border-line px-3 py-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="assistant-waiting-note">
          <AlertTriangle size={10} aria-hidden="true" className="mr-1 inline" />
          运行已挂起，等待你在上面的卡片里做出决定；刷新后仍会回到这里。
        </p>
      ) : null}

      <AssistantComposer
        mode={mode}
        onModeChange={setMode}
        skills={skills}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        imageInputSupported={imageSupport === null ? false : isImageInputSupported(imageSupport)}
        sending={session.sending}
        running={activeRun}
        suspended={suspendedOnApproval}
        replyMode={replyMode}
        seed={composerSeed}
        onSeedConsumed={onComposerSeedConsumed}
        onSend={async (input) => {
          // A suspended question takes the text as its answer; everything else starts a new run.
          if (pendingQuestion !== null) {
            return await session.resumeQuestion(pendingQuestion.interruptId, input.text);
          }
          return await session.send({
            text: input.text,
            mode,
            skillIds: input.explicitSkillIds,
            attachments: input.attachments
          });
        }}
        onStop={() => void session.cancel()}
      />

      {settings.status === 'error' ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className="shrink-0 px-3 pb-2 text-left text-accent text-[var(--font-micro-size)]"
          data-testid="assistant-open-settings-hint"
        >
          <Settings2 size={10} aria-hidden="true" className="mr-1 inline" />
          打开设置检查 provider 与模型
        </button>
      ) : null}
    </div>
  );
}
