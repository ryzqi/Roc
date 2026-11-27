import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useImeGuard } from '../shared/hooks/use-ime-guard';
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Square, X } from 'lucide-react';
import { errorMessage } from '../app/loaded-state';
import type { ChatImageAttachment, ChatRunMode } from '../../shared/types';
import type { AssistantComposerDraft, AssistantComposerDraftUpdater } from './composer-draft';
import {
  applyComposerCompletion,
  detectComposerTrigger
} from './composer-trigger';
import {
  createFileImageAttachment,
  validateImageAttachmentSelection,
  type RendererImageAttachment
} from './image-attachments';
import { parseSlashSkillCommand } from './slash-skill-command';
import { ModelPicker } from './model-picker';
import type {RunInputKind} from './session-store';
import { ActionButton } from '../shared/form-ui';
import { ActionStatus } from '../shared/action-status';
import { useEffectiveReducedMotion } from '../shared/motion-preference';

/**
 * Composer (T4.5). Written fresh for the new shell (D3: the input area is redone, only the
 * rich *rendering* is reused), but the three pieces of real logic it needs are the ported
 * ones rather than re-inventions:
 *
 *   - `detectComposerTrigger` / `applyComposerCompletion` for the `/skill` completion,
 *     including the whitespace-aware caret arithmetic that is easy to get subtly wrong (the
 *     trigger also detects `@file`, which is **not** wired yet — no file suggestion list is
 *     rendered);
 *   - `parseSlashSkillCommand`, which both **consumes** the `/skill` tokens from the text
 *     and yields `explicitSkillIds` — and deliberately falls back to plain text for
 *     something like `/usr/bin/env`, so a message can never be swallowed by command
 *     parsing;
 *   - `createFileImageAttachment` for pasted/dropped images (base64 `data` payloads, no
 *     object URLs, `previewUrl` is a `data:` URL).
 *
 * Keys follow the legacy shell exactly (Enter sends, Shift+Enter newlines, ⌘Enter sends)
 * because that habit is the one thing users bring with them.
 *
 * ## The two toggles that would fit here are not here
 *
 * 联网搜索 and 深度思考 switches are not portable: `chatStartRunRequestSchema` has no
 * thinking or web-search field — the run
 * request carries `input` / `mode` / `threadId` / `workflowHint` / `researchProjectId` /
 * `attachments` / `explicitSkillIds` and nothing else. Main resolves workspace and execution
 * authority from trusted context, so the renderer has no control for those fields. A switch
 * that never reaches the backend is a control that lies, so the row carries
 * the one run-shape choice the contract does have (`mode`: 对话 / 任务) instead, and
 * capability stays where it is actually enforced — `enabledCapabilities` on the request and
 * the run's own manifest (with the approval cards as the surface that shows it).
 *
 * 联网搜索 in particular is not a switch in this build at all: a run either has the web
 * tools per its manifest or it does not.
 *
 * 正文独占一行，模式与发送操作放在下一行，默认模型另占一行。
 * 窄列优先截断模型名，保留输入和发送操作的完整空间。
 */

export type ComposerSkill = { id: string; name: string };

/**
 * 输入区可以选择的默认模型（P10，从助手头部挪下来）。
 *
 * 只带选择器要显示的东西：键（`provider:model`）、显示名、provider 分组名、是否启用。
 * 数据来自 `settings.get` 的快照，写入走 `settings.setDefaultModel` 这条只改一个字段的窄通道
 * ——不再像旧头部那样只是「去设置中心」的跳转。
 */
export type ComposerModel = {
  key: string;
  label: string;
  providerId: string;
  providerLabel: string;
  enabled: boolean;
};

export type AssistantComposerProps = {
  mode: ChatRunMode;
  onModeChange: (mode: ChatRunMode) => void;
  /**
   * 默认模型选择器。
   *
   * 读设置期间也照样渲染（选项为空、标签是「读取模型…」）：占位符换成不可点的一行可会让
   * 「读取中」看起来像「没配置」，而读取失败时用户真正要做的事（去设置页检查 provider）
   * 需要一个能点开的入口。
   */
  model: {
    label: string;
    currentKey: string | null;
    choices: ComposerModel[];
    pending: boolean;
    error: string | null;
    onSelect: (key: string) => void;
    onOpenSettings: () => void;
  };
  skills: ComposerSkill[];
  draft: AssistantComposerDraft;
  onDraftChange: (update: AssistantComposerDraftUpdater) => void;
  /** False when the current default model cannot take images (or no model is configured). */
  imageInputSupported: boolean;
  sending: boolean;
  stopping?: boolean;
  running: boolean;
  /**
   * The run is suspended on an **approval** interrupt: the decision belongs to the card, so the
   * input is locked and neither 发送 nor 停止 is offered. (A question suspend is different — it
   * sets `replyMode` instead, because the typed text *is* the answer.)
   */
  suspended?: boolean;
  /**
   * The run is suspended on a **question** interrupt, so this text is an answer rather than a
   * new prompt: the input stays enabled and the submit button says 回复. (An approval interrupt
   * leaves the input disabled — that decision belongs to the card.)
   */
  replyMode: boolean;
  onSend: (input: {
    text: string;
    attachments: ChatImageAttachment[];
    /** From `/skill` tokens, which are consumed out of `text` by the parser. */
    explicitSkillIds: string[];
    /** Bound at submit time; never turn a late correction into a new run. */
    runInputKind?: RunInputKind;
  }) => Promise<boolean>;
  onStop: () => void;
  /**
   * Text handed in from another surface (P9's 「用助手整理记忆」).
   *
   * Keyed by `nonce`, not by content: the same prompt twice must still replace whatever the user
   * typed, and a re-render with the same nonce must not. The hand-off only fills the input — it
   * never sends, because the user decides whether to ask.
   */
  seed?: { text: string; nonce: number } | null;
  /**
   * Called once the seed has been written into the input.
   *
   * The owner drops it, so closing and reopening the assistant (the shell remounts the composer
   * when the panel becomes visible) cannot replay a prompt the user already sent.
   */
  onSeedConsumed?: (() => void) | undefined;
};

/**
 * 输入区只保留两种运行形状（P10）。
 *
 * 计划模式从界面上删掉了：它的产物（一份计划）在助手列里没有对应的呈现与继续执行入口，
 * 选了它等于把一轮运行推进一个界面兑现不了的状态。`chat` 与 `task` 的差别是可见的
 * ——任务模式的运行会进任务看板，所以这两项留下。共享契约里的 `'plan'` 成员仍被主进程的
 * 运行快照使用（历史数据、`runExecutionModeSchema`），这里只是不再提供入口。
 */
const MODES: Array<{ id: ChatRunMode; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'task', label: '任务' }
];
const RUN_INPUT_KINDS: Array<{id: RunInputKind; label: string}> = [
  {id: 'steer', label: '纠正当前任务'},
  {id: 'follow_up', label: '完成后追加'}
];
type SubmissionIntent = 'send' | 'reply' | RunInputKind;
const SUBMISSION_PENDING_LABELS: Record<SubmissionIntent, string> = {
  send: '正在发送…',
  reply: '正在提交回复…',
  steer: '正在提交纠正…',
  follow_up: '正在提交追加…'
};

function attachmentErrorMessage(caught: unknown): string {
  const message = errorMessage(caught);
  switch (message) {
    case 'chat_image_too_many': return '最多添加 4 张图片。';
    case 'chat_image_too_large': return '每张图片不能超过 5 MB。';
    case 'chat_image_unsupported_type': return '支持 PNG、JPEG 和 WebP 图片。';
    case 'assistant_composer_draft_capacity': return '草稿容量已满，本次输入未添加。已有内容已保留，请先发送或清空其他会话的草稿。';
    default: return message;
  }
}

export function AssistantComposer({
  mode,
  onModeChange,
  model,
  skills,
  draft,
  onDraftChange,
  imageInputSupported,
  sending,
  stopping = false,
  running,
  suspended = false,
  replyMode,
  onSend,
  onStop,
  seed = null,
  onSeedConsumed
}: AssistantComposerProps): React.JSX.Element {
  // Approval decisions stay on their cards. Running turns accept plain text via their input queue.
  const inputLocked = stopping || (suspended && !replyMode);
  const canAttach = imageInputSupported && !replyMode && !running;
  const { text, attachments } = draft;
  const [caret, setCaret] = useState(0);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedIntent, setSubmittedIntent] = useState<SubmissionIntent | null>(null);
  const [runInputKind, setRunInputKind] = useState<RunInputKind>('steer');
  const scopeRef = useRef({ onDraftChange, active: true, reading: false, submitting: false });
  if (scopeRef.current.onDraftChange !== onDraftChange) {
    scopeRef.current = { onDraftChange, active: true, reading: false, submitting: false };
  }
  const scope = scopeRef.current;
  const sendPending = sending || submitting;
  const currentIntent: SubmissionIntent = replyMode ? 'reply' : running ? runInputKind : 'send';
  const pendingSendLabel = SUBMISSION_PENDING_LABELS[submittedIntent ?? currentIntent];
  const seedNonceRef = useRef<number | null>(null);
  const { onCompositionStart, onCompositionEnd, shouldIgnoreKeyDown } = useImeGuard();
  const attachmentsRef = useRef<HTMLDivElement | null>(null);
  const attachmentTransitionRef = useRef<ViewTransition | null>(null);
  const reducedMotion = useEffectiveReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const attachmentIds = useRef(new WeakMap<RendererImageAttachment, string>());
  const dragDepthRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const suggestionsRef = useRef<HTMLUListElement | null>(null);
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const trigger = useMemo(
    () => inputLocked || sendPending || replyMode || running ? null : detectComposerTrigger(text, caret),
    [caret, inputLocked, replyMode, running, sendPending, text]
  );
  const slashCommand = useMemo(
    () => parseSlashSkillCommand(text, replyMode ? [] : skills.map((skill) => skill.id)),
    [replyMode, skills, text]
  );

  useLayoutEffect(() => {
    if (reducedMotion) attachmentTransitionRef.current?.skipTransition();
  }, [reducedMotion]);

  useEffect(() => {
    scope.active = true;
    setReadingAttachments(false);
    setSubmitting(false);
    setSubmittedIntent(null);
    setAttachmentError(null);
    setRunInputKind('steer');
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    return () => {
      scope.active = false;
      attachmentTransitionRef.current?.skipTransition();
    };
  }, [scope]);

  // Keep the original action while either the local request or its owner is pending.
  useEffect(() => {
    if (!sendPending) setSubmittedIntent(null);
  }, [sendPending]);

  const updateText = useCallback((value: string): boolean => {
    try {
      onDraftChange((current) => ({ ...current, text: value }));
      setAttachmentError(null);
      return true;
    } catch (caught) {
      setAttachmentError(attachmentErrorMessage(caught));
      return false;
    }
  }, [onDraftChange]);

  // A hand-off from another surface replaces the draft once per nonce.
  useEffect(() => {
    if (seed === null || seedNonceRef.current === seed.nonce) {
      return;
    }
    if (!updateText(seed.text)) return;
    seedNonceRef.current = seed.nonce;
    setCaret(seed.text.length);
    const element = textareaRef.current;
    if (element !== null) {
      element.focus();
      element.setSelectionRange(seed.text.length, seed.text.length);
    }
    onSeedConsumed?.();
  }, [onSeedConsumed, seed, updateText]);

  const updateAttachments = useCallback(async (update: AssistantComposerDraftUpdater, restoreFocus = false): Promise<void> => {
    const isCurrent = () => scopeRef.current === scope && scope.active;
    const apply = () => {
      if (!isCurrent()) return;
      flushSync(() => onDraftChange(update));
      setAttachmentError(null);
      if (restoreFocus && document.activeElement === document.body) textareaRef.current?.focus();
    };
    const strip = attachmentsRef.current as (HTMLDivElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    }) | null;
    if (typeof strip?.startViewTransition !== 'function' || reducedMotionRef.current) {
      apply();
      return;
    }
    attachmentTransitionRef.current?.skipTransition();
    const transition = strip.startViewTransition(apply);
    attachmentTransitionRef.current = transition;
    // Chromium rejects ready when a second interaction interrupts the snapshot.
    void transition.ready.catch(() => {});
    const clear = () => {
      if (attachmentTransitionRef.current === transition) attachmentTransitionRef.current = null;
    };
    void transition.finished.then(clear, clear);
    await transition.updateCallbackDone;
  }, [onDraftChange, scope]);

  const applyCompletion = useCallback(
    (completion: string): void => {
      if (trigger === null) {
        return;
      }
      const next = applyComposerCompletion(text, trigger, completion);
      if (!updateText(next.value)) return;
      setCaret(next.caret);
      setSuggestionsDismissed(false);
      const element = textareaRef.current;
      if (element !== null) {
        element.focus();
        element.setSelectionRange(next.caret, next.caret);
      }
    },
    [text, trigger, updateText]
  );

  const addFiles = useCallback(
    async (files: readonly File[], source: 'clipboard' | 'drop'): Promise<void> => {
      const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
      if (!isCurrent() || inputLocked || sending || scope.submitting || scope.reading) return;
      if (!canAttach) {
        setAttachmentError(running ? '运行中仅接受文本补充。' : replyMode ? '此问题仅接受文本回复。' : '当前模型不支持图片输入。');
        return;
      }
      const candidates = files.filter((file) => file.size > 0);
      if (candidates.length === 0) {
        return;
      }
      scope.reading = true;
      setReadingAttachments(true);
      try {
        validateImageAttachmentSelection([...attachments, ...candidates]);
        const created: RendererImageAttachment[] = [];
        for (const file of candidates) {
          created.push(await createFileImageAttachment(file, source));
          if (!isCurrent()) return;
        }
        await updateAttachments((current) => {
          const nextAttachments = [...current.attachments, ...created];
          validateImageAttachmentSelection(nextAttachments);
          return { ...current, attachments: nextAttachments };
        });
        setAttachmentError(null);
      } catch (caught) {
        if (isCurrent()) setAttachmentError(attachmentErrorMessage(caught));
      } finally {
        scope.reading = false;
        if (isCurrent()) setReadingAttachments(false);
      }
    },
    [attachments, canAttach, inputLocked, replyMode, running, scope, sending, updateAttachments]
  );

  const submit = useCallback(async (): Promise<void> => {
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    if (!isCurrent() || sending || inputLocked || scope.submitting || scope.reading) {
      return;
    }
    const parsed = slashCommand;
    if (running && (attachments.length > 0 || parsed.kind === 'ok')) {
      setAttachmentError('运行中仅接受文本补充。请移除图片和技能命令后重试。');
      return;
    }
    const payload = parsed.kind === 'ok' ? parsed.input : text;
    if (payload.trim().length === 0) {
      return;
    }
    if (!replyMode && attachments.length > 0 && !imageInputSupported) {
      setAttachmentError('请移除图片或切换到支持图片的模型。');
      return;
    }
    const submittedDraft = draft;
    scope.submitting = true;
    setSubmittedIntent(replyMode ? 'reply' : running ? runInputKind : 'send');
    setSubmitting(true);
    setAttachmentError(null);
    try {
      const ok = await onSend({
        text: payload,
        attachments: replyMode ? [] : attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
        explicitSkillIds: parsed.kind === 'ok' ? parsed.explicitSkillIds : [],
        ...(running ? {runInputKind} : {})
      });
      if (!isCurrent()) return;
      if (ok) {
        onDraftChange((current) => current === submittedDraft ? { text: '', attachments: [] } : current);
        setAttachmentError(null);
      }
    } catch (caught) {
      if (isCurrent()) setAttachmentError(errorMessage(caught));
    } finally {
      scope.submitting = false;
      if (isCurrent()) setSubmitting(false);
    }
  }, [attachments, draft, imageInputSupported, inputLocked, onDraftChange, onSend, replyMode, runInputKind, running, scope, sending, slashCommand, text]);

  const suggestionItems =
    suggestionsDismissed || trigger === null
      ? []
      : trigger.kind === 'skill'
        ? skills.filter((skill) => skill.id.toLowerCase().includes(trigger.query.toLowerCase()))
        : [];
  const selectedSuggestionIndex =
    suggestionItems.length === 0 ? 0 : Math.min(activeSuggestionIndex, suggestionItems.length - 1);
  const selectedSuggestionId = suggestionItems[selectedSuggestionIndex]?.id;

  useEffect(() => {
    setActiveSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [skills.length, trigger?.kind, trigger?.query]);

  useLayoutEffect(() => {
    const list = suggestionsRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    // Scroll only the suggestions, keeping the composer and transcript in place.
    const row = selected.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = bounds.bottom - list.clientTop;
    if (row.top < top) list.scrollTop += Math.floor(row.top - top);
    else if (row.bottom > bottom) list.scrollTop += Math.ceil(row.bottom - bottom);
  }, [selectedSuggestionId, selectedSuggestionIndex]);

  return (
    <div
      className="assistant-composer min-w-0 shrink-0 border-t-[0.5px] border-line-default"
      data-testid="assistant-composer"
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDraggingFiles(false);
        void addFiles([...event.dataTransfer.files], 'drop');
      }}
    >
      <div ref={attachmentsRef} className="assistant-attachment-strip">
        {attachments.length === 0 ? null : (
          <div className="mb-2 flex gap-1 overflow-x-auto p-1" data-testid="assistant-composer-attachments">
            {attachments.map((attachment) => {
              let id = attachmentIds.current.get(attachment);
              if (id === undefined) {
                id = 'assistant-attachment-' + crypto.randomUUID();
                attachmentIds.current.set(attachment, id);
              }
              return (
                <span key={id} style={{ viewTransitionName: id }}
                  className="assistant-attachment flex min-w-0 max-w-full shrink-0 items-center gap-1 rounded-card border-[0.5px] border-line bg-bg-soft p-1 text-muted text-[length:var(--font-meta-size)]">
                  {attachment.previewUrl === null ? (
                    <ImageIcon size={12} aria-hidden="true" className="shrink-0" />
                  ) : (
                    <img src={attachment.previewUrl} alt="" className="h-4 w-4 shrink-0 rounded-control object-cover" />
                  )}
                  <span className="max-w-36 truncate" title={attachment.name}>{attachment.name}</span>
                  <button
                    type="button"
                    disabled={inputLocked || sendPending || readingAttachments}
                    aria-label={`移除附件 ${attachment.name}`}
                    onClick={(event) =>
                      void updateAttachments((current) => ({
                        ...current,
                        attachments: current.attachments.filter((item) => item !== attachment)
                      }), document.activeElement === event.currentTarget)
                    }
                    className="flex size-7 shrink-0 items-center justify-center rounded-control text-subtle enabled:hover:bg-[var(--overlay-hover)] enabled:hover:text-ink enabled:active:bg-[var(--overlay-active)] disabled:opacity-40"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {readingAttachments ? (
        <ActionStatus state="pending" className="mb-1 text-muted text-[length:var(--font-micro-size)]">
          正在读取图片…
        </ActionStatus>
      ) : null}

      {attachmentError === null ? null : (
        <ActionStatus state="error" className="mb-1 text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
          {attachmentError}
        </ActionStatus>
      )}

      {sendPending ? (
        <ActionStatus state="pending" icon={null} testId="assistant-composer-send-status" className="sr-only">
          {pendingSendLabel}
        </ActionStatus>
      ) : null}
      {stopping ? (
        <ActionStatus state="pending" icon={null} testId="assistant-composer-stop-status" className="sr-only">
          正在停止…等待运行确认。
        </ActionStatus>
      ) : null}

      {suggestionItems.length === 0 ? null : (
        <ul
          ref={suggestionsRef}
          id="assistant-composer-suggestions"
          role="listbox"
          aria-label="可用技能"
          className="mb-2 flex max-h-[min(160px,20dvh)] flex-col overflow-y-auto overscroll-contain rounded-card border-[0.5px] border-line bg-surface py-1"
          data-testid="assistant-composer-suggestions"
        >
          {suggestionItems.map((skill, index) => (
            <li key={skill.id}>
              <button
                id={`assistant-skill-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                aria-selected={index === selectedSuggestionIndex}
                onClick={() => applyCompletion(`/${skill.id}`)}
                data-testid={`assistant-skill-suggestion-${skill.id}`}
                className={
                  index === selectedSuggestionIndex
                    ? 'flex w-full items-center gap-2 bg-[var(--overlay-hover)] px-2 py-1 text-left'
                    : 'flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                }
              >
                <span className="min-w-0 truncate font-mono text-[length:var(--font-meta-size)]" dir="ltr">/{skill.id}</span>
                <span className="min-w-0 flex-1 truncate text-muted text-[length:var(--font-micro-size)]">{skill.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <span id="assistant-composer-hint" className="sr-only">Enter 或 Command+Enter 发送，Shift+Enter 换行</span>
      <div
        className={[
          'flex min-w-0 flex-col gap-2 rounded-window border-[0.5px] bg-surface-raised p-2 transition-colors ui-motion-fast',
          'focus-within:border-[var(--composer-border-focus)] focus-within:ring-1 focus-within:ring-accent-soft',
          draggingFiles ? 'border-accent outline outline-2 outline-accent-soft-strong outline-offset-1' : 'border-line-default'
        ].join(' ')}
        data-dragging-files={draggingFiles ? 'true' : 'false'}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={inputLocked || sendPending}
            aria-label="给助手的指令"
            aria-describedby="assistant-composer-hint"
            aria-autocomplete="list"
            aria-controls={suggestionItems.length > 0 ? 'assistant-composer-suggestions' : undefined}
            aria-activedescendant={
              suggestionItems.length > 0 ? `assistant-skill-option-${selectedSuggestionIndex}` : undefined
            }
            placeholder={
              replyMode
                ? '输入回答'
                : inputLocked
                    ? ''
                    : running ? '输入补充指令' : '输入指令，或 / 选择技能'
            }
            data-testid="assistant-composer-input"
            onChange={(event) => {
              if (!updateText(event.target.value)) return;
              setCaret(event.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={(event) => {
              const nextCaret = event.currentTarget.selectionStart;
              if (nextCaret !== caret) {
                setCaret(nextCaret);
                setSuggestionsDismissed(false);
              }
            }}
            onBlur={() => setSuggestionsDismissed(true)}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={(event) => {
              onCompositionEnd();
              setCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (shouldIgnoreKeyDown(event)) return;
              if (suggestionItems.length > 0 && event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveSuggestionIndex((index) => (index + 1) % suggestionItems.length);
                return;
              }
              if (suggestionItems.length > 0 && event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveSuggestionIndex((index) => (index - 1 + suggestionItems.length) % suggestionItems.length);
                return;
              }
              if (suggestionItems.length > 0 && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setSuggestionsDismissed(true);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                if (suggestionItems.length > 0 && !event.metaKey && !event.ctrlKey) {
                  const selected = suggestionItems[selectedSuggestionIndex];
                  if (selected !== undefined) applyCompletion(`/${selected.id}`);
                } else {
                  void submit();
                }
              }
            }}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) {
                return;
              }
              event.preventDefault();
              void addFiles(files, 'clipboard');
            }}
            className="assistant-composer-input w-full min-w-0 resize-none bg-transparent p-1 text-ink text-[length:var(--font-body-size)] leading-relaxed placeholder:text-subtle disabled:opacity-60 focus-visible:outline-offset-[-2px]"
          />
          <div className="relative flex min-w-0 flex-wrap items-center justify-between gap-2" data-testid="assistant-composer-actions">
            <div
              role="radiogroup"
              aria-label={running ? '补充方式' : '运行模式'}
              className="flex shrink-0 items-center gap-1"
              data-testid="assistant-composer-mode"
              onKeyDown={(event) => {
                if (inputLocked || sendPending) return;
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const choices = running ? RUN_INPUT_KINDS : MODES;
                const currentIndex = choices.findIndex((item) => item.id === (running ? runInputKind : mode));
                const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                const nextIndex = (currentIndex + direction + choices.length) % choices.length;
                const nextMode = choices[nextIndex];
                if (nextMode === undefined) return;
                if (nextMode.id === 'steer' || nextMode.id === 'follow_up') setRunInputKind(nextMode.id);
                else onModeChange(nextMode.id);
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[nextIndex]?.focus();
              }}
            >
              {(running ? RUN_INPUT_KINDS : MODES).map((item) => {
                const selected = item.id === (running ? runInputKind : mode);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    disabled={inputLocked || sendPending}
                    onClick={() => {
                      if (item.id === 'steer' || item.id === 'follow_up') setRunInputKind(item.id);
                      else onModeChange(item.id);
                    }}
                    data-testid={`assistant-composer-mode-${item.id}`}
                    className={
                      selected
                        ? 'flex h-[var(--control-height-compact)] items-center rounded-chip bg-[var(--overlay-active)] px-2 text-ink active:bg-[var(--accent-soft-strong)]'
                        : 'flex h-[var(--control-height-compact)] items-center rounded-chip px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                    }
                  >
                    <span className="text-[length:var(--font-micro-size)]">{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {suspended && !stopping ? (
                  <span
                    className="flex h-[var(--control-height)] items-center rounded-control border-[0.5px] border-line px-3 text-muted text-[length:var(--font-meta-size)]"
                    data-testid="assistant-composer-suspended"
                  >
                    待审批
                  </span>
                ) : null}
              {running || stopping ? (
                  <button
                    type="button"
                    onClick={() => { if (!stopping) onStop(); }}
                    aria-disabled={stopping}
                    aria-busy={stopping}
                    data-testid="assistant-composer-stop"
                    className="flex h-[var(--control-height)] items-center gap-1 rounded-control border-[0.5px] border-line px-3 text-ink enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)] aria-disabled:opacity-60"
                  >
                    {stopping ? <Loader2 size={11} aria-hidden="true" className="motion-safe:animate-spin" /> : <Square size={11} aria-hidden="true" />}
                    {stopping ? '正在停止…' : '停止'}
                  </button>
                ) : null}
              {!inputLocked ? (
                <ActionButton
                  variant="primary"
                  onClick={() => void submit()}
                  disabled={readingAttachments || text.trim().length === 0}
                  loading={sendPending}
                  loadingLabel={pendingSendLabel}
                  data-testid="assistant-composer-send"
                >
                  <ArrowUp size={11} aria-hidden="true" />
                  {replyMode ? '回复' : running ? '提交' : '发送'}
                </ActionButton>
              ) : null}
            </div>
          </div>
          <div className="relative flex min-w-0 items-center gap-1 border-t-[0.5px] border-line-soft pt-1" data-testid="assistant-composer-options">
            <button
              type="button"
              aria-label="添加图片"
              title={running ? '运行中仅接受文本补充' : replyMode ? '此问题仅接受文本回复' : imageInputSupported ? '添加图片或粘贴图片' : '当前模型不支持图片输入'}
              data-testid="assistant-composer-attach"
              disabled={inputLocked || sendPending || readingAttachments || !canAttach}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/png,image/jpeg,image/webp';
                input.multiple = true;
                input.onchange = () => { void addFiles([...(input.files ?? [])], 'drop'); };
                input.click();
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted enabled:hover:bg-[var(--overlay-hover)] enabled:hover:text-ink enabled:active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              <Paperclip size={13} aria-hidden="true" />
            </button>
            <ModelPicker
              choices={model.choices} currentKey={model.currentKey} label={model.label}
              pending={model.pending} error={model.error} onOpenSettings={model.onOpenSettings} onSelect={model.onSelect}
            />
            {slashCommand.kind !== 'ok' ? null : (
              <span className="max-w-[40%] min-w-0 truncate text-subtle text-[length:var(--font-micro-size)]"
                data-testid="assistant-composer-skills" title={slashCommand.explicitSkillIds.map((id) => skillById.get(id)?.name ?? id).join('、')}>
                技能：{slashCommand.explicitSkillIds.map((id) => skillById.get(id)?.name ?? id).join('、')}
              </span>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
