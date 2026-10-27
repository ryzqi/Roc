import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Loader2, Minimize2, Settings2 } from 'lucide-react';
import type { ChatRunMode, SettingsSnapshot } from '../../shared/types';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useSettingsRevision, notifySettingsChanged } from '../shared/settings-events';
import type { RocClient } from '../shared/roc-client';
import { setDefaultModel } from '../settings/settings-store';
import { ErrorBar } from '../shell/ErrorBar';
import { EmptyState } from '../shell/EmptyState';
import { AssistantComposer, type ComposerModel, type ComposerSkill } from './composer';
import {
  clearAssistantComposerDraft,
  migrateAssistantComposerDraft,
  useAssistantComposerDraft
} from './composer-draft';
import { isImageInputSupported, type ImageSupportSnapshot } from './image-attachments';
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
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
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
        return `${model.displayName} · ${provider.name}`;
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

  const onResumeCheckpoint = useCallback(
    (runId: string) => session.resumeCheckpoint(runId),
    [session.resumeCheckpoint]
  );

  const header = (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Bot size={14} aria-hidden="true" className="shrink-0 text-[var(--icon-agent)]" />
        <span className="min-w-0 truncate font-medium text-ink text-[var(--font-meta-size)]">研究助手</span>
        {statusLabel === null ? null : (
          <span
            className={
              runStatus === 'failed'
                ? 'shrink-0 rounded-control bg-[var(--tool-st-error-bg)] px-1.5 py-0.5 text-[var(--tool-st-error-text)] text-[var(--font-micro-size)]'
                : runStatus === 'completed'
                  ? 'shrink-0 rounded-control bg-[var(--tool-st-end-bg)] px-1.5 py-0.5 text-[var(--tool-st-end-text)] text-[var(--font-micro-size)]'
                  : runStatus === 'cancelled'
                    ? 'shrink-0 rounded-control bg-[var(--overlay-hover)] px-1.5 py-0.5 text-muted text-[var(--font-micro-size)]'
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
        {onResetWidth === undefined ? null : (
          <button
            type="button"
            onClick={onResetWidth}
            title="重置助手宽度"
            aria-label="重置助手宽度"
            data-testid="assistant-reset-width"
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-[var(--duration-fast)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <Minimize2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 max-w-[45%] truncate text-subtle text-[var(--font-micro-size)]"
          data-testid="assistant-context"
          title={projectName ?? '未进入项目'}
        >
          {stageLabel ?? projectName ?? '未进入项目'}
        </span>
        <span className="ml-auto shrink-0 font-mono text-subtle text-[var(--font-micro-size)]" data-testid="assistant-message-count">
          {session.messages.length} 条
        </span>
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
          <ErrorBar error={{ level: 'page', message: errorMessages[0] ?? '', retry: session.retryRecovery }} />
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
            onResumeCheckpoint={onResumeCheckpoint}
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
        running={activeRun}
        suspended={suspendedOnApproval}
        replyMode={replyMode}
        seed={composerSeed}
        onSeedConsumed={onComposerSeedConsumed}
        onSend={async (input) => {
          // A suspended question takes the text as its answer; everything else starts a new run.
          const sent =
            pendingQuestion !== null
              ? await session.resumeQuestion(pendingQuestion.interruptId, input.text)
              : await session.send({
                  text: input.text,
                  mode,
                  skillIds: input.explicitSkillIds,
                  attachments: input.attachments
                });
          if (sent) {
            clearAssistantComposerDraft(projectId, threadId);
            clearAssistantComposerDraft(projectId, currentThreadIdRef.current);
          }
          return sent;
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
