import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import { useState } from 'react';
import type { ClipboardEvent, Dispatch, DragEvent, SetStateAction } from 'react';
import type { McpServerSnapshot, SettingsSnapshot, SkillSnapshot } from '../../shared/types';
import { buildSettingsSaveRequest, buildSettingsStateUpdate, setDefaultModelInSettingsSaveRequest } from '../settings-model';
import type { RocClient } from '../shared/roc-client';
import { ComposerActionIcon } from '../chat-composer-icons';
import type { RendererImageAttachment } from './image-attachments';
import { createFileImageAttachment, validateImageAttachmentSelection } from './image-attachments';

type ComposerPopover = 'tools' | 'skills' | 'models' | null;

type ChatComposerProps = {
  client: RocClient;
  chatInput: string;
  onChatInputChange: (value: string) => void;
  selectedAttachments: RendererImageAttachment[];
  onSelectedAttachmentsChange: (attachments: RendererImageAttachment[]) => void;
  imageInputSupported: boolean;
  activeComposerPopover: ComposerPopover;
  onActiveComposerPopoverChange: Dispatch<SetStateAction<ComposerPopover>>;
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
  submitting,
  state,
  updateLoadedState,
  onSubmit
}: ChatComposerProps): React.JSX.Element {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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
          shortLabel: model.displayName,
          label: `${provider.name} / ${model.displayName}`
        }))
    );
  let composerModelLabel = '未配置';
  if (state.defaultModelId !== null) {
    const selectedModel = enabledModels.find((model) => model.id === state.defaultModelId);
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
      <textarea
        aria-label="输入消息"
        className="composer-input"
        data-testid="chat-input"
        placeholder="输入消息..."
        rows={3}
        value={chatInput}
        onChange={(event) => onChatInputChange(event.target.value)}
        onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
          if (event.clipboardData.files.length === 0) {
            return;
          }
          void addFileAttachments(event.clipboardData.files, 'clipboard');
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          void submitComposer();
        }}
      />
      <div className="composer-bottom">
        <div className="composer-left">
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
            onMouseEnter={() => {
              refreshCapabilityOptions();
              onActiveComposerPopoverChange('tools');
            }}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'tools' ? null : current))}
          >
            <button
              className={state.selectedMcpServers.length > 0 ? 'composer-tool composer-tool--tools active' : 'composer-tool composer-tool--tools'}
              data-testid="chat-tool-trigger"
              type="button"
              aria-label="工具"
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
            onMouseEnter={() => {
              refreshCapabilityOptions();
              onActiveComposerPopoverChange('skills');
            }}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'skills' ? null : current))}
          >
            <button
              className={state.selectedSkills.length > 0 ? 'composer-tool composer-tool--skills active' : 'composer-tool composer-tool--skills'}
              data-testid="chat-skill-trigger"
              type="button"
              aria-label="技能"
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
            onMouseEnter={() => onActiveComposerPopoverChange('models')}
            onMouseLeave={() => onActiveComposerPopoverChange((current) => (current === 'models' ? null : current))}
          >
            <button className="model-pill model-pill--composer" data-testid="chat-model-trigger" type="button" aria-label="模型">
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
                      className={state.defaultModelId === model.id ? 'composer-choice active' : 'composer-choice'}
                      key={model.id}
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
                              model.id
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
