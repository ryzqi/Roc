import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Square, X } from 'lucide-react';
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
 * request carries `input` / `mode` / `threadId` / `workflowHint` / `taskSource` /
 * `workspacePath` / `shellAllowedCommands` / `attachments` / `explicitSkillIds` and nothing
 * else. A switch that never reaches the backend is a control that lies, so the row carries
 * the one run-shape choice the contract does have (`mode`: 对话 / 任务) instead, and
 * capability stays where it is actually enforced — `enabledCapabilities` on the request and
 * the run's own manifest (with the approval cards as the surface that shows it).
 *
 * 联网搜索 in particular is not a switch in this build at all: a run either has the web
 * tools per its manifest or it does not.
 *
 * ## 底部一行（P10）
 *
 * 旧的底部条是三选一模式 + 「N 个技能可用」；模型切换在助手头部，是一个只能跳设置页的只读
 * 按钮。现在两者合并到输入框下方的同一行：运行形状、分隔线、默认模型选择器（浮层，见
 * `model-picker.tsx`）。高度统一取 `--control-height-compact`（28px），卡片的下边缘因此
 * 是一条齐平的线；选择器吃掉剩余宽度，所以窗口变窄时先被截断的是模型名，而不是按钮。
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

const MAX_TEXTAREA_HEIGHT = 200;

export function AssistantComposer({
  mode,
  onModeChange,
  model,
  skills,
  draft,
  onDraftChange,
  imageInputSupported,
  sending,
  running,
  suspended = false,
  replyMode,
  onSend,
  onStop,
  seed = null,
  onSeedConsumed
}: AssistantComposerProps): React.JSX.Element {
  // A suspended question is answerable even though a run exists; a plain running run is not,
  // and an approval suspend is not answerable at all (the card owns that decision).
  const inputLocked = (running || suspended) && !replyMode;
  const { text, attachments } = draft;
  const [caret, setCaret] = useState(0);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const seedNonceRef = useRef<number | null>(null);
  const compositionRef = useRef(false);
  const dragDepthRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const trigger = useMemo(() => (inputLocked ? null : detectComposerTrigger(text, caret)), [caret, inputLocked, text]);
  const slashCommand = useMemo(
    () => parseSlashSkillCommand(text, skills.map((skill) => skill.id)),
    [skills, text]
  );

  // A hand-off from another surface replaces the draft once per nonce.
  useEffect(() => {
    if (seed === null || seedNonceRef.current === seed.nonce) {
      return;
    }
    seedNonceRef.current = seed.nonce;
    onDraftChange((current) => ({ ...current, text: seed.text }));
    setCaret(seed.text.length);
    const element = textareaRef.current;
    if (element !== null) {
      element.focus();
      element.setSelectionRange(seed.text.length, seed.text.length);
    }
    onSeedConsumed?.();
  }, [onDraftChange, onSeedConsumed, seed]);

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  const applyCompletion = useCallback(
    (completion: string): void => {
      if (trigger === null) {
        return;
      }
      const next = applyComposerCompletion(text, trigger, completion);
      onDraftChange((current) => ({ ...current, text: next.value }));
      setCaret(next.caret);
      setSuggestionsDismissed(false);
      const element = textareaRef.current;
      if (element !== null) {
        element.focus();
        element.setSelectionRange(next.caret, next.caret);
      }
    },
    [onDraftChange, text, trigger]
  );

  const addFiles = useCallback(
    async (files: readonly File[], source: 'clipboard' | 'drop'): Promise<void> => {
      if (!imageInputSupported) {
        setAttachmentError('当前模型不支持图片输入，请在设置里选择支持图片的模型。');
        return;
      }
      const candidates = files.filter((file) => file.size > 0);
      if (candidates.length === 0) {
        return;
      }
      try {
        validateImageAttachmentSelection([...attachments, ...candidates]);
        const created: RendererImageAttachment[] = [];
        for (const file of candidates) {
          created.push(await createFileImageAttachment(file, source));
        }
        onDraftChange((current) => ({ ...current, attachments: [...current.attachments, ...created] }));
        setAttachmentError(null);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : '图片附件无法读取。');
      }
    },
    [attachments, imageInputSupported, onDraftChange]
  );

  const submit = useCallback(async (): Promise<void> => {
    if (sending || inputLocked) {
      return;
    }
    const parsed = parseSlashSkillCommand(text, skills.map((skill) => skill.id));
    const payload = parsed.kind === 'ok' ? parsed.input : text;
    if (payload.trim().length === 0 && attachments.length === 0) {
      return;
    }
    const ok = await onSend({
      text: payload,
      attachments: attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
      explicitSkillIds: parsed.kind === 'ok' ? parsed.explicitSkillIds : []
    });
    if (ok) {
      onDraftChange(() => ({ text: '', attachments: [] }));
      setCaret(0);
      setAttachmentError(null);
    }
  }, [attachments, inputLocked, onDraftChange, onSend, sending, skills, text]);

  const suggestionItems =
    suggestionsDismissed || trigger === null
      ? []
      : trigger.kind === 'skill'
        ? skills.filter((skill) => skill.id.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 6)
        : [];
  const selectedSuggestionIndex =
    suggestionItems.length === 0 ? 0 : Math.min(activeSuggestionIndex, suggestionItems.length - 1);

  useEffect(() => {
    setActiveSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [skills.length, trigger?.kind, trigger?.query]);

  return (
    <div
      className="shrink-0 border-t border-line p-3"
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
      {attachments.length === 0 ? null : (
        <div className="mb-1.5 flex flex-wrap gap-1" data-testid="assistant-composer-attachments">
          {attachments.map((attachment) => (
            <span
              key={`${attachment.name}-${attachment.sizeBytes}`}
              className="flex items-center gap-1 rounded-control border border-line bg-bg-soft px-1.5 py-0.5 text-muted text-[var(--font-micro-size)]"
            >
              {attachment.previewUrl === null ? (
                <ImageIcon size={11} aria-hidden="true" />
              ) : (
                <img src={attachment.previewUrl} alt="" className="h-4 w-4 rounded-[3px] object-cover" />
              )}
              <span className="max-w-[140px] truncate">{attachment.name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() =>
                  onDraftChange((current) => ({
                    ...current,
                    attachments: current.attachments.filter((item) => item !== attachment)
                  }))
                }
                className="flex h-4 w-4 items-center justify-center rounded-control text-subtle hover:text-ink"
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {attachmentError === null ? null : (
        <p role="alert" className="mb-1 text-[var(--st-bad)] text-[var(--font-micro-size)]">
          {attachmentError}
        </p>
      )}

      {suggestionItems.length === 0 ? null : (
        <ul
          id="assistant-composer-suggestions"
          role="listbox"
          aria-label="可用技能"
          className="mb-1.5 flex flex-col rounded-card border border-line bg-surface py-0.5"
          data-testid="assistant-composer-suggestions"
        >
          {suggestionItems.map((skill, index) => (
            <li key={skill.id}>
              <button
                id={`assistant-skill-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedSuggestionIndex}
                onClick={() => applyCompletion(`/${skill.id}`)}
                data-testid={`assistant-skill-suggestion-${skill.id}`}
                className={
                  index === activeSuggestionIndex
                    ? 'flex w-full items-center gap-2 bg-[var(--overlay-hover)] px-2 py-1 text-left'
                    : 'flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                }
              >
                <span className="font-mono text-[var(--font-meta-size)]">/{skill.id}</span>
                <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-micro-size)]">{skill.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* One card holds the field and its own bottom bar (`rounded-2xl p-3 shadow-md`
          plus a bordered control row inside). */}
      <div
        className={[
          'flex flex-col gap-2.5 rounded-window border bg-surface p-3 shadow-[var(--shadow-card)] transition-colors duration-[var(--duration-fast)]',
          'focus-within:border-line-strong',
          draggingFiles ? 'border-accent outline outline-2 outline-accent-soft-strong outline-offset-1' : 'border-line'
        ].join(' ')}
        data-dragging-files={draggingFiles ? 'true' : 'false'}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={2}
            value={text}
            disabled={inputLocked}
            role="combobox"
            aria-label="给助手的指令"
            aria-autocomplete="list"
            aria-multiline="true"
            aria-expanded={suggestionItems.length > 0}
            aria-controls={suggestionItems.length > 0 ? 'assistant-composer-suggestions' : undefined}
            aria-activedescendant={
              suggestionItems.length > 0 ? `assistant-skill-option-${selectedSuggestionIndex}` : undefined
            }
            placeholder={
              replyMode
                ? '输入回答后发送，运行会继续'
                : suspended
                  ? '运行已挂起，请先在上方卡片里决定'
                  : inputLocked
                    ? '运行中…可先停止再修改'
                    : '输入指令。Enter 发送 · Shift+Enter 换行 · / 选择技能'
            }
            data-testid="assistant-composer-input"
            onChange={(event) => {
              onDraftChange((current) => ({ ...current, text: event.target.value }));
              setCaret(event.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onCompositionStart={() => {
              compositionRef.current = true;
            }}
            onCompositionEnd={(event) => {
              compositionRef.current = false;
              setCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || compositionRef.current || event.nativeEvent.keyCode === 229) {
                return;
              }
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
                setSuggestionsDismissed(true);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (suggestionItems.length > 0) {
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
            className="min-h-[2.5rem] min-w-0 flex-1 resize-none bg-transparent py-1 text-ink text-[var(--font-body-size)] leading-relaxed placeholder:text-subtle disabled:opacity-60 focus-visible:outline-none"
          />
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="添加图片"
                title={imageInputSupported ? '添加图片（也可直接粘贴）' : '当前模型不支持图片输入'}
                data-testid="assistant-composer-attach"
                disabled={running || !imageInputSupported}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/png,image/jpeg,image/webp';
                  input.multiple = true;
                  input.onchange = () => {
                    void addFiles([...(input.files ?? [])], 'drop');
                  };
                  input.click();
                }}
                className="flex h-7 w-7 items-center justify-center rounded-control text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
              >
                <Paperclip size={13} aria-hidden="true" />
              </button>
            </div>
            {inputLocked ? (
              suspended ? (
                <span
                  className="flex h-[var(--control-height)] items-center rounded-control border border-line px-3 text-muted text-[var(--font-meta-size)]"
                  data-testid="assistant-composer-suspended"
                >
                  等待审批决定
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onStop}
                  data-testid="assistant-composer-stop"
                  className="flex h-[var(--control-height)] items-center gap-1 rounded-control border border-line px-3 text-[var(--st-warn)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                >
                  <Square size={11} aria-hidden="true" />
                  停止
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={sending || (text.trim().length === 0 && attachments.length === 0)}
                data-testid="assistant-composer-send"
                className="flex h-[var(--control-height)] items-center gap-1 rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 size={11} aria-hidden="true" className="animate-spin" />
                ) : (
                  <ArrowUp size={11} aria-hidden="true" />
                )}
                {replyMode ? '回复' : '发送'}
              </button>
            )}
          </div>
        </div>

        {/* 底部一行（P10）：运行形状（对话 / 任务）+ 默认模型选择器（浮层）+ `/skill` 摘要。

            旧版这里是「对话 / 任务 / 计划」三选一，而模型只是头部一个只读链接；现在
            模型切换就在输入框下方，选择器和模式条的控件高度一致（都是
            `--control-height-compact`），底线对齐后输入卡片的下缘看起来是一条完整的横线。 */}
        <div className="flex items-center gap-2 border-t border-line-soft pt-2">
          <div
            role="radiogroup"
            aria-label="运行模式"
            className="flex shrink-0 items-center gap-0.5"
            data-testid="assistant-composer-mode"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              const currentIndex = MODES.findIndex((item) => item.id === mode);
              const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
              const nextIndex = (currentIndex + direction + MODES.length) % MODES.length;
              const nextMode = MODES[nextIndex];
              if (nextMode === undefined) return;
              onModeChange(nextMode.id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[nextIndex]?.focus();
            }}
          >
            {MODES.map((item) => {
              const selected = item.id === mode;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={inputLocked}
                  onClick={() => onModeChange(item.id)}
                  data-testid={`assistant-composer-mode-${item.id}`}
                  className={
                    selected
                      ? 'flex h-[var(--control-height-compact)] items-center rounded-control bg-accent-soft px-2 text-ink active:bg-[var(--accent-soft-strong)]'
                      : 'flex h-[var(--control-height-compact)] items-center rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                  }
                >
                  <span className="text-[var(--font-micro-size)]">{item.label}</span>
                </button>
              );
            })}
          </div>
          <span className="h-4 w-px shrink-0 bg-line" aria-hidden="true" />
          <ModelPicker
            choices={model.choices}
            currentKey={model.currentKey}
            label={model.label}
            pending={model.pending}
            error={model.error}
            onOpenSettings={model.onOpenSettings}
            onSelect={model.onSelect}
          />
          {slashCommand.kind !== 'ok' ? null : (
            <span
              className="max-w-[40%] min-w-0 shrink-0 truncate text-subtle text-[var(--font-micro-size)]"
              data-testid="assistant-composer-skills"
              title={slashCommand.explicitSkillIds.map((id) => skillById.get(id)?.name ?? id).join('、')}
            >
              技能：{slashCommand.explicitSkillIds.map((id) => skillById.get(id)?.name ?? id).join('、')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
