import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Eye, EyeOff, FlaskConical, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import type { ProviderConfig, ProviderModel, ProviderSecretStatus, ProviderTestResult } from '../../../shared/types';
import { isFixedProvider, isFixedProviderType } from '../../../shared/provider-defaults';
import { Button, Checkbox, ConfirmDialog, Drawer, IconButton, Switch, TextArea, TextInput } from '../../components/ui';
import {
  providerTypeMeta,
  type CreatableProviderType,
  type EditableProviderType,
  type ProviderDraft,
  updateProviderModelCard
} from '../../settings-model';
import { ProviderModelOptionsFields } from './provider-model-options-fields';

function emptyModel(): ProviderModel {
  return { id: '', displayName: '', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false };
}

function providerHasReadyModel(provider: ProviderConfig): boolean {
  return provider.enabled && provider.models.some((model) => model.enabled);
}

function findSecret(statuses: readonly ProviderSecretStatus[], providerId: string): ProviderSecretStatus | null {
  return statuses.find((entry) => entry.providerId === providerId) ?? null;
}

type TestFeedback = { tone: 'ready' | 'invalid'; text: string };

function formatTestFeedback(status: ProviderTestResult | null): TestFeedback | null {
  if (status === null) return null;
  const latency = typeof status.latencyMs === 'number' && status.latencyMs >= 0
    ? `（耗时 ${status.latencyMs} ms）`
    : '';
  if (status.status === 'ready') {
    const subject = status.modelId === null || status.modelId === undefined
      ? '测试可用。'
      : `已测试 ${status.modelId} 可用。`;
    return { tone: 'ready', text: `${subject}${latency}` };
  }
  const subject = status.modelId === null || status.modelId === undefined
    ? '测试失败'
    : `${status.modelId} 测试失败`;
  return { tone: 'invalid', text: `${subject}${status.error === null ? '。' : `：${status.error}`}${latency}` };
}

function getModelTestFeedback(status: ProviderTestResult | null, providerId: string | null, modelId: string): TestFeedback | null {
  if (status === null || providerId === null || status.providerId !== providerId || status.modelId !== modelId) return null;
  return formatTestFeedback(status);
}

function TestFeedbackView({ feedback, testId }: { feedback: TestFeedback; testId: string }): React.JSX.Element {
  return <span className={`provider-model-test-feedback provider-model-test-feedback--${feedback.tone}`} data-testid={testId}>{feedback.text}</span>;
}

function ProviderAvatar({ provider }: { provider: ProviderConfig }): React.JSX.Element {
  return <span className="provider-avatar">{provider.name.trim().charAt(0).toUpperCase() || '?'}</span>;
}

function ProviderList({ onEditProvider, providers, selectedProviderId }: {
  onEditProvider: (provider: ProviderConfig) => void;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
}): React.JSX.Element {
  return (
    <aside className="provider-list" data-testid="provider-list">
      {providers.length === 0 ? <div className="provider-list-empty">没有匹配的提供商</div> : providers.map((provider) => {
        const ready = providerHasReadyModel(provider);
        return (
          <button
            className={selectedProviderId === provider.id ? 'provider-list-item active' : 'provider-list-item'}
            data-testid={`provider-list-item-${provider.id}`}
            key={provider.id}
            onClick={() => onEditProvider(provider)}
            type="button"
          >
            <ProviderAvatar provider={provider} />
            <span className="provider-list-copy">
              <strong>{provider.name}</strong>
              <small>{provider.models.filter((model) => model.enabled).length} 个启用模型</small>
            </span>
            <span className={`status-pill ${ready ? 'ok' : 'info'}`}>{ready ? '已就绪' : '未启用'}</span>
          </button>
        );
      })}
    </aside>
  );
}

function ModelRow({ index, model, onDelete, onOpen, onTest, selected, testFeedback }: {
  index: number;
  model: ProviderModel;
  onDelete: () => void;
  onOpen: () => void;
  onTest: (() => void) | null;
  selected: boolean;
  testFeedback: TestFeedback | null;
}): React.JSX.Element {
  const capabilities = [
    model.supportsStreaming ? '流式' : null,
    model.supportsToolCalls ? '工具' : null,
    model.supportsImages ? '图片' : null
  ].filter((value): value is string => value !== null);
  return (
    <article className={selected ? 'provider-model-row active' : 'provider-model-row'} data-testid={`provider-model-row-${index}`}>
      <button className="provider-model-row__select" data-testid={`provider-model-open-${index}`} onClick={onOpen} type="button">
        <span className={model.enabled ? 'provider-model-state enabled' : 'provider-model-state'} aria-hidden="true" />
        <span className="provider-model-row__copy">
          <strong>{model.displayName.trim() || model.id.trim() || `模型 ${index + 1}`}</strong>
          <code>{model.id.trim() || '未填写模型 ID'}</code>
          {testFeedback === null ? null : <TestFeedbackView feedback={testFeedback} testId={`provider-model-test-feedback-${index}`} />}
        </span>
        <span className="provider-model-row__capabilities">
          {capabilities.map((capability) => <span className="provider-model-capability" key={capability}>{capability}</span>)}
        </span>
      </button>
      <div className="provider-model-row__actions">
        {onTest === null ? null : <IconButton label="测试模型" onClick={onTest}><FlaskConical size={15} /></IconButton>}
        <IconButton label="编辑模型" onClick={onOpen}><Settings2 size={15} /></IconButton>
        <IconButton label="删除模型" onClick={onDelete} tone="danger"><Trash2 size={15} /></IconButton>
      </div>
    </article>
  );
}

export function ProvidersSection({
  draft, draftError, onClearProviderSecret, onDeleteProvider, onEditProvider, onSaveProviderDraft,
  onStartNewProvider, onTestProvider, onUpdateDraft, providers, providerSecretStatus,
  providerTestStatus, secretBusyProviderId
}: {
  draft: ProviderDraft;
  draftError: string | null;
  onClearProviderSecret: (providerId: string) => Promise<void>;
  onDeleteProvider: (providerId: string) => Promise<void>;
  onEditProvider: (provider: ProviderConfig) => void;
  onSaveProviderDraft: () => Promise<void>;
  onStartNewProvider: (type: CreatableProviderType) => void;
  onTestProvider: (providerId: string, modelId: string) => Promise<void>;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
  providers: ProviderConfig[];
  providerSecretStatus: ProviderSecretStatus[];
  providerTestStatus: ProviderTestResult | null;
  secretBusyProviderId: string | null;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [onlyEnabledModels, setOnlyEnabledModels] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState<number | null>(null);
  const [deleteModelIndex, setDeleteModelIndex] = useState<number | null>(null);
  const [deleteProviderId, setDeleteProviderId] = useState<string | null>(null);
  const providerTypeOptions: Array<{ type: CreatableProviderType; label: string }> = [
    { type: 'openai_compatible', label: 'OpenAI-compatible' },
    { type: 'anthropic_compatible', label: 'Anthropic-compatible' }
  ];
  const filteredProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query.length === 0 ? providers : providers.filter((provider) =>
      provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query));
  }, [providers, search]);
  const selectedProvider = useMemo(() => providers.find((provider) => provider.id === draft.id) ?? null, [providers, draft.id]);
  const selectedModel = selectedModelIndex === null ? null : draft.models[selectedModelIndex] ?? null;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return draft.models.map((model, index) => ({ model, index }))
      .filter(({ model }) => !onlyEnabledModels || model.enabled)
      .filter(({ model }) => query.length === 0 || model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query));
  }, [draft.models, modelSearch, onlyEnabledModels]);
  const fixedProviderSelected = selectedProvider !== null && isFixedProvider(selectedProvider.id);
  const fixedProviderDraft = isFixedProviderType(draft.type);
  const fixedBaseUrlProviderDraft = draft.type === 'openrouter';
  const fixedEndpoint = draft.type === 'nvidia';
  const meta = providerTypeMeta(draft.type);
  const isCreating = draft.mode === 'create';
  const [revealApiKey, setRevealApiKey] = useState(false);
  const stored = selectedProvider !== null && findSecret(providerSecretStatus, selectedProvider.id)?.stored === true;
  const busy = secretBusyProviderId !== null && secretBusyProviderId === selectedProvider?.id;

  useEffect(() => {
    setRevealApiKey(false);
    setSelectedModelIndex(null);
    setModelSearch('');
  }, [draft.id, draft.mode]);

  const runtimeStatus = selectedProvider === null ? null
    : providerTestStatus !== null && providerTestStatus.providerId === selectedProvider.id
      ? providerTestStatus.status
      : providerHasReadyModel(selectedProvider) ? 'ready' : 'invalid';
  const testFeedback = selectedProvider !== null && providerTestStatus?.providerId === selectedProvider.id
    ? formatTestFeedback(providerTestStatus)
    : null;

  function updateModel(index: number, model: ProviderModel): void {
    onUpdateDraft({ models: updateProviderModelCard(draft.models, index, model) });
  }

  function addModel(): void {
    const index = draft.models.length;
    onUpdateDraft({ models: [...draft.models, emptyModel()] });
    setSelectedModelIndex(index);
  }

  function deleteSelectedModel(): void {
    if (deleteModelIndex === null) return;
    const nextModels = draft.models.filter((_, index) => index !== deleteModelIndex);
    onUpdateDraft({ models: nextModels });
    setSelectedModelIndex(nextModels.length === 0 ? null : Math.min(deleteModelIndex, nextModels.length - 1));
    setDeleteModelIndex(null);
  }

  return (
    <section className="single-panel provider-settings-card" data-testid="provider-settings">
      <div className="provider-toolbar">
        <label className="provider-search-wrap">
          <Search size={16} aria-hidden="true" />
          <TextInput className="provider-search" data-testid="provider-search" onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜索提供商..." type="search" value={search} />
        </label>
        <Button data-testid="provider-add-openai" icon={<Plus size={16} />} onClick={() => onStartNewProvider('openai_compatible')} variant="primary">
          新增提供商
        </Button>
      </div>
      <div className="provider-split">
        <ProviderList onEditProvider={onEditProvider} providers={filteredProviders} selectedProviderId={selectedProvider?.id ?? null} />
        <div className="provider-detail" data-testid="provider-detail">
          <header className="provider-detail-header">
            <div className="provider-detail-title">
              <h3>{draft.name.trim().length === 0 ? (isCreating ? '新建提供商' : draft.id) : draft.name}</h3>
              <span className={runtimeStatus === 'ready' ? 'provider-status-pill active' : 'provider-status-pill inactive'} data-testid="provider-detail-status">
                {runtimeStatus === 'ready' ? '已就绪' : '未启用'}
              </span>
            </div>
            <Switch checked={draft.enabled} data-testid="provider-draft-enabled" label="启用提供商" onChange={(event) => onUpdateDraft({ enabled: event.currentTarget.checked })} />
          </header>
          {testFeedback === null ? null : <div className={`provider-test-feedback provider-test-feedback--${testFeedback.tone}`} data-testid="provider-test-feedback">{testFeedback.text}</div>}
          {isCreating ? (
            <div className="provider-type-section">
              <span className="provider-detail-label">提供商类型</span>
              <div className="provider-type-segmented" role="group" aria-label="提供商类型">
                {providerTypeOptions.map((option) => (
                  <button
                    aria-pressed={option.type === draft.type}
                    className={option.type === draft.type ? 'provider-type-option active' : 'provider-type-option'}
                    data-testid={`provider-draft-type-${option.type}`}
                    key={option.type}
                    onClick={() => onUpdateDraft({ type: option.type })}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {fixedProviderDraft ? null : (
            <label className="field">
              <span>名称</span>
              <TextInput data-testid="provider-draft-name" onChange={(event) => onUpdateDraft({ name: event.currentTarget.value })} placeholder="例如：我的 OpenAI" value={draft.name} />
            </label>
          )}
          <label className="field">
            <span>API Key</span>
            <div className="provider-secret-input">
              <TextInput
                autoComplete="off"
                data-testid="provider-draft-api-key"
                onChange={(event) => onUpdateDraft({ apiKey: event.currentTarget.value })}
                placeholder={stored ? '已有凭据，输入新值以替换' : '输入 API Key'}
                type={revealApiKey ? 'text' : 'password'}
                value={draft.apiKey}
              />
              <IconButton aria-pressed={revealApiKey} className="provider-secret-toggle" label={revealApiKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setRevealApiKey((current) => !current)}>
                {revealApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </IconButton>
            </div>
            {selectedProvider === null || !stored ? null : <Button disabled={busy} onClick={() => void onClearProviderSecret(selectedProvider.id)} size="compact">清除凭据</Button>}
          </label>
          {fixedBaseUrlProviderDraft ? null : (
            <label className="field">
              <span>{fixedEndpoint ? '固定端点' : 'Base URL'}</span>
              <TextInput
                data-testid="provider-draft-endpoint"
                onChange={(event) => onUpdateDraft({ endpoint: event.currentTarget.value })}
                placeholder={meta.defaultBaseUrl}
                readOnly={fixedEndpoint}
                value={draft.endpoint}
              />
              <span className="field-hint">
                {draft.type === 'nvidia' ? '留空使用 NVIDIA 官方 OpenAI-compatible 端点；自托管 NIM 可在高级参数中覆盖。' : `留空将回退到默认 ${meta.defaultBaseUrl}`}
              </span>
            </label>
          )}
          <section className="provider-model-editor" data-testid="provider-model-editor">
            <div className="provider-model-editor__heading">
              <div><strong>模型列表</strong><span>{filteredModels.length} / {draft.models.length} 个模型</span></div>
              <Button data-testid="provider-model-add" icon={<Plus size={15} />} onClick={addModel} size="compact">新增模型</Button>
            </div>
            <div className="provider-model-toolbar">
              <label className="provider-search-wrap">
                <Search size={15} aria-hidden="true" />
                <TextInput data-testid="provider-model-search" onChange={(event) => setModelSearch(event.currentTarget.value)} placeholder="搜索模型 ID 或名称..." type="search" value={modelSearch} />
              </label>
              <Checkbox checked={onlyEnabledModels} onChange={(event) => setOnlyEnabledModels(event.currentTarget.checked)}>仅显示已启用</Checkbox>
            </div>
            <ModelTable
              filteredModels={filteredModels}
              onDelete={setDeleteModelIndex}
              onOpen={setSelectedModelIndex}
              onTestProvider={onTestProvider}
              providerId={selectedProvider?.id ?? null}
              providerTestStatus={providerTestStatus}
              selectedModelIndex={selectedModelIndex}
              singleModel={draft.models.length === 1}
            />
          </section>
          <ProviderConnectionFields draft={draft} onUpdateDraft={onUpdateDraft} />
          <div className="provider-detail-actions">
            <Button data-testid="provider-save" onClick={() => void onSaveProviderDraft()} variant="primary">{fixedProviderDraft ? `保存 ${draft.name} 配置` : '保存 Provider'}</Button>
            {selectedProvider === null || fixedProviderSelected ? null : (
              <Button data-testid={`provider-delete-${selectedProvider.id}`} onClick={() => setDeleteProviderId(selectedProvider.id)} variant="danger">删除提供商</Button>
            )}
            {draftError === null ? null : <span className="pill warn" data-testid="provider-draft-status">{draftError}</span>}
          </div>
        </div>
      </div>
      <Drawer
        footer={selectedModel === null ? undefined : <><Button onClick={() => setDeleteModelIndex(selectedModelIndex)} variant="danger">删除模型</Button><Button onClick={() => setSelectedModelIndex(null)}>完成</Button></>}
        onClose={() => setSelectedModelIndex(null)}
        open={selectedModel !== null}
        subtitle={selectedModel?.id || '新模型'}
        title={selectedModel?.displayName || '编辑模型'}
        variant="modal"
      >
        {selectedModel === null || selectedModelIndex === null ? null : (
          <ModelDrawerFields
            index={selectedModelIndex}
            model={selectedModel}
            onChange={(model) => updateModel(selectedModelIndex, model)}
            providerType={draft.type}
            testFeedback={getModelTestFeedback(providerTestStatus, selectedProvider?.id ?? null, selectedModel.id)}
          />
        )}
      </Drawer>
      <ConfirmDialog
        confirmLabel="删除模型"
        description="删除后模型会从 Provider 草稿中移除，点击“保存 Provider”后才会持久化。"
        onCancel={() => setDeleteModelIndex(null)}
        onConfirm={deleteSelectedModel}
        open={deleteModelIndex !== null}
        title="删除这个模型？"
      />
      <ConfirmDialog
        confirmLabel="删除提供商"
        description="该 Provider 及其模型配置会被删除。若它包含默认模型，默认模型也会被清除。"
        onCancel={() => setDeleteProviderId(null)}
        onConfirm={() => {
          const providerId = deleteProviderId;
          setDeleteProviderId(null);
          if (providerId !== null) void onDeleteProvider(providerId);
        }}
        open={deleteProviderId !== null}
        title="删除这个提供商？"
      />
    </section>
  );
}

function ModelTable({ filteredModels, onDelete, onOpen, onTestProvider, providerId, providerTestStatus, selectedModelIndex, singleModel }: {
  filteredModels: Array<{ model: ProviderModel; index: number }>;
  onDelete: (index: number) => void;
  onOpen: (index: number) => void;
  onTestProvider: (providerId: string, modelId: string) => Promise<void>;
  providerId: string | null;
  providerTestStatus: ProviderTestResult | null;
  selectedModelIndex: number | null;
  singleModel: boolean;
}): React.JSX.Element {
  return (
    <div className={singleModel ? 'provider-model-table provider-model-table--single' : 'provider-model-table'} data-testid="provider-model-table">
      {filteredModels.length === 0 ? <div className="provider-list-empty">没有匹配的模型</div> : filteredModels.map(({ model, index }) => (
        <ModelRow
          index={index}
          key={`${index}:${model.id}`}
          model={model}
          onDelete={() => onDelete(index)}
          onOpen={() => onOpen(index)}
          onTest={providerId === null || model.id.trim().length === 0 ? null : () => void onTestProvider(providerId, model.id)}
          selected={selectedModelIndex === index}
          testFeedback={getModelTestFeedback(providerTestStatus, providerId, model.id)}
        />
      ))}
    </div>
  );
}

function ProviderConnectionFields({ draft, onUpdateDraft }: {
  draft: ProviderDraft;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
}): React.JSX.Element {
  return (
    <section className="provider-detail-connection-fields">
      <label className="field">
        <span>timeout_ms</span>
        <TextInput value={draft.timeoutMs} onChange={(event) => onUpdateDraft({ timeoutMs: event.currentTarget.value })} />
      </label>
      {draft.type === 'openai_compatible' ? (
        <label className="field">
          <span>organization</span>
          <TextInput value={draft.organization} onChange={(event) => onUpdateDraft({ organization: event.currentTarget.value })} />
        </label>
      ) : null}
      <label className="field field--full">
        <span>default_headers</span>
        <TextArea rows={3} value={draft.defaultHeaders} onChange={(event) => onUpdateDraft({ defaultHeaders: event.currentTarget.value })} />
      </label>
      {draft.type === 'nvidia' ? (
        <label className="field">
          <span>endpoint_override</span>
          <TextInput value={draft.endpointOverride} onChange={(event) => onUpdateDraft({ endpointOverride: event.currentTarget.value })} />
        </label>
      ) : null}
    </section>
  );
}

function ModelDrawerFields({ index, model, onChange, providerType, testFeedback }: {
  index: number;
  model: ProviderModel;
  onChange: (model: ProviderModel) => void;
  providerType: EditableProviderType;
  testFeedback: TestFeedback | null;
}): React.JSX.Element {
  return (
    <div className="provider-model-drawer-form">
      {testFeedback === null ? null : <TestFeedbackView feedback={testFeedback} testId="provider-model-drawer-test-feedback" />}
      <label className="field">
        <span>模型 ID</span>
        <TextInput data-testid={`provider-model-id-${index}`} onChange={(event) => onChange({ ...model, id: event.currentTarget.value })} value={model.id} />
      </label>
      <label className="field">
        <span>显示名</span>
        <TextInput data-testid={`provider-model-name-${index}`} onChange={(event) => onChange({ ...model, displayName: event.currentTarget.value })} value={model.displayName} />
      </label>
      <div className="provider-model-capabilities">
        <Checkbox checked={model.enabled} onChange={(event) => onChange({ ...model, enabled: event.currentTarget.checked })}>启用</Checkbox>
        <Checkbox checked={model.supportsStreaming} onChange={(event) => onChange({ ...model, supportsStreaming: event.currentTarget.checked })}>流式</Checkbox>
        <Checkbox checked={model.supportsToolCalls} onChange={(event) => onChange({ ...model, supportsToolCalls: event.currentTarget.checked })}>工具调用</Checkbox>
        <Checkbox checked={model.supportsImages} onChange={(event) => onChange({ ...model, supportsImages: event.currentTarget.checked })}>图片输入</Checkbox>
      </div>
      <details className="provider-model-advanced">
        <summary>高级参数</summary>
        <ProviderModelOptionsFields
          index={index}
          onChange={(options) => onChange({ ...model, options })}
          options={model.options}
          providerType={providerType}
        />
      </details>
    </div>
  );
}
