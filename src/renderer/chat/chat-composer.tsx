import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, Dispatch, DragEvent, FocusEvent, SetStateAction } from 'react';
import type { FileNameSearchMatch, McpServerSnapshot, SettingsSnapshot, SkillSnapshot } from '../../shared/types';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import { buildSettingsSaveRequest, buildSettingsStateUpdate, setDefaultModelInSettingsSaveRequest } from '../settings-model';
import type { RocClient } from '../shared/roc-client';
import { ComposerActionIcon } from '../chat-composer-icons';
import { applyComposerCompletion, detectComposerTrigger } from './composer-trigger';
import type { ComposerSuggestOption } from './ComposerSuggestPopover';
import { ComposerSuggestPopover, composerSuggestOptionDomId } from './ComposerSuggestPopover';
import type { RendererImageAttachment } from './image-attachments';
import { createFileImageAttachment, validateImageAttachmentSelection } from './image-attachments';

const suggestListboxId = 'chat-composer-suggest-listbox';
const fileSuggestLimit = 12;
const fileSuggestDebounceMs = 120;

type ComposerPopover = 'tools' | 'skills' | 'models' | null;
type ComposerMode = 'chat' | 'plan';

type ChatComposerProps = {
  client: RocClient;
  chatInput: string;
  onChatInputChange: (value: string) => void;
  selectedAttachments: RendererImageAttachment[];
  onSelectedAttachmentsChange: (attachments: RendererImageAttachment[]) => void;
  imageInputSupported: boolean;
  activeComposerPopover: ComposerPopover;
  onActiveComposerPopoverChange: Dispatch<SetStateAction<ComposerPopover>>;
  composerMode: ComposerMode;
  onComposerModeChange: (next: ComposerMode) => void;
  submitting: boolean;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  onSubmit: () => Promise<void>;
};

function toggleSelection(current: string[], id: string): string[] {
  if (current.includes(id)) {
    return current.filter((item) => item !== id);
  }
  return [...current, id];
}

function filterSkillSuggestions(skills: readonly SkillSnapshot[], query: string): ComposerSuggestOption[] {
  const normalizedQuery = query.toLowerCase();
  return skills
    .filter(
      (skill) =>
        normalizedQuery.length === 0 ||
        skill.id.toLowerCase().includes(normalizedQuery) ||
        skill.name.toLowerCase().includes(normalizedQuery)
    )
    .map((skill) => ({ id: skill.id, label: skill.name, description: skill.description }));
}

async function applyTurnSelection(
  updateLoadedState: (partial: Partial<LoadedState>) => void,
  enabledCapabilities: { mcpServers: string[]; skills: string[] }
): Promise<void> {
  updateLoadedState({
    selectedMcpServers: enabledCapabilities.mcpServers,
    selectedSkills: enabledCapabilities.skills,
    agentCapabilityPreview: null
  });
}

function PaperclipIcon(): React.JSX.Element {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 12.5l6.8-6.8a3.2 3.2 0 1 1 4.5 4.5l-9.2 9.2a5 5 0 1 1-7.1-7.1l8.9-8.9"></path>
    </svg>
  );
}

function SendIcon(): React.JSX.Element {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 11.5l15-7-4.8 15-2.7-5.1z"></path>
      <path d="M19 4.5L11.4 14.4"></path>
    </svg>
  );
}

function CapabilityPopover({
  actions,
  copy,
  countLabel,
  items,
  testId,
  title
}: {
  actions: React.ReactNode;
  copy: string;
  countLabel: string;
  items: React.ReactNode;
  testId: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="composer-popover" data-testid={testId}>
      <div className="composer-popover-head">
        <span>{title}</span>
        <strong>{countLabel}</strong>
      </div>
      <div className="composer-popover-copy">{copy}</div>
      <div className="composer-popover-actions">{actions}</div>
      <div className="composer-popover-list">{items}</div>
    </div>
  );
}

export function ChatComposer({
  client,
  chatInput,
  onChatInputChange,
  selectedAttachments,
  onSelectedAttachmentsChange,
  imageInputSupported,
  activeComposerPopover,
  onActiveComposerPopoverChange,
  composerMode,
  onComposerModeChange,
  submitting,
  state,
  updateLoadedState,
  onSubmit
}: ChatComposerProps): React.JSX.Element {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const fileSuggestRequestRef = useRef(0);
  const [caret, setCaret] = useState(0);
  const [fileSuggestMatches, setFileSuggestMatches] = useState<FileNameSearchMatch[]>([]);
  const [activeSuggestIndex, setActiveSuggestIndex] = useState(0);
  const [dismissedSuggestKey, setDismissedSuggestKey] = useState<string | null>(null);
  const visibleCapabilityServers = state.mcpServers.filter((server) => server.enabled);
  const visibleCapabilitySkills = state.skills.filter(
    (skill) => skill.enabled && skill.status === 'ready'
  );
  const enabledModels = state.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.id,
          key: buildProviderModelKey(provider.id, model.id),
          shortLabel: model.displayName,
          label: `${provider.name} / ${model.displayName}`
        }))
    );
  let composerModelLabel = '未配置';
  if (state.defaultModelId !== null) {
    const selectedModel = enabledModels.find((model) => model.key === state.defaultModelId);
    if (selectedModel !== undefined) {
      composerModelLabel = selectedModel.shortLabel;
    } else {
      const idSegments = state.defaultModelId.split(/[/:]/).filter((segment) => segment.length > 0);
      composerModelLabel = idSegments.length > 0 ? idSegments[idSegments.length - 1] : state.defaultModelId;
    }
  }

  const trimmedInput = chatInput.trim();
  const sendDisabled =
    submitting ||
    trimmedInput.length === 0 ||
    state.agent.execution !== 'ready' ||
    (selectedAttachments.length > 0 && !imageInputSupported);

  const suggestTrigger = detectComposerTrigger(chatInput, caret);
  const suggestKey = suggestTrigger === null ? null : `${suggestTrigger.kind}:${suggestTrigger.start}:${suggestTrigger.query}`;
  const fileSuggestQuery = suggestTrigger?.kind === 'file' && state.workspace !== null ? suggestTrigger.query : null;
  const fileSuggestTokenStart = suggestTrigger?.kind === 'file' && state.workspace !== null ? suggestTrigger.start : null;
  const suggestOptions: ComposerSuggestOption[] =
    suggestTrigger === null || suggestKey === dismissedSuggestKey
      ? []
      : suggestTrigger.kind === 'file'
        ? fileSuggestMatches.map((match) => ({
            id: match.relativePath,
            label: match.name,
            description: match.relativePath
          }))
        : filterSkillSuggestions(visibleCapabilitySkills, suggestTrigger.query);
  const boundedSuggestIndex = suggestOptions.length === 0 ? 0 : Math.min(activeSuggestIndex, suggestOptions.length - 1);
  const activeSuggestOption = suggestOptions[boundedSuggestIndex];

  useEffect(() => {
    // 换到另一个 @ token 就先清空旧结果，避免防抖窗口内把上一个 token 的候选插到新位置。
    setFileSuggestMatches([]);
  }, [fileSuggestTokenStart]);

  useEffect(() => {
    if (fileSuggestQuery === null) {
      setFileSuggestMatches([]);
      return;
    }
    const requestId = fileSuggestRequestRef.current + 1;
    fileSuggestRequestRef.current = requestId;
    const timer = setTimeout(() => {
      void client.api.files
        .searchByName({ query: fileSuggestQuery, maxResults: fileSuggestLimit })
        .then((result) => {
          if (requestId !== fileSuggestRequestRef.current) {
            return;
          }
          if (!result.ok || result.data === null) {
            setFileSuggestMatches([]);
            console.error('Composer file name search rejected.', result);
            return;
          }
          setFileSuggestMatches(result.data.matches);
        })
        .catch((error: unknown) => {
          if (requestId === fileSuggestRequestRef.current) {
            setFileSuggestMatches([]);
          }
          console.error('Composer file name search failed.', error);
        });
    }, fileSuggestDebounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [client, fileSuggestQuery]);

  useEffect(() => {
    setActiveSuggestIndex(0);
    // 离开被 Escape 抑制的那个 token 后清除抑制，否则改一次再改回同一个 token 时弹层不会再出现。
    setDismissedSuggestKey((current) => (current === suggestKey ? current : null));
  }, [suggestKey]);

  useEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === null) {
      return;
    }
    pendingCaretRef.current = null;
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(pendingCaret, pendingCaret);
  }, [chatInput]);

  useEffect(() => {
    if (suggestOptions.length === 0 || activeComposerPopover === null) {
      return;
    }
    onActiveComposerPopoverChange(null);
  }, [activeComposerPopover, onActiveComposerPopoverChange, suggestOptions.length]);

  function acceptSuggestion(option: ComposerSuggestOption): void {
    if (suggestTrigger === null) {
      return;
    }
    const replacement = suggestTrigger.kind === 'file' ? `@${option.id}` : `/${option.id}`;
    const completion = applyComposerCompletion(chatInput, suggestTrigger, replacement);
    pendingCaretRef.current = completion.caret;
    setCaret(completion.caret);
    setDismissedSuggestKey(null);
    setActiveSuggestIndex(0);
    onChatInputChange(completion.value);
  }

  function syncCaretFromEvent(target: HTMLTextAreaElement): void {
    const selectionStart = target.selectionStart;
    if (selectionStart === null) {
      return;
    }
    setCaret(selectionStart);
  }

  function refreshCapabilityOptions(): void {
    const currentSelectedMcpServers = state.selectedMcpServers;
    const currentSelectedSkills = state.selectedSkills;
    void Promise.all([client.api.mcp.listServers(), client.api.skills.list()])
      .then(([mcpResult, skillsResult]) => {
        const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', mcpResult);
        const skills = unwrap<SkillSnapshot[]>('skills', skillsResult);
        const availableMcpIds = new Set(mcpServers.filter((server) => server.enabled).map((server) => server.id));
        const availableSkillIds = new Set(
          skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id)
        );
        updateLoadedState({
          mcpServers,
          skills,
          selectedMcpServers: currentSelectedMcpServers.filter((id) => availableMcpIds.has(id)),
          selectedSkills: currentSelectedSkills.filter((id) => availableSkillIds.has(id)),
          agentCapabilityPreview: null
        });
      })
      .catch((error: unknown) => {
        console.error('Composer capability refresh failed.', error);
      });
  }

  function openComposerPopover(popover: Exclude<ComposerPopover, null>): void {
    if ((popover === 'tools' || popover === 'skills') && activeComposerPopover !== popover) {
      refreshCapabilityOptions();
    }
    if (activeComposerPopover !== popover) {
      onActiveComposerPopoverChange(popover);
    }
  }

  function closeComposerPopoverAfterFocusLeaves(
    event: FocusEvent<HTMLDivElement>,
    popover: Exclude<ComposerPopover, null>
  ): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    onActiveComposerPopoverChange((current) => (current === popover ? null : current));
  }

  async function selectAttachmentsFromDialog(): Promise<void> {
    try {
      const selection = await client.api.files.selectFromDialog();
      if (!selection.ok || selection.data === null) {
        return;
      }
      const nextAttachments = selection.data.filePaths.map(createPathImageAttachment);
      const combined = [...selectedAttachments, ...nextAttachments];
      validateImageAttachmentSelection(combined);
      setAttachmentError(null);
      onSelectedAttachmentsChange(combined);
    } catch (error) {
      setAttachmentError(imageAttachmentErrorCopy(error));
    }
  }

  async function addFileAttachments(files: FileList, source: 'clipboard' | 'drop'): Promise<void> {
    try {
      const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/') || hasSupportedImageExtension(file.name));
      if (imageFiles.length === 0) {
        return;
      }
      const nextAttachments = await Promise.all(imageFiles.map(async (file) => await createFileImageAttachment(file, source)));
      const combined = [...selectedAttachments, ...nextAttachments];
      validateImageAttachmentSelection(combined);
      setAttachmentError(null);
      onSelectedAttachmentsChange(combined);
    } catch (error) {
      setAttachmentError(imageAttachmentErrorCopy(error));
    }
  }

  function removeAttachment(target: RendererImageAttachment): void {
    if (target.previewUrl !== null) {
      URL.revokeObjectURL(target.previewUrl);
    }
    onSelectedAttachmentsChange(selectedAttachments.filter((attachment) => attachment !== target));
  }

  async function submitComposer(): Promise<void> {
    if (selectedAttachments.length > 0 && !imageInputSupported) {
      setAttachmentError(imageAttachmentErrorCopy(new Error('chat_model_images_unsupported')));
      return;
    }
    await onSubmit();
  }

  return (
    <div
      className="composer composer--chat"
      onDragOver={(event) => {
        if (event.dataTransfer.files.length === 0) {
          return;
        }
        event.preventDefault();
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        if (event.dataTransfer.files.length === 0) {
          return;
        }
        event.preventDefault();
        void addFileAttachments(event.dataTransfer.files, 'drop');
      }}
    >
      {selectedAttachments.length === 0 ? null : (
        <div className="chat-attachment-strip">
          {selectedAttachments.map((attachment) => (
            <span
              className="chat-attachment-pill"
              data-testid="chat-image-attachment"
              key={`${attachment.source}-${attachment.name}-${attachment.sizeBytes}`}
            >
              {attachment.previewUrl === null ? (
                <PaperclipIcon />
              ) : (
                <img alt="" className="chat-attachment-thumb" src={attachment.previewUrl} />
              )}
              <span>{attachment.name}</span>
              {attachment.path === undefined ? <small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small> : null}
              <button
                aria-label={`移除 ${attachment.name}`}
                className="chat-attachment-remove"
                data-testid="chat-image-remove"
                type="button"
                onClick={() => removeAttachment(attachment)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {attachmentError === null ? null : (
        <div className="chat-attachment-error" data-testid="chat-attachment-error">
          {attachmentError}
        </div>
      )}
      <div className="composer-suggest-anchor">
        {suggestOptions.length === 0 ? null : (
          <ComposerSuggestPopover
            activeIndex={boundedSuggestIndex}
            listboxId={suggestListboxId}
            options={suggestOptions}
            onActiveIndexChange={setActiveSuggestIndex}
            onSelect={acceptSuggestion}
          />
        )}
        <textarea
          aria-activedescendant={
            activeSuggestOption === undefined ? undefined : composerSuggestOptionDomId(suggestListboxId, activeSuggestOption.id)
          }
          aria-controls={suggestOptions.length === 0 ? undefined : suggestListboxId}
          aria-label="输入消息"
          className="composer-input"
          data-testid="chat-input"
          placeholder="输入消息..."
          ref={textareaRef}
          rows={3}
          value={chatInput}
          onChange={(event) => {
            syncCaretFromEvent(event.currentTarget);
            onChatInputChange(event.target.value);
          }}
          onClick={(event) => syncCaretFromEvent(event.currentTarget)}
          onKeyUp={(event) => syncCaretFromEvent(event.currentTarget)}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            if (event.clipboardData.files.length === 0) {
              return;
            }
            void addFileAttachments(event.clipboardData.files, 'clipboard');
          }}
          onKeyDown={(event) => {
            // 补全弹层可见时先吃掉导航键；关闭时下面的 Shift+Tab / Enter 行为完全不变。
            if (suggestOptions.length > 0 && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveSuggestIndex((boundedSuggestIndex + 1) % suggestOptions.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveSuggestIndex((boundedSuggestIndex - 1 + suggestOptions.length) % suggestOptions.length);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedSuggestKey(suggestKey);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && activeSuggestOption !== undefined) {
                event.preventDefault();
                acceptSuggestion(activeSuggestOption);
                return;
              }
            }
            if (event.key === 'Tab' && event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onComposerModeChange(composerMode === 'chat' ? 'plan' : 'chat');
              return;
            }
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
              return;
            }
            event.preventDefault();
            void submitComposer();
          }}
        />
      </div>
      <div className="composer-bottom">
        <div className="composer-left">
          <div className="composer-mode-toggle" data-testid="chat-composer-mode" aria-label="发送模式">
            {(['chat', 'plan'] as const).map((mode) => (
              <button
                className={composerMode === mode ? 'composer-mode-option is-selected' : 'composer-mode-option'}
                key={mode}
                type="button"
                onClick={() => onComposerModeChange(mode)}
              >
                {mode === 'chat' ? 'Chat' : 'Plan'}
              </button>
            ))}
          </div>
          <button
            className={selectedAttachments.length > 0 ? 'composer-tool active' : 'composer-tool'}
            data-testid="chat-attachment-trigger"
            type="button"
            aria-label="上传文件"
            onClick={() => void selectAttachmentsFromDialog()}
          >
            <ComposerActionIcon kind="attachment" />
            {selectedAttachments.length === 0 ? null : <span className="tool-badge">{selectedAttachments.length}</span>}
          </button>
          <div
            className="composer-popover-anchor"
            onMouseEnter={() => openComposerPopover('tools')}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'tools' ? null : current))}
            onBlur={(event) => closeComposerPopoverAfterFocusLeaves(event, 'tools')}
          >
            <button
              className={state.selectedMcpServers.length > 0 ? 'composer-tool composer-tool--tools active' : 'composer-tool composer-tool--tools'}
              data-testid="chat-tool-trigger"
              type="button"
              aria-label="工具"
              aria-expanded={activeComposerPopover === 'tools'}
              onClick={() => openComposerPopover('tools')}
              onFocus={() => openComposerPopover('tools')}
            >
              <ComposerActionIcon kind="tools" />
            </button>
            {activeComposerPopover !== 'tools' ? null : (
              <CapabilityPopover
                actions={
                  <>
                    <button
                      className="composer-choice composer-choice--action"
                      data-testid="chat-tool-select-all"
                      type="button"
                      onClick={() => void applyTurnSelection(updateLoadedState, {
                        mcpServers: visibleCapabilityServers.map((server) => server.id),
                        skills: state.selectedSkills
                      })}
                    >
                      全选
                    </button>
                    <button
                      className="composer-choice composer-choice--action"
                      data-testid="chat-tool-clear-all"
                      type="button"
                      onClick={() => void applyTurnSelection(updateLoadedState, {
                        mcpServers: [],
                        skills: state.selectedSkills
                      })}
                    >
                      取消全选
                    </button>
                  </>
                }
                copy="展示当前可用工具，并选择本轮要启用的项。"
                countLabel={`${visibleCapabilityServers.length} 个可用`}
                items={
                  <>
                    {visibleCapabilityServers.map((server) => (
                      <button
                        className={state.selectedMcpServers.includes(server.id) ? 'composer-choice active' : 'composer-choice'}
                        data-testid={`turn-mcp-${server.id}`}
                        key={server.id}
                        type="button"
                        onClick={() =>
                          void applyTurnSelection(updateLoadedState, {
                            mcpServers: toggleSelection(state.selectedMcpServers, server.id),
                            skills: state.selectedSkills
                          })
                        }
                      >
                        <span>{server.name}</span>
                        <small>{server.allowedTools?.join(', ') || 'ripgrep 搜索'}</small>
                      </button>
                    ))}
                  </>
                }
                testId="chat-tool-popover"
                title="工具"
              />
            )}
          </div>
          <div
            className="composer-popover-anchor"
            onMouseEnter={() => openComposerPopover('skills')}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'skills' ? null : current))}
            onBlur={(event) => closeComposerPopoverAfterFocusLeaves(event, 'skills')}
          >
            <button
              className={state.selectedSkills.length > 0 ? 'composer-tool composer-tool--skills active' : 'composer-tool composer-tool--skills'}
              data-testid="chat-skill-trigger"
              type="button"
              aria-label="技能"
              aria-expanded={activeComposerPopover === 'skills'}
              onClick={() => openComposerPopover('skills')}
              onFocus={() => openComposerPopover('skills')}
            >
              <ComposerActionIcon kind="skills" />
            </button>
            {activeComposerPopover !== 'skills' ? null : (
              <CapabilityPopover
                actions={
                  <>
                    <button
                      className="composer-choice composer-choice--action"
                      data-testid="chat-skill-select-all"
                      type="button"
                      onClick={() => void applyTurnSelection(updateLoadedState, {
                        mcpServers: state.selectedMcpServers,
                        skills: visibleCapabilitySkills.map((skill) => skill.id)
                      })}
                    >
                      全选
                    </button>
                    <button
                      className="composer-choice composer-choice--action"
                      data-testid="chat-skill-clear-all"
                      type="button"
                      onClick={() => void applyTurnSelection(updateLoadedState, {
                        mcpServers: state.selectedMcpServers,
                        skills: []
                      })}
                    >
                      取消全选
                    </button>
                  </>
                }
                copy="展示当前可用技能，并选择本轮要启用的项。"
                countLabel={`${visibleCapabilitySkills.length} 个可用`}
                items={
                  <>
                    {visibleCapabilitySkills.map((skill) => (
                      <button
                        className={state.selectedSkills.includes(skill.id) ? 'composer-choice active' : 'composer-choice'}
                        data-testid={`turn-skill-${skill.id}`}
                        key={skill.id}
                        type="button"
                        onClick={() =>
                          void applyTurnSelection(updateLoadedState, {
                            mcpServers: state.selectedMcpServers,
                            skills: toggleSelection(state.selectedSkills, skill.id)
                          })
                        }
                      >
                        <span className="composer-choice-copy">
                          <span>{skill.name}</span>
                          <small className="composer-choice-description composer-choice-description--clamp-2">{skill.description}</small>
                        </span>
                      </button>
                    ))}
                  </>
                }
                testId="chat-skill-popover"
                title="技能"
              />
            )}
          </div>
          <div
            className="composer-popover-anchor"
            onMouseEnter={() => openComposerPopover('models')}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'models' ? null : current))}
            onBlur={(event) => closeComposerPopoverAfterFocusLeaves(event, 'models')}
          >
            <button
              className="model-pill model-pill--composer"
              data-testid="chat-model-trigger"
              type="button"
              aria-label="模型"
              aria-expanded={activeComposerPopover === 'models'}
              onClick={() => openComposerPopover('models')}
              onFocus={() => openComposerPopover('models')}
            >
              <ComposerActionIcon kind="model" />
              <span className="model-pill-copy">{composerModelLabel}</span>
              <span aria-hidden="true" className="model-pill-chevron">
                ▾
              </span>
            </button>
            {activeComposerPopover !== 'models' ? null : (
              <div className="composer-popover composer-popover--wide" data-testid="chat-model-popover">
                <div className="composer-popover-head">
                  <span>模型</span>
                  <strong>默认模型</strong>
                </div>
                <div className="composer-popover-list">
                  {enabledModels.map((model) => (
                    <button
                      className={state.defaultModelId === model.key ? 'composer-choice active' : 'composer-choice'}
                      key={model.key}
                      type="button"
                      onClick={() => {
                        void client.api.settings
                          .save(
                            setDefaultModelInSettingsSaveRequest(
                              buildSettingsSaveRequest({
                                settings: state.settings,
                                providers: state.providers,
                                defaultModelId: state.defaultModelId,
                                permissions: state.permissions
                              }),
                              model.key
                            )
                          )
                          .then(async (result) => {
                            updateLoadedState(
                              await buildSettingsStateUpdate(client, unwrap<SettingsSnapshot>('settings save', result))
                            );
                          });
                      }}
                    >
                      <span>{model.label}</span>
                      <small>{model.id}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="composer-right">
          <button
            className="send-button"
            data-testid="chat-task-submit"
            type="button"
            aria-label="发送"
            disabled={sendDisabled}
            onClick={() => void submitComposer()}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function createPathImageAttachment(path: string): RendererImageAttachment {
  return {
    kind: 'image',
    source: 'file',
    name: fileNameFromPath(path),
    mediaType: mediaTypeFromPath(path),
    sizeBytes: 1,
    path,
    previewUrl: null
  };
}

function fileNameFromPath(path: string): string {
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return path;
  }
  const name = segments[segments.length - 1];
  if (name === undefined) {
    return path;
  }
  return name;
}

function mediaTypeFromPath(path: string): RendererImageAttachment['mediaType'] {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerPath.endsWith('.webp')) {
    return 'image/webp';
  }
  throw new Error('chat_image_unsupported_type');
}

function hasSupportedImageExtension(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.webp');
}

function imageAttachmentErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'chat_image_too_many') {
    return '每条消息最多添加 4 张图片。';
  }
  if (message === 'chat_image_too_large') {
    return '单张图片不能超过 5 MB。';
  }
  if (message === 'chat_image_unsupported_type') {
    return '仅支持 PNG、JPG、JPEG、WEBP 图片。';
  }
  if (message === 'chat_model_images_unsupported') {
    return '当前默认模型不支持图片输入。';
  }
  return '图片添加失败。';
}
