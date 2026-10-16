import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Square, X } from 'lucide-react';
import type { ChatImageAttachment, ChatRunMode } from '../../shared/types';
import {
  applyComposerCompletion,
  detectComposerTrigger,
  type ComposerTrigger
} from './composer-trigger';
import {
  createFileImageAttachment,
  validateImageAttachmentSelection,
  type RendererImageAttachment
} from './image-attachments';
import { parseSlashSkillCommand } from './slash-skill-command';

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
 */

export type ComposerSkill = { id: string; name: string };

export type AssistantComposerProps = {
  mode: ChatRunMode;
  onModeChange: (mode: ChatRunMode) => void;
  skills: ComposerSkill[];
  attachments: RendererImageAttachment[];
  onAttachmentsChange: (items: RendererImageAttachment[]) => void;
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

const MODES: Array<{ id: ChatRunMode; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'task', label: '任务' },
  { id: 'plan', label: '计划' }
];

const MAX_TEXTAREA_HEIGHT = 200;

export function AssistantComposer({
  mode,
  onModeChange,
  skills,
  attachments,
  onAttachmentsChange,
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
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const seedNonceRef = useRef<number | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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
    setText(seed.text);
    const element = textareaRef.current;
    if (element !== null) {
      element.focus();
      element.setSelectionRange(seed.text.length, seed.text.length);
    }
    onSeedConsumed?.();
  }, [onSeedConsumed, seed]);

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
      setText(next.value);
      setCaret(next.caret);
      const element = textareaRef.current;
      if (element !== null) {
        element.focus();
        element.setSelectionRange(next.caret, next.caret);
      }
    },
    [text, trigger]
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
        onAttachmentsChange([...attachments, ...created]);
        setAttachmentError(null);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : '图片附件无法读取。');
      }
    },
    [attachments, imageInputSupported, onAttachmentsChange]
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
      setText('');
      setCaret(0);
      onAttachmentsChange([]);
      setAttachmentError(null);
    }
  }, [attachments, inputLocked, onAttachmentsChange, onSend, sending, skills, text]);

  const suggestionItems =
    trigger === null
      ? []
      : trigger.kind === 'skill'
        ? skills.filter((skill) => skill.id.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 6)
        : [];

  return (
    <div
      className="shrink-0 border-t border-line p-2.5"
      data-testid="assistant-composer"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
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
                onClick={() => onAttachmentsChange(attachments.filter((item) => item !== attachment))}
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
          className="mb-1.5 flex flex-col rounded-card border border-line bg-surface py-0.5"
          data-testid="assistant-composer-suggestions"
        >
          {suggestionItems.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                onClick={() => applyCompletion(`/${skill.id}`)}
                data-testid={`assistant-skill-suggestion-${skill.id}`}
                className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
              >
                <span className="font-mono text-[var(--font-meta-size)]">/{skill.id}</span>
                <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-micro-size)]">{skill.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 rounded-card border border-line bg-surface px-2.5 py-2">
        <textarea
          ref={textareaRef}
          rows={3}
          value={text}
          disabled={inputLocked}
          aria-label="给助手的指令"
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
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
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
          className="min-h-[3rem] min-w-0 flex-1 resize-none bg-transparent text-ink placeholder:text-subtle disabled:opacity-60"
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
              className="flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
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

      <div className="mt-1 flex items-center gap-2">
        <div
          role="radiogroup"
          aria-label="运行模式"
          className="flex items-center gap-0.5"
          data-testid="assistant-composer-mode"
        >
          {MODES.map((item) => {
            const selected = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={inputLocked}
                onClick={() => onModeChange(item.id)}
                data-testid={`assistant-composer-mode-${item.id}`}
                className={
                  selected
                    ? 'h-6 rounded-control bg-accent-soft px-2 text-ink active:bg-[var(--accent-soft-strong)]'
                    : 'h-6 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                }
              >
                <span className="text-[var(--font-micro-size)]">{item.label}</span>
              </button>
            );
          })}
        </div>
        {slashCommand.kind !== 'ok' ? null : (
          <span className="text-subtle text-[var(--font-micro-size)]" data-testid="assistant-composer-skills">
            技能：{slashCommand.explicitSkillIds.map((id) => skillById.get(id)?.name ?? id).join('、')}
          </span>
        )}
        <span className="ml-auto text-subtle text-[var(--font-micro-size)]">
          {skills.length === 0 ? '' : `${skills.length} 个技能可用`}
        </span>
      </div>
    </div>
  );
}
